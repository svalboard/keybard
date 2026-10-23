// FakeSvalboard: two halves behind one USB connection, speaking updater protocol 4
// (the contract in the firmware-settings plan, section 2) in virtual time. The tests
// run the whole install flow against it; the harness can drive it from the UI.
//
// What it models: sessions bound to a client ID and a nonce, the 30 s chord window
// and session timeout, erase / receive / verify, the relay over the split cable and
// the other half's commit, the held pair approval (F-N3) with every clearing rule,
// no-chord developer builds (F-N1), SETTINGS_RESET (F-N2), D39 settings resets on a
// different image, restarts, presence, and injectable faults.

import {
    ARM_BY_PAIR, ARM_MODE_PAIR, ARM_MODE_SINGLE, ARM_NO_CHORD, ARM_PAIR, ARM_PRE_APPROVED, CHUNK_PIECE_MAX, HAND_SELF,
    INFO_FLAG_16MIB, INFO_FLAG_NO_CHORD, INFO_FLAG_OTHER_DIFFERS, INFO_FLAG_RELEASE, INFO_FLAG_WRITES_FAILING,
    MANIFEST_BYTES, MANIFEST_FLAG_DIAGNOSTIC, MANIFEST_PIECE_MAX, Op, Presence, RelayPhase, SETTINGS_RESET_MAGIC,
    STATE_NO_ANSWER, STATUS2_APPROVAL_HELD, STATUS2_PRE_APPROVED, STATUS_FLAG_BOUND, STATUS_FLAG_CHORD_MADE, State,
    Status, encodeArm, encodeInfo0, encodeInfo1, encodeRelay, encodeStatus, hex, le24, makeRsp, otherHand, u16, u24,
    u32, type Hand, type UpdaterReply,
} from "./protocol";
import { findBuildInfo, imageCrc, parseManifest, sha512, type SvupManifest } from "./svup";
import { ClientRejectedError, DisconnectedError, ReplyTimeoutError, type Clock, type UpdaterTransport } from "./transport";

export interface FakeHalfConfig {
    fwVersion: number;
    tag: string;
    /** Identity of the running image; a different one resets settings on boot (D39). */
    imageId?: string;
    protocol?: number;
    pointingId?: number;
    release?: boolean;
    /** F-N1 build (only the half with USB's matters). */
    noChord?: boolean;
    storageFormat?: number;
    securityEpoch?: number;
    maxImage?: number;
    flash16MiB?: boolean;
    writesFailing?: boolean;
    /** SETTINGS_RESET mode 1 (D44): false for a protocol 4 build from before it. */
    blankWipe?: boolean;
}

export type FaultPoint = "other-send" | "relay" | "subside" | "self-send" | "self-commit";

export type Fault =
    | { kind: "unplug"; at: FaultPoint }
    | { kind: "not-confirmed" }
    | { kind: "bad-hash"; hand?: Hand }
    | { kind: "other-client" }
    | { kind: "held-lapse" }
    | { kind: "other-silent" }
    | { kind: "relay-fail" }
    | { kind: "latched-error" }
    | { kind: "no-return" }
    /** The half with USB refuses its COMMIT when it comes to write (a DMA channel busy): ERROR, old firmware. */
    | { kind: "commit-refused" }
    /** The half with USB takes its COMMIT, but the reply never reaches the host. */
    | { kind: "commit-reply-lost" }
    /**
     * After the half with USB boots (and when the mock starts), its two INFO pages answer each other's request
     * (a late reply to a timed-out request, taken by the next one): twice, page 1 for page 0.
     */
    | { kind: "info-crossed" }
    | { kind: "other-no-return" }
    | { kind: "expire-client"; afterOps: number }
    | { kind: "renew-every"; ms: number };

export interface FakeTiming {
    eraseMsPerSector: number;
    verifyMs: number;
    relayEraseMs: number;
    relayBytesPerMs: number;
    relayVerifyMs: number;
    subsideHoldMs: number;
    commitDelayMs: number;
    /**
     * After the half with USB took COMMIT: how long its old firmware keeps running (and
     * answering) before it starts writing the image. The firmware's own delay is 100 ms.
     */
    usbCommitStartMs: number;
    /** Writing the image: the half with USB stays enumerated but answers nothing. */
    commitCopyMs: number;
    /** From the half with USB going away to its USB being back. */
    rebootMs: number;
    /** Enumerated after a boot, but INFO and the rest don't answer yet. */
    bootQuietMs: number;
    /** After the half with USB boots, the split link reports no other half (presence NONE) this long. */
    linkAfterBootMs: number;
    otherRebootMs: number;
    sessionTimeoutMs: number;
    chordWindowMs: number;
    heldWindowMs: number;
    resetDelayMs: number;
    clientRenewMs: number;
    clientTtlMs: number;
}

/**
 * Timing as measured on the mule (protocol 4, x4): the relay of a 120 KB image about 15 s,
 * the other half back about 5 s after its COMMIT, the half with USB back about 4 s after
 * it goes away, and presence MATCH about 6 s after that. slowTiming doubles every wait.
 */
export const DEFAULT_TIMING: FakeTiming = {
    eraseMsPerSector: 50,
    verifyMs: 485,
    relayEraseMs: 1600,
    relayBytesPerMs: 9,
    relayVerifyMs: 500,
    subsideHoldMs: 4500,
    commitDelayMs: 100,
    usbCommitStartMs: 100,
    commitCopyMs: 2000,
    rebootMs: 4000,
    bootQuietMs: 1500,
    linkAfterBootMs: 6000,
    otherRebootMs: 5000,
    sessionTimeoutMs: 30_000,
    chordWindowMs: 30_000,
    heldWindowMs: 120_000,
    resetDelayMs: 300,
    clientRenewMs: 50_000,
    clientTtlMs: 120_000,
};

