// The flow's host over FakeSvalboard: the mock board's restarts, its storage flags,
// and a stand-in for putting the layout back. Used by the tests and the harness.

import { FakeSvalboard, type Fault, type FakeHalfConfig, type FakeTiming } from "./fake-board";
import { FakeSides, type FakeSidesOptions } from "./fake-sides";
import type { SideHost } from "../side-host";
import type { FlowHost } from "./flow";
import { HAND_EITHER, HAND_LEFT, HAND_RIGHT, MANIFEST_BYTES, Op, type Hand } from "./protocol";
import { buildSvup, loadSvup, type SvupFile } from "./svup";
import { buildPairUf2, buildPlainUf2, loadFirmwareFile } from "./uf2";
import { ReplyTimeoutError, type Clock, type UpdaterTransport } from "./transport";

export interface FakeHostOptions {
    restoreFails?: boolean;
    trimmed?: string[];
}

export class FakeHost implements FlowHost {
    restores = 0;
    clears = 0;
    /** Order of the Sval-side calls, for "0x2A last". */
    readonly events: string[] = [];
    /** SIDE on the mock board, when the setup gave it one. */
    sides?: SideHost;

    constructor(readonly board: FakeSvalboard, readonly clock: Clock, private o: FakeHostOptions = {}) {}

    transport(): UpdaterTransport | null {
        return this.board.connected() ? this.board : null;
    }

    async waitForDevice(timeoutMs: number): Promise<UpdaterTransport | null> {
        const deadline = this.clock.now() + timeoutMs;
        while (this.clock.now() < deadline) {
            if (this.board.connected()) {
                this.events.push("reconnected");
                return this.board;
            }
            await this.clock.sleep(250);
        }
        return null;
    }

    async readStorageFlags(): Promise<number> {
        this.events.push(`flags:${this.board.storageFlags}`);
        return this.board.storageFlags;
    }

    async clearStorageReset(): Promise<void> {
        this.clears++;
        this.events.push("0x2A");
        this.board.clearStorageReset();
    }

    async keymapBlank(): Promise<boolean> {
        this.events.push("keymap");
        return this.board.settings[this.board.usbHand] === "blank";
    }

    async restoreLayout(_svil: string): Promise<{ trimmed: string[] }> {
        this.restores++;
        this.events.push("restore");
        if (this.o.restoreFails) throw new Error("The keyboard stopped answering while the layout was written.");
        this.board.restoreSettings();
        return { trimmed: this.o.trimmed ?? [] };
    }
}

export interface FixtureRelease {
    tag: string;
    fwVersion: number;
    files: Record<Hand, SvupFile>;
}

/** The pair UF2 bytes of a synthetic one image (manifest hand 2, svalboard/either), as a release ships it (x4 on). */
export async function fixturePairUf2(tag: string, fwVersion: number, o: { noChord?: boolean; imageLen?: number; flags?: number } = {}): Promise<Uint8Array> {
    const svup = await buildSvup({ hand: HAND_EITHER, fwVersion, tag, imageLen: o.imageLen ?? 0x2000, buildFlags: o.noChord ? 0x40 : 0, flags: o.flags });
    return buildPairUf2(svup.subarray(0, MANIFEST_BYTES), svup.subarray(MANIFEST_BYTES));
}

/** One release's one file for both halves: a pair UF2 of a synthetic one image, loaded as Keybard loads it. */
export async function fixtureOneImage(tag: string, fwVersion: number, o: { noChord?: boolean; imageLen?: number; flags?: number } = {}): Promise<FixtureRelease> {
    const file = await loadFirmwareFile(await fixturePairUf2(tag, fwVersion, o));
    return { tag, fwVersion, files: { [HAND_LEFT]: file, [HAND_RIGHT]: file } as Record<Hand, SvupFile> };
}

/** A per-side .uf2 as releases shipped before x4 (no pair record): Keybard refuses it. */
export async function fixturePerSideUf2(tag: string, fwVersion: number, hand: Hand, o: { imageLen?: number } = {}): Promise<Uint8Array> {
    const svup = await buildSvup({ hand, fwVersion, tag, imageLen: o.imageLen ?? 0x2000 });
    return buildPlainUf2(svup.subarray(MANIFEST_BYTES));
}

