// Sval SIDE (0x33): which half is which, on the one-image firmware (svalboard/either).
//
// Source of truth: keyboards/svalboard/docs/protocol.md ("Side") and side.c
// (sval_side_command) in svalboard/qmk, branch feat/one-image-hand.
//
// Discovery: GET_INFO byte 19 (feature_flags2), bit 6. Per-hand builds don't have it.
//
// Replies as usb.service's sendSvil returns them: the wrapper stripped, the command
// echo first. So reply[i] is the firmware's data[i + 1]:
//   GET   -> [0x33][op 0][status][format 1][side][source][strap][strap raw]
//            [record side][record source][other flags][other side][pair][link tx]
//            [link how][flags]
//   SET   -> [0x33][op 1][status]
//   CLEAR -> [0x33][op 2][status]

/** GET_INFO second feature byte: the board answers SIDE (0x33). */
export const SVIL_FLAG2_SIDE = 0x40;
export const CMD_SVIL_SIDE = 0x33;

export const SideOp = { GET: 0, SET: 1, CLEAR: 2 } as const;

/** side / other side / record side: 0 left, 1 right, 0xFF unknown; record side 0xFE: no record. */
export const SIDE_LEFT = 0;
export const SIDE_RIGHT = 1;
export const SIDE_UNKNOWN = 0xff;
export const SIDE_NO_RECORD = 0xfe;

export const SideSource = { NONE: 0, FACTORY: 1, KEYBARD: 2, MIGRATED: 3, STRAP: 4 } as const;

/** The thumb strap read at startup. 4 is a right strap (the probe's RIGHT class). */
export const Strap = { NONE: 0, LEFT: 1, ANOMALY: 2, NOT_READ: 3, RIGHT: 4 } as const;

export const PairState = { OK: 0, SAME: 1, NO_SIDE: 2, PENDING: 3 } as const;

/** SET and CLEAR status. */
export const SideStatus = {
    OK: 0,
    INVALID: 1,
    NO_RECORD_AREA: 2,
    WRITE_FAILED: 3,
    /** The thumb strap says the other side: refused. */
    STRAP_DISAGREES: 4,
    OTHER_NOT_CONNECTED: 5,
    /** The other half didn't answer (it runs older firmware). */
    NO_ANSWER: 6,
    /** The other half took it and saves it from its main loop: read again after it restarts. */
    OTHER_ACCEPTED: 7,
} as const;

export const SideTarget = { THIS: 0, OTHER: 1 } as const;
export type SideTargetCode = (typeof SideTarget)[keyof typeof SideTarget];

/** SET/CLEAR flags bit 0: restart the half 0.1 s after a successful write. */
export const SIDE_FLAG_RESTART = 0x01;

export type Side = "left" | "right";
export type SideValue = Side | "unknown";

export const sideCode = (s: Side): number => (s === "left" ? SIDE_LEFT : SIDE_RIGHT);
export const sideOf = (code: number): SideValue => (code === SIDE_LEFT ? "left" : code === SIDE_RIGHT ? "right" : "unknown");
export const oppositeSide = (s: Side): Side => (s === "left" ? "right" : "left");
/** The strap's side, if it names one. */
export const strapSide = (strap: number): Side | null => (strap === Strap.LEFT ? "left" : strap === Strap.RIGHT ? "right" : null);

export type PairName = "ok" | "same" | "no-side" | "pending";
const PAIRS: Record<number, PairName> = { 0: "ok", 1: "same", 2: "no-side", 3: "pending" };

export interface SideReport {
    status: number;
    format: number;
    /** The side this half (the one with USB) runs as now. */
    side: SideValue;
    /** 0 none, 1 factory, 2 Keybard, 3 migrated, 4 strap. */
    source: number;
    /** 0 no strap, 1 left, 2 anomaly, 3 not read, 4 right. */
    strap: number;
    strapRaw: number;
    /** The stored record: a side, "unknown" (cleared), or "none" (no record, or no room). */
    recordSide: SideValue | "none";
    recordSource: number;
    otherConnected: boolean;
    /** The other half has reported its side over the presence ping. */
    otherReported: boolean;
    otherSide: SideValue;
    pair: PairName;
    /** GPIO this half sends on over the split cable (0xFF before the link starts). */
    linkTx: number;
    linkHow: number;
    /** Keys and pointing are dropped now. */
    inputBlocked: boolean;
    /** The record differs from the running side: a restart is pending. */
    restartPending: boolean;
    /** This half has room for the record (16 MB flash). */
    recordArea: boolean;
    usbHalf: boolean;
}

/** Whether the board advertises SIDE (GET_INFO feature_flags2 bit 6). */
export const hasSideCommand = (featureFlags2: number | undefined | null): boolean => ((featureFlags2 ?? 0) & SVIL_FLAG2_SIDE) !== 0;