/** The worst case: every wait of the mule's timing twice as long. */
export function slowTiming(base: FakeTiming = DEFAULT_TIMING): FakeTiming {
    const slow = { ...base };
    for (const k of ["verifyMs", "relayEraseMs", "relayVerifyMs", "commitCopyMs", "rebootMs", "bootQuietMs", "linkAfterBootMs", "otherRebootMs"] as const) slow[k] = base[k] * 2;
    slow.relayBytesPerMs = base.relayBytesPerMs / 2;
    return slow;
}

/** The board as it was before the mule's timing: quick restarts, no quiet time. Only for tests that need it. */
export const FAST_TIMING: Partial<FakeTiming> = { relayBytesPerMs: 11, commitCopyMs: 1500, rebootMs: 2500, bootQuietMs: 0, linkAfterBootMs: 0, otherRebootMs: 3000 };

export interface FakeBoardOptions {
    usbHand: Hand;
    left: FakeHalfConfig;
    right: FakeHalfConfig;
    clock: Clock;
    /** When the user makes the chord after the blue light starts; "never" for F4. */
    chordAfterMs?: number | "never";
    faults?: Fault[];
    timing?: Partial<FakeTiming>;
    boardName?: string;
}

interface Half {
    hand: Hand;
    cfg: Required<FakeHalfConfig>;
    alive: boolean;
    /** Back from a restart at this time. */
    backAt: number | null;
    /** The image this half last booted; a boot of another one resets settings (D39). */
    bootedImage: string;
    /** SETTINGS_RESET invalidated the D39 record: the next boot resets settings. */
    forceReset: boolean;
    /** ... to a blank board (D44): every key KC_NO after the reset. */
    forceBlank: boolean;
}

interface Session {
    hand: Hand;
    client: number;
    state: number;
    manifest: Uint8Array;
    filled: number;
    pair: Uint8Array | null;
    pairFilled: number;
    m: SvupManifest | null;
    nonce: number;
    armedAt: number;
    chordAt: number | null;
    preApproved: boolean;
    byPair: boolean;
    image: Uint8Array;
    staged: number;
    sectors: number;
    beginAt: number;
    endAt: number;
    lastOpAt: number;
    relayAt: number;
    relayedAt: number;
    subsideAt: number;
    commitAt: number;
    crc: number;
    verifyOk: boolean;
    /** The staged image's build info says no chord (F-N1). */
    noChordImage: boolean;
    /** The image's own build info says a dev build: no-chord 0x40 or kept settings 0x80 (D45). */
    devImage: boolean;
}

interface Held {
    manifest: Uint8Array;
    client: number;
    nonce: number;
    doneAt: number | null;
}

/** What the mock host stores as "the user's settings" on each half. */
export type FakeSettings = "user" | "defaults" | "restored" | "blank";

/** The identity the board gives an image: its manifest's SHA-512 prefix. */
export const imageIdOf = (manifestOrSvup: Uint8Array): string => hex(manifestOrSvup.subarray(44, 60));

const ACTIVE = new Set<number>([State.MANIFEST_LOADING, State.CONFIRM_WAIT, State.VERIFYING_MANIFEST, State.ERASING, State.RECEIVING, State.VERIFYING_IMAGE, State.VERIFIED, State.RELAYING, State.RELAYED]);

const fill = (c: FakeHalfConfig): Required<FakeHalfConfig> => ({
    imageId: `${c.tag}-${c.fwVersion}`,
    protocol: 4,
    pointingId: 5,
    release: false,
    noChord: false,
    storageFormat: 2,
    securityEpoch: 0,
    maxImage: 0x160000,
    flash16MiB: true,
    writesFailing: false,
    blankWipe: true,
    ...c,
});

export class FakeSvalboard implements UpdaterTransport {
    readonly timing: FakeTiming;
    readonly usbHand: Hand;
    readonly otherHandId: Hand;
    readonly halves: Record<Hand, Half>;
    private clock: Clock;
    private faults: Fault[];
    private chordAfterMs: number | "never";
    readonly boardName: string;

    private isConnected = true;
    /** When the half with USB last booted (its quiet time and the link wait start there). */
    private usbBootAt = Number.NEGATIVE_INFINITY;
    private crossed = 0;
    private session: Session | null = null;
    private latched: { error: number } | null = null;
    private lastError = 0;
    private held: Held | null = null;
    private relayDoneUnconfirmed = false;
    private pendingReset: { at: number; scope: number } | null = null;

    // client IDs
    private ourClient = 0;
    private clientIssuedAt = 0;
    private nextClient = 0x1000;
    private liveClients = new Map<number, number>();
    private renewedListeners = new Set<(id: number, old: number) => void>();
    private disconnectListeners = new Set<() => void>();
    private opCount = 0;

    /** Sval GET_INFO storage flags (bit 2: settings reset by a new build). */
    storageFlags = 0;
    settings: Record<Hand, FakeSettings>;
    /** Every request, for assertions. */
    readonly requests: Array<{ op: number; hand: number; at: number; status: number }> = [];
    /** Times the chord was asked for (blue blinking started). */
    chordRequests = 0;
    /** Times the user made the chord. */
    chordsMade = 0;
    /** Restarts of the half with USB. */
    usbReboots = 0;

    constructor(o: FakeBoardOptions) {
        this.clock = o.clock;
        this.timing = { ...DEFAULT_TIMING, ...o.timing };
        this.faults = o.faults ?? [];
        const renew = this.faults.find((f): f is Extract<Fault, { kind: "renew-every" }> => f.kind === "renew-every");
        if (renew) this.timing.clientRenewMs = renew.ms;
        this.chordAfterMs = o.chordAfterMs ?? 1500;
        this.usbHand = o.usbHand;
        this.otherHandId = otherHand(o.usbHand);
        this.boardName = o.boardName ?? "Kip";
        this.halves = {
            0: { hand: 0, cfg: fill(o.left), alive: true, backAt: null, bootedImage: "", forceReset: false, forceBlank: false },
            1: { hand: 1, cfg: fill(o.right), alive: true, backAt: null, bootedImage: "", forceReset: false, forceBlank: false },
        };
        for (const h of [this.halves[0], this.halves[1]]) h.bootedImage = h.cfg.imageId;
        this.settings = { 0: "user", 1: "user" };
        if (this.has("other-silent")) this.halves[this.otherHandId].alive = false;
        if (this.has("latched-error")) {
            this.latched = { error: Status.TIMEOUT };
            this.lastError = Status.TIMEOUT;
        }
        if (this.has("other-client")) {
            this.session = this.newSession(this.usbHand, 0x7777_0001);
            this.session.state = State.CONFIRM_WAIT;
            this.session.armedAt = this.clock.now();
            this.session.lastOpAt = Number.MAX_SAFE_INTEGER / 2;
        }
    }

