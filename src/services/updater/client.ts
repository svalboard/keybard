// One updater client per connection: the op helpers, and the client-ID rules.
//
// Rules (protocol contract 2.8, tech doc 2.2):
// - Every op is wrapped with the current client ID.
// - After any client-ID change, the next op is REBIND(nonce) while a session or a
//   held approval exists, so the board keeps the session (and the approval) ours.
// - A wrapper rejection is never retried silently: the client takes a new ID,
//   REBINDs, and only then sends the op again, once.

import {
    ARM_MODE_SINGLE, HAND_SELF, Op, Status, armArgs, chunkArgs, commitArgs, decodeArm, decodeFilled, decodeInfo0,
    decodeInfo1, decodeNextOffset, decodeRelay, decodeResetMask, decodeStateReply, decodeStatus, infoArgs,
    manifestArgs, manifestPieces, nonceArgs, settingsResetArgs, statusName, type ArmReply, type Info0, type Info1,
    type RelayReply, type StatusReply, type UpdaterReply,
} from "./protocol";
import { ClientRejectedError, type UpdaterTransport } from "./transport";

/** An op answered with a status the flow didn't expect. */
export class UpdaterStatusError extends Error {
    constructor(public readonly op: string, public readonly status: number, public readonly state?: number) {
        super(`${op}: ${statusName(status)}`);
        this.name = "UpdaterStatusError";
    }
}

export interface OpLogEntry {
    op: number;
    hand: number;
    status: number;
}

export class UpdaterClient {
    /** The session nonce REBIND carries, while a session or a held approval exists. */
    private rebindNonce: number | null = null;
    private rebindHand = HAND_SELF;
    private boundClient = 0;
    /** Every op sent, for tests and diagnostics (bounded). */
    readonly log: OpLogEntry[] = [];

    constructor(readonly transport: UpdaterTransport) {}

    /** Keep REBINDing to this nonce after client-ID changes (a session or a held approval). */
    track(nonce: number, hand: number): void {
        this.rebindNonce = nonce >>> 0;
        this.rebindHand = hand;
        this.boundClient = this.transport.clientId();
    }

    /** Nothing left on the board that is bound to us. */
    untrack(): void {
        this.rebindNonce = null;
    }

    get tracking(): number | null {
        return this.rebindNonce;
    }

    private record(op: number, hand: number, status: number) {
        this.log.push({ op, hand, status });
        if (this.log.length > 4000) this.log.splice(0, this.log.length - 4000);
    }

    private async rebind(): Promise<void> {
        if (this.rebindNonce === null) return;
        const reply = await this.transport.request(Op.REBIND, this.rebindHand, nonceArgs(this.rebindNonce));
        this.record(Op.REBIND, this.rebindHand, reply.status);
        this.boundClient = this.transport.clientId();
        if (reply.status !== Status.OK) throw new UpdaterStatusError("REBIND", reply.status, decodeStateReply(reply));
    }

    /** One op: REBIND first after a client-ID change; after a wrapper rejection, new ID, REBIND, then once more. */
    async op(op: number, hand: number, args: ArrayLike<number> = []): Promise<UpdaterReply> {
        const id = await this.transport.ensureClient();
        if (this.rebindNonce !== null && id !== this.boundClient && op !== Op.REBIND) await this.rebind();
        let reply: UpdaterReply;
        try {
            reply = await this.transport.request(op, hand, args);
        } catch (error) {
            if (!(error instanceof ClientRejectedError)) throw error;
            await this.transport.renewClient();
            if (this.rebindNonce !== null) await this.rebind();
            reply = await this.transport.request(op, hand, args);
        }
        this.record(op, hand, reply.status);
        return reply;
    }

    private async expect(name: string, reply: UpdaterReply, ...ok: number[]): Promise<UpdaterReply> {
        if (!ok.includes(reply.status)) throw new UpdaterStatusError(name, reply.status, reply.rsp[1]);
        return reply;
    }