// ---- requests (the bytes after the 0x33 command byte) ----------------------------------

export const sideGetArgs = (): number[] => [SideOp.GET];

export function sideSetArgs(target: SideTargetCode, side: Side, o: { source?: number; restart?: boolean } = {}): number[] {
    return [SideOp.SET, target, sideCode(side), o.source ?? SideSource.KEYBARD, o.restart ? SIDE_FLAG_RESTART : 0];
}

export function sideClearArgs(target: SideTargetCode, o: { restart?: boolean } = {}): number[] {
    return [SideOp.CLEAR, target, o.restart ? SIDE_FLAG_RESTART : 0];
}

// ---- replies -------------------------------------------------------------------------------

/** A GET reply, or null when it isn't one (another command's echo, an old format). */
export function decodeSideGet(reply: ArrayLike<number>): SideReport | null {
    if (reply.length < 16 || reply[0] !== CMD_SVIL_SIDE || reply[1] !== SideOp.GET) return null;
    const status = reply[2];
    const format = reply[3];
    if (status !== SideStatus.OK || format !== 1) return null;
    const otherFlags = reply[10];
    const flags = reply[15];
    return {
        status,
        format,
        side: sideOf(reply[4]),
        source: reply[5],
        strap: reply[6],
        strapRaw: reply[7],
        recordSide: reply[8] === SIDE_NO_RECORD ? "none" : sideOf(reply[8]),
        recordSource: reply[9],
        otherConnected: (otherFlags & 0x01) !== 0,
        otherReported: (otherFlags & 0x02) !== 0,
        otherSide: sideOf(reply[11]),
        pair: PAIRS[reply[12]] ?? "pending",
        linkTx: reply[13],
        linkHow: reply[14],
        inputBlocked: (flags & 0x01) !== 0,
        restartPending: (flags & 0x02) !== 0,
        recordArea: (flags & 0x04) !== 0,
        usbHalf: (flags & 0x08) !== 0,
    };
}

/** The status of a SET or CLEAR reply; null when the reply isn't for that op. */
export function decodeSideStatus(reply: ArrayLike<number>, op: number): number | null {
    if (reply.length < 3 || reply[0] !== CMD_SVIL_SIDE || reply[1] !== op) return null;
    return reply[2];
}

/** A GET reply as the firmware builds it (the mock board and the tests). */
export function encodeSideGet(r: Partial<Omit<SideReport, "status" | "format">> & { side: SideValue }): Uint8Array {
    const code = (s: SideValue | "none" | undefined, none = SIDE_UNKNOWN) => (s === "left" ? SIDE_LEFT : s === "right" ? SIDE_RIGHT : s === "none" ? SIDE_NO_RECORD : none);
    const pair = Object.entries(PAIRS).find(([, v]) => v === (r.pair ?? "ok"))?.[0] ?? "0";
    const out = new Uint8Array(32);
    out.set([
        CMD_SVIL_SIDE, SideOp.GET, SideStatus.OK, 1,
        code(r.side), r.source ?? SideSource.NONE, r.strap ?? Strap.NONE, r.strapRaw ?? 0,
        code(r.recordSide ?? r.side), r.recordSource ?? r.source ?? SideSource.NONE,
        (r.otherConnected ? 1 : 0) | (r.otherReported ? 2 : 0), code(r.otherSide),
        Number(pair), r.linkTx ?? 0, r.linkHow ?? 0,
        (r.inputBlocked ? 1 : 0) | (r.restartPending ? 2 : 0) | (r.recordArea === false ? 0 : 4) | (r.usbHalf === false ? 0 : 8),
    ]);
    return out;
}

// ---- transport -----------------------------------------------------------------------------

/** One Sval command and its reply (the echo first), as usb.service's sendSvil gives it. */
export interface SvalTransport {
    sval(cmd: number, args: number[]): Promise<Uint8Array>;
}

/** GET, SET and CLEAR over a Sval transport. */
export class SideClient {
    constructor(private readonly t: SvalTransport) {}

    async get(): Promise<SideReport | null> {
        return decodeSideGet(await this.t.sval(CMD_SVIL_SIDE, sideGetArgs()));
    }

    /** SET; returns the status (SideStatus), or INVALID for a reply that isn't one. */
    async set(target: SideTargetCode, side: Side, o: { source?: number; restart?: boolean } = {}): Promise<number> {
        const reply = await this.t.sval(CMD_SVIL_SIDE, sideSetArgs(target, side, o));
        return decodeSideStatus(reply, SideOp.SET) ?? SideStatus.INVALID;
    }

    async clear(target: SideTargetCode, o: { restart?: boolean } = {}): Promise<number> {
        const reply = await this.t.sval(CMD_SVIL_SIDE, sideClearArgs(target, o));
        return decodeSideStatus(reply, SideOp.CLEAR) ?? SideStatus.INVALID;
    }
}