    private has(kind: Fault["kind"]) {
        return this.faults.some((f) => f.kind === kind);
    }

    private fault<K extends Fault["kind"]>(kind: K): Extract<Fault, { kind: K }> | undefined {
        return this.faults.find((f) => f.kind === kind) as Extract<Fault, { kind: K }> | undefined;
    }

    private usb(): Half {
        return this.halves[this.usbHand];
    }

    private other(): Half {
        return this.halves[this.otherHandId];
    }

    // ---- transport ------------------------------------------------------------------------

    connected(): boolean {
        this.tick();
        return this.isConnected;
    }

    clientId(): number {
        return this.ourClient;
    }

    private issueClient(): number {
        const old = this.ourClient;
        const id = this.nextClient++;
        this.ourClient = id;
        this.clientIssuedAt = this.clock.now();
        this.liveClients.set(id, this.clientIssuedAt + this.timing.clientTtlMs);
        for (const l of [...this.renewedListeners]) l(id, old);
        return id;
    }

    async ensureClient(): Promise<number> {
        this.tick();
        if (!this.isConnected) throw new DisconnectedError();
        if (this.ourClient === 0 || this.clock.now() >= this.clientIssuedAt + this.timing.clientRenewMs) this.issueClient();
        return this.ourClient;
    }

    async renewClient(): Promise<number> {
        this.tick();
        if (!this.isConnected) throw new DisconnectedError();
        return this.issueClient();
    }

    onClientRenewed(listener: (id: number, old: number) => void): () => void {
        this.renewedListeners.add(listener);
        return () => { this.renewedListeners.delete(listener); };
    }

    onDisconnect(listener: () => void): () => void {
        this.disconnectListeners.add(listener);
        return () => { this.disconnectListeners.delete(listener); };
    }

    private disconnect() {
        if (!this.isConnected) return;
        this.isConnected = false;
        this.ourClient = 0;
        this.liveClients.clear();
        for (const l of [...this.disconnectListeners]) l();
    }

    /** Plug USB back in after an unplug fault: both halves start on what they run. */
    replug() {
        this.faults = this.faults.filter((f) => f.kind !== "unplug");
        this.session = null;
        this.held = null;
        this.latched = null;
        for (const h of [this.usb(), this.other()]) { h.alive = true; h.backAt = null; }
        this.isConnected = true;
    }

    /**
     * A person installed a release on one half by hand (RPI-RP2 and a .uf2): it boots the
     * new image, which resets its settings. The demo and the tests stand in for that with this.
     */
    flashByHand(hand: Hand, release: { fwVersion: number; tag: string; protocol?: number; imageId?: string }) {
        const h = this.halves[hand];
        h.cfg = { ...h.cfg, fwVersion: release.fwVersion, tag: release.tag, protocol: release.protocol ?? 4, imageId: release.imageId ?? `${release.tag}-${release.fwVersion}-${hand}` };
        this.session = null;
        this.held = null;
        this.latched = null;
        this.boot(h);
    }

    /** A half stops answering over the split cable, as firmware without the updater doesn't. */
    setAnswering(hand: Hand, answering: boolean) {
        this.halves[hand].alive = answering;
        this.halves[hand].backAt = null;
    }

    /** The other half is up and the split link reports it (a while after the half with USB boots). */
    linkUp(): boolean {
        return this.other().alive && this.clock.now() >= this.usbBootAt + this.timing.linkAfterBootMs;
    }

    /** Connected and answering: not writing its image, not just booted. */
    answering(): boolean {
        return this.connected() && !this.silent();
    }

    /** The half with USB is writing its image, or just booted: enumerated, silent. */
    private silent(): boolean {
        const now = this.clock.now();
        const s = this.session;
        if (s && s.state === State.COMMITTING && s.hand === this.usbHand && now >= s.commitAt + this.timing.usbCommitStartMs) return true;
        return now < this.usbBootAt + this.timing.bootQuietMs;
    }

    async request(op: number, hand: number, args: ArrayLike<number> = []): Promise<UpdaterReply> {
        this.tick();
        if (!this.isConnected) throw new DisconnectedError();
        if (this.silent()) {
            // No reply: the transport gives up after its timeout.
            await this.clock.sleep(1000);
            this.tick();
            if (!this.isConnected) throw new DisconnectedError();
            throw new ReplyTimeoutError(op);
        }
        const a = Uint8Array.from(args);
        this.opCount++;
        const expire = this.fault("expire-client");
        if (expire && this.opCount === expire.afterOps) this.liveClients.delete(this.ourClient);
        const client = this.ourClient;
        const expiry = this.liveClients.get(client);
        if (expiry === undefined || this.clock.now() > expiry) throw new ClientRejectedError(1);
        let rsp = await this.handle(op, hand, a, client);
        if (op === Op.INFO && hand === HAND_SELF && a[0] === 0 && this.has("info-crossed") && this.crossed < 2) {
            this.crossed++;
            rsp = await this.handle(op, hand, Uint8Array.of(1), client);
        }
        this.requests.push({ op, hand, at: this.clock.now(), status: rsp[0] });
        if (op === Op.COMMIT && this.has("commit-reply-lost") && this.session?.state === State.COMMITTING && this.session.hand === this.usbHand) {
            await this.clock.sleep(1000);
            throw new ReplyTimeoutError(op);
        }
        if (this.session && this.session.client === client && ACTIVE.has(this.session.state)) this.session.lastOpAt = this.clock.now();
        this.faultsAfter(op);
        return { status: rsp[0], rsp };
    }