    // ---- reads -----------------------------------------------------------------------------

    async info(hand = HAND_SELF): Promise<Info0> {
        return decodeInfo0(await this.op(Op.INFO, hand, infoArgs(0)));
    }

    async info1(): Promise<Info1> {
        return decodeInfo1(await this.op(Op.INFO, HAND_SELF, infoArgs(1)));
    }

    async status(hand: number): Promise<StatusReply> {
        return decodeStatus(await this.op(Op.STATUS, hand));
    }

    async relay(hand: number): Promise<RelayReply> {
        return decodeRelay(await this.op(Op.RELAY, hand));
    }

    // ---- a session ----------------------------------------------------------------------------

    /** MANIFEST (or PAIR_MANIFEST) in pieces; checks the board's fill count after each. */
    async loadManifest(hand: number, manifest: Uint8Array, pair = false, piece?: number): Promise<void> {
        const op = pair ? Op.PAIR_MANIFEST : Op.MANIFEST;
        for (const [off, bytes] of manifestPieces(manifest, piece)) {
            const reply = await this.expect(pair ? "PAIR_MANIFEST" : "MANIFEST", await this.op(op, hand, manifestArgs(off, bytes)), Status.OK);
            const filled = decodeFilled(reply);
            if (filled !== off + bytes.length) throw new UpdaterStatusError(`${pair ? "PAIR_MANIFEST" : "MANIFEST"} fill ${filled}`, Status.INVALID);
        }
    }

    async arm(hand: number, mode = ARM_MODE_SINGLE): Promise<ArmReply> {
        const reply = await this.op(Op.ARM, hand, armArgs(mode));
        if (reply.status !== Status.OK) {
            // A refused ARM latches ERROR (the red light) with no nonce to abort by: ABORT it
            // anyway (anyone may while ERROR is latched), so the board doesn't stay red.
            await this.abort(hand, 0).catch(() => undefined);
            throw new UpdaterStatusError("ARM", reply.status, reply.rsp[1]);
        }
        const arm = decodeArm(reply);
        this.track(arm.nonce, hand);
        return arm;
    }

    async begin(hand: number, nonce: number): Promise<number> {
        return decodeStateReply(await this.expect("BEGIN", await this.op(Op.BEGIN, hand, nonceArgs(nonce)), Status.ACCEPTED));
    }

    /** One CHUNK. Returns the status and the board's next offset (OUT_OF_ORDER: resync to it). */
    async chunk(hand: number, off: number, data: Uint8Array): Promise<{ status: number; next: number }> {
        const reply = await this.op(Op.CHUNK, hand, chunkArgs(off, data));
        return { status: reply.status, next: decodeNextOffset(reply) };
    }

    async end(hand: number, nonce: number): Promise<number> {
        return decodeStateReply(await this.expect("END", await this.op(Op.END, hand, nonceArgs(nonce)), Status.ACCEPTED));
    }

    async commit(hand: number, nonce: number, crc16: number): Promise<number> {
        return decodeStateReply(await this.expect("COMMIT", await this.op(Op.COMMIT, hand, commitArgs(nonce, crc16)), Status.ACCEPTED));
    }

    /** ABORT; with no nonce, a latched ERROR from an earlier session (anyone may clear it). */
    async abort(hand: number, nonce = 0): Promise<UpdaterReply> {
        const reply = await this.op(Op.ABORT, hand, nonceArgs(nonce));
        this.untrack();
        return reply;
    }

    /** SETTINGS_RESET (F-N2; mode 1, a blank board: D44): [status][done mask]. */
    async settingsReset(hand: number, scope?: number, mode?: number): Promise<{ status: number; done: number }> {
        const reply = await this.op(Op.SETTINGS_RESET, hand, settingsResetArgs(scope, mode));
        return { status: reply.status, done: decodeResetMask(reply) };
    }
}