/** A pair of synthetic .svup files for one release. */
export async function fixtureRelease(tag: string, fwVersion: number, o: { noChord?: boolean; imageLen?: number; flags?: number } = {}): Promise<FixtureRelease> {
    const make = async (hand: Hand) => loadSvup(await buildSvup({
        hand, fwVersion, tag, imageLen: o.imageLen ?? 0x2000, buildFlags: o.noChord ? 0x40 : 0, flags: o.flags,
    }));
    return { tag, fwVersion, files: { [HAND_LEFT]: await make(HAND_LEFT), [HAND_RIGHT]: await make(HAND_RIGHT) } as Record<Hand, SvupFile> };
}

export interface FakeSetupOptions {
    clock: Clock;
    /** What both halves run now. */
    running: FixtureRelease | { tag: string; fwVersion: number };
    usbHand?: Hand;
    noChord?: boolean;
    release?: boolean;
    chordAfterMs?: number | "never";
    faults?: Fault[];
    otherRunning?: { tag: string; fwVersion: number };
    host?: FakeHostOptions;
    half?: Partial<FakeHalfConfig>;
    /** SIDE on the mock board (fake-sides.ts). Absent: the board has none, as a per-hand build. */
    sides?: FakeSidesOptions;
    /** The mule's timing (fake-board.ts DEFAULT_TIMING) with these changes. */
    timing?: Partial<FakeTiming>;
}

/** A mock board running `running` on both halves, and its host. */
export function fakeSetup(o: FakeSetupOptions): { board: FakeSvalboard; host: FakeHost; sides: FakeSides | null } {
    const imageId = (hand: Hand, r: FakeSetupOptions["running"]) =>
        "files" in r ? Array.from(r.files[hand].manifestBytes.subarray(44, 60), (b) => b.toString(16).padStart(2, "0")).join("") : `${r.tag}-${r.fwVersion}-${hand}`;
    const usbHand = o.usbHand ?? HAND_RIGHT;
    const cfg = (hand: Hand): FakeHalfConfig => {
        const r = hand !== usbHand && o.otherRunning ? o.otherRunning : o.running;
        return { fwVersion: r.fwVersion, tag: r.tag, imageId: imageId(hand, r), noChord: o.noChord, release: o.release, ...o.half };
    };
    const board = new FakeSvalboard({
        usbHand, clock: o.clock, left: cfg(HAND_LEFT), right: cfg(HAND_RIGHT), chordAfterMs: o.chordAfterMs, faults: o.faults, timing: o.timing,
    });
    const host = new FakeHost(board, o.clock, o.host);
    const sides = o.sides ? new FakeSides(board, o.sides) : null;
    if (sides) host.sides = sides.host;
    return { board, host, sides };
}

/**
 * A board whose INFO goes unanswered, for the harness and tests (?infofail): the first
 * `fails` INFO requests time out (as on a board still starting, or busy with another
 * app), every one ("always"), or every one until answer() ("read"). Everything else goes through.
 */
export class FlakyInfoTransport implements UpdaterTransport {
    private left: number;
    constructor(private readonly inner: UpdaterTransport, private readonly clock: Clock, fails: number | "always" | "read") {
        this.left = typeof fails === "number" ? fails : Number.POSITIVE_INFINITY;
    }
    /** From now on INFO is answered. */
    answer() { this.left = 0; }
    async request(op: number, hand: number, args?: ArrayLike<number>) {
        if (op === Op.INFO && this.left > 0) {
            this.left--;
            await this.clock.sleep(1000);
            throw new ReplyTimeoutError(op);
        }
        return this.inner.request(op, hand, args);
    }
    clientId() { return this.inner.clientId(); }
    ensureClient() { return this.inner.ensureClient(); }
    renewClient() { return this.inner.renewClient(); }
    onClientRenewed(l: (id: number, old: number) => void) { return this.inner.onClientRenewed(l); }
    onDisconnect(l: () => void) { return this.inner.onDisconnect(l); }
    connected() { return this.inner.connected(); }
}