    private faultsAfter(op: number) {
        const unplug = this.fault("unplug");
        const s = this.session;
        if (!unplug || !s) return;
        const half = s.image.length ? s.staged / s.image.length : 0;
        const other = s.hand === this.otherHandId;
        const hit =
            (unplug.at === "other-send" && other && op === Op.CHUNK && half >= 0.5) ||
            (unplug.at === "self-send" && !other && op === Op.CHUNK && half >= 0.5) ||
            (unplug.at === "relay" && other && s.state === State.RELAYING && op === Op.RELAY && this.clock.now() - s.relayAt > 2500) ||
            (unplug.at === "subside" && other && s.state === State.SUBSIDE_COMMITTING && op === Op.STATUS);
        if (hit) {
            this.session = null;
            this.held = null;
            this.disconnect();
        }
    }

    // ---- time ------------------------------------------------------------------------------

    private tick() {
        const now = this.clock.now();
        for (const h of [this.usb(), this.other()]) {
            if (!h.alive && h.backAt !== null && now >= h.backAt) this.boot(h);
        }
        if (this.pendingReset && now >= this.pendingReset.at) {
            const { scope, at } = this.pendingReset;
            this.pendingReset = null;
            this.restartUsb(at);
            if (scope === 1) this.restartHalf(this.other(), at, this.timing.otherRebootMs);
            this.boots(now);
        }
        if (this.held?.doneAt != null && now > this.held.doneAt + this.timing.heldWindowMs) this.held = null;
        const s = this.session;
        if (!s) return;
        if (s.state === State.CONFIRM_WAIT && s.chordAt === null) {
            if (this.chordAfterMs !== "never" && !this.has("not-confirmed") && now >= s.armedAt + this.chordAfterMs) this.makeChord(s, s.armedAt + this.chordAfterMs);
            else if (now > s.armedAt + this.timing.chordWindowMs) return this.fail(Status.NOT_CONFIRMED);
        }
        if (ACTIVE.has(s.state) && s.state !== State.CONFIRM_WAIT && now - s.lastOpAt > this.timing.sessionTimeoutMs) return this.fail(Status.TIMEOUT);
        if (s.state === State.CONFIRM_WAIT && s.chordAt !== null && now - Math.max(s.lastOpAt, s.chordAt) > this.timing.sessionTimeoutMs) return this.fail(Status.TIMEOUT);
        if (s.state === State.VERIFYING_MANIFEST) s.state = State.ERASING;
        if (s.state === State.ERASING && now >= s.beginAt + s.sectors * this.timing.eraseMsPerSector) s.state = State.RECEIVING;
        if (s.state === State.VERIFYING_IMAGE && now >= s.endAt + this.timing.verifyMs) {
            const bad = this.fault("bad-hash");
            if (!s.verifyOk || (bad && (bad.hand === undefined || bad.hand === s.hand))) return this.fail(Status.BAD_HASH);
            // D45: a release half refuses a dev image by its own build info, whatever the manifest says.
            // The half with USB checks either image; the other half checks its own again (the relay).
            if (s.devImage && (this.usb().cfg.release || (s.hand !== this.usbHand && this.other().cfg.release))) return this.fail(Status.BAD_IMAGE);
            s.state = State.VERIFIED;
        }
        if (s.state === State.RELAYING) {
            const t = now - s.relayAt;
            if (this.has("relay-fail") && t > this.relayTotal() / 2) return this.fail(Status.UNAVAILABLE);
            if (!this.other().alive) return this.fail(Status.UNAVAILABLE);
            if (t >= this.relayTotal()) { s.state = State.RELAYED; s.relayedAt = now; }
        }
        if (s.state === State.SUBSIDE_COMMITTING) {
            const other = this.other();
            if (other.alive && now >= s.subsideAt + this.timing.commitDelayMs) {
                // The other half writes the image and restarts on it.
                other.cfg = { ...other.cfg, fwVersion: s.m!.fwVersion, tag: s.m!.tag, imageId: imageIdOf(s.manifest), protocol: s.m!.updaterProto };
                this.restartHalf(other, s.subsideAt + this.timing.commitDelayMs, this.has("other-no-return") ? Number.POSITIVE_INFINITY : this.timing.otherRebootMs);
            }
            if (now >= s.subsideAt + this.timing.subsideHoldMs) {
                this.session = null;
                this.relayDoneUnconfirmed = true;
                if (this.held) this.held.doneAt = now;
                if (this.has("held-lapse")) this.held = null;
            }
        }
        if (s.state === State.COMMITTING && s.hand === this.usbHand && now >= s.commitAt + this.timing.usbCommitStartMs) {
            const usb = this.usb();
            if (this.has("commit-refused")) {
                this.fail(Status.BUSY);
                return;
            }
            if (this.fault("unplug")?.at === "self-commit" || this.has("no-return")) {
                // Power lost mid-copy: BOOTSEL, never comes back as a keyboard.
                this.session = null;
                this.held = null;
                usb.alive = false;
                usb.backAt = null;
                this.disconnect();
                return;
            }
            if (now >= s.commitAt + this.timing.usbCommitStartMs + this.timing.commitCopyMs) {
                usb.cfg = { ...usb.cfg, fwVersion: s.m!.fwVersion, tag: s.m!.tag, imageId: imageIdOf(s.manifest), protocol: s.m!.updaterProto, noChord: s.noChordImage };
                this.restartUsb(s.commitAt + this.timing.usbCommitStartMs + this.timing.commitCopyMs);
                this.boots(now);
            }
        }
        this.boots(now);
    }

    private boots(now: number) {
        for (const h of [this.usb(), this.other()]) {
            if (!h.alive && h.backAt !== null && now >= h.backAt) this.boot(h);
        }
    }

    private relayTotal(): number {
        const len = this.session?.m?.imageLen ?? 0;
        return this.timing.relayEraseMs + len / this.timing.relayBytesPerMs + this.timing.relayVerifyMs;
    }

    private restartUsb(now: number) {
        this.session = null;
        this.held = null;
        this.latched = null;
        this.relayDoneUnconfirmed = false;
        this.usbReboots++;
        this.restartHalf(this.usb(), now, this.timing.rebootMs);
        this.disconnect();
    }

    /** A half restarts by itself, as after a SIDE write with the restart flag (fake-sides.ts). */
    restartForSide(role: "usb" | "other"): void {
        const now = this.clock.now();
        if (role === "usb") this.restartUsb(now);
        else this.restartHalf(this.other(), now, this.timing.otherRebootMs);
    }

    private restartHalf(h: Half, now: number, ms: number) {
        h.alive = false;
        h.backAt = Number.isFinite(ms) ? now + ms : null;
    }

    /** First boot of a half: D39 resets every stored setting when the record is invalid. */
    private boot(h: Half) {
        if (h === this.usb()) {
            this.usbBootAt = h.backAt ?? this.clock.now();
            this.crossed = 0;
        }
        h.alive = true;
        h.backAt = null;
        if (h.forceReset || h.bootedImage !== h.cfg.imageId) {
            this.settings[h.hand] = h.forceReset && h.forceBlank ? "blank" : "defaults";
            if (h === this.usb()) this.storageFlags |= 0x04;
        }
        h.forceReset = false;
        h.forceBlank = false;
        h.bootedImage = h.cfg.imageId;
        if (h === this.usb() && !this.has("unplug")) this.isConnected = true;
    }

    private makeChord(s: Session, at: number) {
        s.chordAt = at;
        this.chordsMade++;
        if (s.pair) this.held = { manifest: s.pair.slice(), client: s.client, nonce: s.nonce, doneAt: null };
    }

    private fail(status: number) {
        this.latched = { error: status };
        this.lastError = status;
        if (this.session) this.session.state = State.ERROR;
        this.held = null;
    }

    // ---- presence ---------------------------------------------------------------------------

    private presence(): number {
        const usb = this.usb();
        const other = this.other();
        if (!other.alive) return Presence.NONE;
        // The split link comes up a while after the half with USB boots.
        if (this.clock.now() < this.usbBootAt + this.timing.linkAfterBootMs) return Presence.NONE;
        if (this.session && (this.session.state === State.RELAYING || this.session.state === State.SUBSIDE_COMMITTING)) return Presence.NONE;
        return usb.cfg.fwVersion === other.cfg.fwVersion && usb.cfg.tag === other.cfg.tag && usb.cfg.protocol === other.cfg.protocol ? Presence.MATCH : Presence.VERSION;
    }

    // ---- ops --------------------------------------------------------------------------------

    private newSession(hand: Hand, client: number): Session {
        return {
            hand, client, state: State.MANIFEST_LOADING, manifest: new Uint8Array(MANIFEST_BYTES), filled: 0, pair: null, pairFilled: 0,
            m: null, nonce: 0, armedAt: 0, chordAt: null, preApproved: false, byPair: false, image: new Uint8Array(0), staged: 0,
            sectors: 0, beginAt: 0, endAt: 0, lastOpAt: this.clock.now(), relayAt: 0, relayedAt: 0, subsideAt: 0, commitAt: 0, crc: 0, verifyOk: false, noChordImage: false, devImage: false,
        };
    }

    private async handle(op: number, hand: number, a: Uint8Array, client: number): Promise<Uint8Array> {
        const known = hand === 0 || hand === 1;
        if (op === Op.INFO) {
            if (!known && hand !== HAND_SELF) return makeRsp(Status.UNSUPPORTED);
            return this.opInfo(hand === HAND_SELF ? this.usbHand : (hand as Hand), a[0] ?? 0);
        }
        if (!known) return makeRsp(Status.UNSUPPORTED);
        const h = hand as Hand;
        switch (op) {
            case Op.STATUS: return this.opStatus();
            case Op.RELAY: return this.opRelay();
            case Op.MANIFEST: return this.opManifest(h, a, client, false);
            case Op.PAIR_MANIFEST: return this.opManifest(h, a, client, true);
            case Op.ARM: return this.opArm(h, a[0] ?? ARM_MODE_SINGLE, client);
            case Op.BEGIN: return this.opBegin(h, u32(a, 0), client);
            case Op.CHUNK: return this.opChunk(h, a, client);
            case Op.END: return this.opEnd(h, u32(a, 0), client);
            case Op.COMMIT: return this.opCommit(h, u32(a, 0), u16(a, 4), client);
            case Op.ABORT: return this.opAbort(h, u32(a, 0), client);
            case Op.REBIND: return this.opRebind(u32(a, 0), client);
            case Op.SETTINGS_RESET: return this.opSettingsReset(h, a);
            default: return makeRsp(Status.INVALID);
        }
    }

    private opInfo(hand: Hand, page: number): Uint8Array {
        const half = this.halves[hand];
        const self = hand === this.usbHand;
        if (!self) {
            if (!half.alive || (this.session && (this.session.state === State.RELAYING || this.session.state === State.SUBSIDE_COMMITTING))) {
                const r = makeRsp(Status.UNAVAILABLE);
                r[1] = STATE_NO_ANSWER;
                return r;
            }
        }
        if (page === 1) return self ? encodeInfo1(Status.OK, half.cfg.fwVersion, half.cfg.tag) : makeRsp(Status.INVALID);
        if (page !== 0) return makeRsp(Status.INVALID);
        const c = half.cfg;
        let flags = (c.flash16MiB ? INFO_FLAG_16MIB : 0) | (c.writesFailing ? INFO_FLAG_WRITES_FAILING : 0) | (c.release ? INFO_FLAG_RELEASE : 0);
        if (self) {
            if (c.noChord) flags |= INFO_FLAG_NO_CHORD;
            const p = this.presence();
            if (p === Presence.VERSION || p === Presence.SAME_HAND || p === Presence.INVALID || (this.relayDoneUnconfirmed && p !== Presence.MATCH)) flags |= INFO_FLAG_OTHER_DIFFERS;
        }
        const state = self ? (this.session?.state ?? (this.latched ? State.ERROR : State.IDLE)) : State.IDLE;
        return encodeInfo0({
            status: c.flash16MiB && !c.writesFailing ? Status.OK : Status.UNAVAILABLE,
            state, protocol: c.protocol, slotBase: 0x200000, slotSize: 0x200000, maxImage: c.maxImage,
            jedec: self ? [0xef, 0x40, 0x18] : [0, 0, 0], pointingId: c.pointingId, hand, fwVersion: c.fwVersion,
            storageFormat: c.storageFormat, securityEpoch: c.securityEpoch, flags, lastError: self ? this.lastError : 0,
            chunkMax: CHUNK_PIECE_MAX, manifestMax: MANIFEST_PIECE_MAX, reportBytes: 64,
        });
    }

    private opStatus(): Uint8Array {
        const s = this.session;
        const state = s?.state ?? (this.latched ? State.ERROR : State.IDLE);
        return encodeStatus({
            status: Status.OK, state, staged: s?.staged ?? 0, imageLen: s?.m?.imageLen ?? 0,
            sectorsErased: s && s.state === State.ERASING ? Math.min(s.sectors, Math.floor((this.clock.now() - s.beginAt) / this.timing.eraseMsPerSector)) : s && s.state > State.ERASING ? s.sectors : 0,
            sectorsToErase: s?.sectors ?? 0, lastError: this.lastError, verifyMs: this.timing.verifyMs, eraseMsMax: 53,
            crcLo16: s && s.state >= State.VERIFIED && s.state !== State.ERROR ? s.crc & 0xffff : 0,
            flags: (s?.chordAt != null ? STATUS_FLAG_CHORD_MADE : 0) | (s && s.nonce ? STATUS_FLAG_BOUND : 0),
            presence: this.presence(),
            flags2: (this.held ? STATUS2_APPROVAL_HELD : 0) | (s?.preApproved ? STATUS2_PRE_APPROVED : 0),
        });
    }

    private opRelay(): Uint8Array {
        const s = this.session;
        const len = s?.m?.imageLen ?? 0;
        let phase: number = RelayPhase.IDLE;
        let acked = 0;
        let otherState: number = State.IDLE;
        let erased = 0;
        const toErase = Math.ceil(len / 4096);
        if (s && s.state === State.RELAYING) {
            const t = this.clock.now() - s.relayAt;
            const pagesEnd = this.timing.relayEraseMs + len / this.timing.relayBytesPerMs;
            if (t < this.timing.relayEraseMs) { phase = RelayPhase.ERASE_WAIT; otherState = State.ERASING; erased = Math.floor((t / this.timing.relayEraseMs) * toErase); }
            else if (t < pagesEnd) { phase = RelayPhase.PAGES; otherState = State.RECEIVING; erased = toErase; acked = Math.min(len, Math.floor((t - this.timing.relayEraseMs) * this.timing.relayBytesPerMs)); }
            else { phase = RelayPhase.VERIFY_WAIT; otherState = State.VERIFYING_IMAGE; erased = toErase; acked = len; }
        } else if (s && s.state === State.RELAYED) { phase = RelayPhase.VERIFIED; otherState = State.VERIFIED; acked = len; erased = toErase; }
        else if (s && s.state === State.SUBSIDE_COMMITTING) { phase = RelayPhase.HOLD; otherState = State.COMMITTING; acked = len; erased = toErase; }
        else if (this.relayDoneUnconfirmed) { phase = RelayPhase.DONE; acked = 0; }
        else if (s && s.state === State.ERROR && s.relayAt) { phase = RelayPhase.FAILED; }
        return encodeRelay({
            status: Status.OK, phase, otherState, otherError: 0, acked, imageLen: len, otherErased: erased, otherToErase: toErase,
            retries: 0, relayMs: s?.relayAt ? this.clock.now() - s.relayAt : 0, linkPaused: phase === RelayPhase.ERASE_WAIT || phase === RelayPhase.VERIFY_WAIT || phase === RelayPhase.HOLD,
            unconfirmed: phase === RelayPhase.DONE, error: this.latched?.error ?? 0, state: s?.state ?? (this.latched ? State.ERROR : State.IDLE),
        });
    }

    private opManifest(hand: Hand, a: Uint8Array, client: number, pair: boolean): Uint8Array {
        const off = a[0] ?? 0;
        const n = a[1] ?? 0;
        if (n < 1 || n > MANIFEST_PIECE_MAX || off + n > MANIFEST_BYTES) return makeRsp(Status.INVALID);
        const bytes = a.subarray(2, 2 + n);
        if (this.latched) return makeRsp(Status.BUSY);
        let s = this.session;
        if (pair) {
            if (hand !== this.usbHand) return makeRsp(Status.INVALID);
            if (!s || s.hand !== this.otherHandId) return makeRsp(Status.INVALID);
            if (s.client !== client) return makeRsp(Status.OTHER_CLIENT);
            if (s.state !== State.MANIFEST_LOADING) return makeRsp(Status.BUSY);
            if (!s.pair || off === 0) { s.pair = new Uint8Array(MANIFEST_BYTES); s.pairFilled = 0; }
            if (off !== s.pairFilled) return makeRsp(Status.INVALID);
            s.pair.set(bytes, off);
            s.pairFilled = off + n;
            return makeRsp(Status.OK, [s.pairFilled]);
        }
        if (s && s.state !== State.MANIFEST_LOADING) return makeRsp(Status.BUSY);
        if (this.held && this.held.client !== client) this.held = null; // a manifest from another client clears it
        if (!s || off === 0 || s.client !== client || s.hand !== hand) {
            if (off !== 0) return makeRsp(Status.INVALID);
            s = this.session = this.newSession(hand, client);
        }
        if (off !== s.filled) return makeRsp(Status.INVALID);
        s.manifest.set(bytes, off);
        s.filled = off + n;
        return makeRsp(Status.OK, [s.filled]);
    }

    /** update_manifest_check against one half: the refusals, in the firmware's order. */
    private refusal(m: SvupManifest, half: Half): number | null {
        const c = half.cfg;
        const protocols = half === this.usb() ? [4] : [2, 3, 4];
        if (!protocols.includes(c.protocol)) return Status.UNSUPPORTED;
        if (c.release && m.flags & MANIFEST_FLAG_DIAGNOSTIC) return Status.BAD_IMAGE;
        if (m.securityEpoch < c.securityEpoch) return Status.EPOCH;
        if (m.storageFormat < c.storageFormat) return Status.STORAGE;
        if (m.imageLen > c.maxImage) return Status.TOO_LARGE;
        return null;
    }

    private async opArm(hand: Hand, mode: number, client: number): Promise<Uint8Array> {
        const s = this.session;
        if (!s || s.hand !== hand || s.state !== State.MANIFEST_LOADING || s.filled !== MANIFEST_BYTES) return makeRsp(s && s.state !== State.MANIFEST_LOADING ? Status.BUSY : Status.INVALID);
        if (s.client !== client) return makeRsp(Status.OTHER_CLIENT);
        if (mode !== ARM_MODE_SINGLE && mode !== ARM_MODE_PAIR) return makeRsp(Status.INVALID);
        if (mode === ARM_MODE_PAIR && (hand !== this.otherHandId || !s.pair || s.pairFilled !== MANIFEST_BYTES)) return makeRsp(Status.INVALID);
        if (this.usb().cfg.writesFailing) return makeRsp(Status.UNAVAILABLE);
        if (hand === this.otherHandId && ![Presence.MATCH, Presence.VERSION].includes(this.presence() as 1 | 2)) return makeRsp(Status.UNAVAILABLE);
        let m: SvupManifest;
        try { m = parseManifest(s.manifest); } catch { this.fail(Status.UNSUPPORTED); return makeRsp(Status.UNSUPPORTED); }
        const why = this.refusal(m, this.halves[hand]);
        if (why !== null) { this.fail(why); return makeRsp(why); }
        if (mode === ARM_MODE_PAIR) {
            let pm: SvupManifest;
            try { pm = parseManifest(s.pair!); } catch { this.fail(Status.UNSUPPORTED); return makeRsp(Status.UNSUPPORTED); }
            const whyPair = this.refusal(pm, this.usb());
            if (whyPair !== null) { this.fail(whyPair); return makeRsp(whyPair); }
        }
        s.m = m;
        s.nonce = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
        s.armedAt = this.clock.now();
        s.state = State.CONFIRM_WAIT;
        let flags = mode === ARM_MODE_PAIR ? ARM_PAIR : 0;
        const noChord = this.usb().cfg.noChord;
        const held = this.held;
        if (mode === ARM_MODE_SINGLE && hand === this.usbHand && held && held.client === client && hex(held.manifest) === hex(s.manifest)) {
            flags |= ARM_PRE_APPROVED | ARM_BY_PAIR;
            s.preApproved = true;
            s.byPair = true;
            s.chordAt = s.armedAt;
            this.held = null; // used once
        } else if (noChord) {
            if (hand === this.usbHand) this.held = null; // any ARM for this half uses the approval up
            flags |= ARM_PRE_APPROVED | ARM_NO_CHORD;
            s.preApproved = true;
            s.chordAt = s.armedAt;
            if (mode === ARM_MODE_PAIR) this.held = { manifest: s.pair!.slice(), client, nonce: s.nonce, doneAt: null };
        } else {
            if (hand === this.usbHand) this.held = null; // any ARM for this half uses the approval up
            this.chordRequests++;
        }
        const mh = (await sha512(s.manifest)).subarray(0, 4);
        const ph = mode === ARM_MODE_PAIR ? (await sha512(s.pair!)).subarray(0, 4) : new Uint8Array(4);
        return encodeArm(Status.OK, s.nonce, mh, ph, flags);
    }

    private bound(s: Session | null, hand: Hand, nonce: number | null, client: number): Uint8Array | null {
        if (!s || s.hand !== hand) return makeRsp(this.latched ? Status.BUSY : Status.INVALID);
        if (s.client !== client) return makeRsp(Status.OTHER_CLIENT);
        if (nonce !== null && s.nonce !== nonce) return makeRsp(Status.INVALID);
        return null;
    }

    private opBegin(hand: Hand, nonce: number, client: number): Uint8Array {
        const s = this.session;
        const refused = this.bound(s, hand, nonce, client);
        if (refused) return refused;
        if (s!.state !== State.CONFIRM_WAIT) return makeRsp(Status.INVALID, [s!.state]);
        if (s!.chordAt === null) return makeRsp(Status.NOT_CONFIRMED, [s!.state]);
        s!.image = new Uint8Array(s!.m!.imageLen);
        s!.staged = 0;
        s!.sectors = Math.ceil(s!.m!.imageLen / 4096);
        s!.beginAt = this.clock.now();
        s!.state = State.VERIFYING_MANIFEST;
        return makeRsp(Status.ACCEPTED, [s!.state]);
    }

    private opChunk(hand: Hand, a: Uint8Array, client: number): Uint8Array {
        const s = this.session;
        const refused = this.bound(s, hand, null, client);
        if (refused) return refused;
        const off = u24(a, 0);
        const n = a[3] ?? 0;
        if (s!.state !== State.RECEIVING) return makeRsp(Status.INVALID, le24(s!.staged));
        if (n < 1 || n > CHUNK_PIECE_MAX) return makeRsp(Status.INVALID, le24(s!.staged));
        if (off < s!.staged && off + n <= s!.staged) return makeRsp(Status.OK, le24(s!.staged)); // a replay
        if (off !== s!.staged) return makeRsp(Status.OUT_OF_ORDER, le24(s!.staged));
        if (off + n > s!.image.length) { this.fail(Status.OVERRUN); return makeRsp(Status.OVERRUN, le24(s!.staged)); }
        s!.image.set(a.subarray(4, 4 + n), off);
        s!.staged = off + n;
        return makeRsp(Status.OK, le24(s!.staged));
    }

    private async opEnd(hand: Hand, nonce: number, client: number): Promise<Uint8Array> {
        const s = this.session;
        const refused = this.bound(s, hand, nonce, client);
        if (refused) return refused;
        if (s!.state !== State.RECEIVING || s!.staged !== s!.image.length) return makeRsp(Status.INVALID, [s!.state]);
        s!.endAt = this.clock.now();
        s!.state = State.VERIFYING_IMAGE;
        s!.crc = imageCrc(s!.image);
        const info = findBuildInfo(s!.image);
        s!.noChordImage = !!info?.noChord;
        s!.devImage = !!info && (info.flags & 0xc0) !== 0;
        const want = hex(s!.m!.sha512);
        s!.verifyOk = hex(await sha512(s!.image)) === want;
        return makeRsp(Status.ACCEPTED, [s!.state]);
    }

    private opCommit(hand: Hand, nonce: number, crc16: number, client: number): Uint8Array {
        const s = this.session;
        const refused = this.bound(s, hand, nonce, client);
        if (refused) return refused;
        if (s!.state === State.VERIFIED) {
            if ((s!.crc & 0xffff) !== crc16) return makeRsp(Status.INVALID, [s!.state]);
            if (hand === this.usbHand) {
                s!.state = State.COMMITTING;
                s!.commitAt = this.clock.now();
            } else {
                s!.state = State.RELAYING;
                s!.relayAt = this.clock.now();
            }
            return makeRsp(Status.ACCEPTED, [s!.state]);
        }
        if (s!.state === State.RELAYED) {
            if ((s!.crc & 0xffff) !== crc16) return makeRsp(Status.INVALID, [s!.state]);
            s!.state = State.SUBSIDE_COMMITTING;
            s!.subsideAt = this.clock.now();
            return makeRsp(Status.ACCEPTED, [s!.state]);
        }
        return makeRsp(Status.INVALID, [s!.state]);
    }

    private opAbort(hand: Hand, nonce: number, client: number): Uint8Array {
        this.held = null;
        if (this.latched) {
            this.latched = null;
            this.session = null;
            return makeRsp(Status.OK, [State.IDLE]);
        }
        const s = this.session;
        if (!s) return makeRsp(Status.OK, [State.IDLE]);
        if (s.client !== client) return makeRsp(Status.OTHER_CLIENT, [s.state]);
        if (s.nonce && s.nonce !== nonce) return makeRsp(Status.INVALID, [s.state]);
        if (s.state === State.COMMITTING || s.state === State.SUBSIDE_COMMITTING) return makeRsp(Status.BUSY, [s.state]);
        void hand;
        this.session = null;
        return makeRsp(Status.OK, [State.IDLE]);
    }

    private opRebind(nonce: number, client: number): Uint8Array {
        let moved = false;
        if (this.session && this.session.nonce === nonce) { this.session.client = client; moved = true; }
        if (this.held && this.held.nonce === nonce) { this.held.client = client; moved = true; }
        const state = this.session?.state ?? (this.latched ? State.ERROR : State.IDLE);
        return makeRsp(moved ? Status.OK : Status.INVALID, [state]);
    }

    private opSettingsReset(hand: Hand, a: Uint8Array): Uint8Array {
        if (hand !== this.usbHand) return makeRsp(Status.INVALID);
        if (!SETTINGS_RESET_MAGIC.every((b, i) => a[i] === b)) return makeRsp(Status.INVALID);
        const scope = a[4];
        // A half with USB from before D44 reads no mode byte: there, mode 1 is the reset to
        // defaults on both halves (it sends the split link protocol 4's 4-byte payload).
        const mode = this.usb().cfg.blankWipe ? a[5] ?? 0 : 0;
        if (scope !== 0 && scope !== 1) return makeRsp(Status.INVALID);
        if (mode > 1) return makeRsp(Status.INVALID);
        if (this.session || this.latched || this.held) return makeRsp(Status.BUSY);
        // The other half must answer and know the split op (protocol 4).
        if (scope === 1 && (!this.other().alive || this.other().cfg.protocol < 4)) return makeRsp(Status.UNAVAILABLE);
        // A half from before D44 refuses the mode byte over the split link: nothing changes.
        if (scope === 1 && mode === 1 && !this.other().cfg.blankWipe) return makeRsp(Status.UNAVAILABLE);
        this.usb().forceReset = true;
        this.usb().forceBlank = mode === 1;
        if (scope === 1) { this.other().forceReset = true; this.other().forceBlank = mode === 1; }
        this.pendingReset = { at: this.clock.now() + this.timing.resetDelayMs, scope };
        return makeRsp(Status.OK, [scope === 1 ? 3 : 1]);
    }

    // ---- the Sval side the mock host uses ------------------------------------------------------

    /** 0x2A: the host has acted on the reset notice. */
    clearStorageReset() {
        this.storageFlags &= ~0x04;
    }

    /** What a restore through the import path leaves on the board. */
    restoreSettings() {
        this.settings = { 0: "restored", 1: "restored" };
    }

    /** Whether an approval is held now (for assertions). */
    get approvalHeld(): boolean {
        this.tick();
        return !!this.held;
    }

    get state(): number {
        this.tick();
        return this.session?.state ?? (this.latched ? State.ERROR : State.IDLE);
    }
}
