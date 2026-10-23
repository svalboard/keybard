// The in-firmware updater's host protocol (updater protocol 4), as pure codecs.
//
// Source of truth: keyboards/svalboard/updater/updater.c (header comment) in
// svalboard/qmk, plus the protocol-4 contract in the firmware-settings plan
// (PAIR_MANIFEST, pair ARM, the held approval, SETTINGS_RESET, ARM reply flags,
// STATUS rsp[23], INFO flags bit7).
//
// One 64-byte raw HID report per request:
//   [0xDD][client_id u32 LE][0xFE][0x07][0x55][op][value_data: 55 bytes]
// The reply is the same packet with value_data rewritten. value_data[0] is
// always a status. Below, req[i] and rsp[i] index value_data; req[0] is the hand.

import { ReplyTimeoutError } from "./transport";

export const WRAPPER_PREFIX = 0xdd;
export const VIA_PREFIX = 0xfe;
export const WRAPPER_ERROR = 0xff;
export const VIA_SET_VALUE = 0x07;
export const UPDATE_CHANNEL = 0x55;

/** The updater protocol Keybard's install flow speaks. */
export const UPDATER_PROTOCOL = 4;
export const REPORT_BYTES = 64;
/** Bytes of value_data: the report minus the wrapper's 6 and VIA's 3. */
export const VALUE_BYTES = REPORT_BYTES - 9;
export const MANIFEST_BYTES = 108;
export const MANIFEST_PIECE_MAX = VALUE_BYTES - 3; // 52, after [hand][off][n]
export const CHUNK_PIECE_MAX = VALUE_BYTES - 5; // 50, after [hand][off u24][n]

export const HAND_LEFT = 0;
export const HAND_RIGHT = 1;
/** INFO only: "this half", whichever it is. */
export const HAND_SELF = 0xff;
export type Hand = typeof HAND_LEFT | typeof HAND_RIGHT;
/** Manifests and build info only: one image for both halves (svalboard/either). */
export const HAND_EITHER = 2;

export const otherHand = (hand: Hand): Hand => (hand === HAND_LEFT ? HAND_RIGHT : HAND_LEFT);
export const handName = (hand: number): "left" | "right" => (hand === HAND_LEFT ? "left" : "right");

export const Op = {
    INFO: 0x00,
    MANIFEST: 0x01,
    ARM: 0x02,
    BEGIN: 0x03,
    CHUNK: 0x04,
    END: 0x05,
    STATUS: 0x06,
    COMMIT: 0x07,
    ABORT: 0x08,
    REBIND: 0x09,
    TEST_HALT: 0x0a,
    DIAG: 0x0b,
    RELAY: 0x0c,
    PAIR_MANIFEST: 0x0d,
    SETTINGS_RESET: 0x0e,
} as const;
export type OpCode = (typeof Op)[keyof typeof Op];

export const Status = {
    OK: 0,
    INVALID: 1,
    UNAVAILABLE: 2,
    FLASH_ERR: 3,
    ACCEPTED: 4,
    BUSY: 5,
    NOT_CONFIRMED: 6,
    BAD_HASH: 9,
    BAD_IMAGE: 10,
    EPOCH: 11,
    OUT_OF_ORDER: 12,
    OVERRUN: 13,
    TOO_LARGE: 14,
    TIMEOUT: 15,
    OTHER_CLIENT: 16,
    UNSUPPORTED: 17,
    STORAGE: 18,
} as const;

const STATUS_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Status).map(([k, v]) => [v, k]));
export const statusName = (code: number): string => STATUS_NAMES[code] ?? `status ${code}`;

export const State = {
    IDLE: 0,
    MANIFEST_LOADING: 1,
    CONFIRM_WAIT: 2,
    VERIFYING_MANIFEST: 3,
    ERASING: 4,
    RECEIVING: 5,
    VERIFYING_IMAGE: 6,
    VERIFIED: 7,
    COMMITTING: 8,
    ERROR: 9,
    RELAYING: 10,
    RELAYED: 11,
    SUBSIDE_COMMITTING: 12,
} as const;
/** INFO of the other half: no answer over the split cable. */
export const STATE_NO_ANSWER = 0xff;

const STATE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(State).map(([k, v]) => [v, k]));
export const stateName = (code: number): string => (code === STATE_NO_ANSWER ? "NO_ANSWER" : STATE_NAMES[code] ?? `state ${code}`);

export const Presence = {
    NONE: 0,
    MATCH: 1,
    VERSION: 2,
    SAME_HAND: 3,
    INVALID: 4,
} as const;

export const RelayPhase = {
    IDLE: 0,
    START: 1,
    MANIFEST: 2,
    ERASE_WAIT: 3,
    PAGES: 4,
    END: 5,
    VERIFY_WAIT: 6,
    VERIFIED: 7,
    COMMIT: 8,
    HOLD: 9,
    PROBE: 10,
    DONE: 11,
    FAILED: 12,
    ABORTING: 13,
} as const;

// INFO page 0 rsp[21]
export const INFO_FLAG_16MIB = 0x01;
export const INFO_FLAG_WRITES_FAILING = 0x02;
export const INFO_FLAG_RELEASE = 0x04;
export const INFO_FLAG_TEST_HOOKS = 0x08;
export const INFO_FLAG_OTHER_DIFFERS = 0x20;
/** F-N1: a no-chord developer build. Read from the half with USB only. */
export const INFO_FLAG_NO_CHORD = 0x80;

// STATUS rsp[21]
export const STATUS_FLAG_CHORD_MADE = 0x01;
export const STATUS_FLAG_BOUND = 0x02;
export const STATUS_FLAG_WRITES_FAILING = 0x04;
// STATUS rsp[23] (protocol 4)
export const STATUS2_APPROVAL_HELD = 0x01;
export const STATUS2_PRE_APPROVED = 0x02;

// ARM rsp[13] (protocol 4)
export const ARM_PRE_APPROVED = 0x01;
export const ARM_BY_PAIR = 0x02;
export const ARM_NO_CHORD = 0x04;
export const ARM_PAIR = 0x08;

export const ARM_MODE_SINGLE = 0;
export const ARM_MODE_PAIR = 1;

export const SETTINGS_RESET_MAGIC = [0x52, 0x53, 0x45, 0x54]; // "RSET"
export const SETTINGS_RESET_THIS_HALF = 0;
export const SETTINGS_RESET_BOTH = 1;
/** SETTINGS_RESET mode (D44): the firmware's defaults, or a blank board (every key KC_NO). */
export const SETTINGS_RESET_DEFAULTS = 0;
export const SETTINGS_RESET_BLANK = 1;

// Manifest flags (manifest bytes 10-11)
export const MANIFEST_FLAG_RELEASE = 0x0001;
export const MANIFEST_FLAG_DIAGNOSTIC = 0x0002;

export const POINTING_AUTO = 5;
export const POINTING_NAMES: Record<number, string> = {
    0: "No pointing module",
    1: "Trackpoint",
    2: "Trackball",
    3: "Trackball",
    4: "Touchpad",
    5: "Any module",
};

// ---- little-endian helpers ------------------------------------------------------------

export const u16 = (b: ArrayLike<number>, i: number): number => (b[i] | (b[i + 1] << 8)) >>> 0;
export const u24 = (b: ArrayLike<number>, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) >>> 0;
export const u32 = (b: ArrayLike<number>, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
export const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
export const le24 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
export const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

// ---- packets ------------------------------------------------------------------------------

/** The full 64-byte report for one updater request. */
export function encodePacket(clientId: number, op: number, hand: number, args: ArrayLike<number> = []): Uint8Array {
    if (args.length > VALUE_BYTES - 1) throw new RangeError(`updater request too long: ${args.length} bytes after the hand`);
    const p = new Uint8Array(REPORT_BYTES);
    p[0] = WRAPPER_PREFIX;
    p.set(le32(clientId), 1);
    p[5] = VIA_PREFIX;
    p[6] = VIA_SET_VALUE;
    p[7] = UPDATE_CHANNEL;
    p[8] = op;
    p[9] = hand;
    for (let i = 0; i < args.length; i++) p[10 + i] = args[i];
    return p;
}

/** The VIA payload after the 0xFE prefix, as usb.service sends it: [0x07][0x55][op][hand][args]. */
export function encodeViaPayload(op: number, hand: number, args: ArrayLike<number> = []): number[] {
    if (args.length > VALUE_BYTES - 1) throw new RangeError(`updater request too long: ${args.length} bytes after the hand`);
    return [VIA_SET_VALUE, UPDATE_CHANNEL, op, hand, ...Array.from(args)];
}

export interface UpdaterReply {
    status: number;
    /** value_data: rsp[0] is the status. Always VALUE_BYTES long. */
    rsp: Uint8Array;
}

/** Whether a report is the reply to this op for this client (the VIA echo matches). */
export function isReplyTo(report: Uint8Array, clientId: number, op: number): boolean {
    return report[0] === WRAPPER_PREFIX && u32(report, 1) === clientId >>> 0 && report[5] === VIA_PREFIX &&
        report[6] === VIA_SET_VALUE && report[7] === UPDATE_CHANNEL && report[8] === op;
}

/** value_data of a reply report. */
export function decodeReply(report: Uint8Array): UpdaterReply {
    const rsp = new Uint8Array(VALUE_BYTES);
    rsp.set(report.subarray(9, 9 + VALUE_BYTES));
    return { status: rsp[0], rsp };
}

/** A reply as the firmware builds it, for the mock board: [status] + bytes, zero padded. */
export function makeRsp(status: number, bytes: ArrayLike<number> = []): Uint8Array {
    const rsp = new Uint8Array(VALUE_BYTES);
    rsp[0] = status;
    for (let i = 0; i < bytes.length && i + 1 < VALUE_BYTES; i++) rsp[i + 1] = bytes[i];
    return rsp;
}

// ---- request arguments (after [hand]) ------------------------------------------------------

export const infoArgs = (page = 0): number[] => [page];
export const manifestArgs = (off: number, piece: ArrayLike<number>): number[] => {
    if (piece.length < 1 || piece.length > MANIFEST_PIECE_MAX) throw new RangeError(`manifest piece of ${piece.length} bytes`);
    return [off, piece.length, ...Array.from(piece)];
};
export const armArgs = (mode: number = ARM_MODE_SINGLE): number[] => [mode];
export const nonceArgs = (nonce: number): number[] => le32(nonce);
export const chunkArgs = (off: number, data: ArrayLike<number>): number[] => {
    if (data.length < 1 || data.length > CHUNK_PIECE_MAX) throw new RangeError(`chunk of ${data.length} bytes`);
    return [...le24(off), data.length, ...Array.from(data)];
};
export const commitArgs = (nonce: number, crc16: number): number[] => [...le32(nonce), ...le16(crc16)];
export const settingsResetArgs = (scope: number = SETTINGS_RESET_BOTH, mode: number = SETTINGS_RESET_DEFAULTS): number[] => [...SETTINGS_RESET_MAGIC, scope, mode];

/** The manifest's 108 bytes in pieces of at most `piece` bytes: [off, bytes]. */
export function manifestPieces(manifest: Uint8Array, piece = MANIFEST_PIECE_MAX): Array<[number, Uint8Array]> {
    const out: Array<[number, Uint8Array]> = [];
    for (let off = 0; off < manifest.length; off += piece) out.push([off, manifest.subarray(off, Math.min(off + piece, manifest.length))]);
    return out;
}

// ---- replies ---------------------------------------------------------------------------------

export interface Info0 {
    status: number;
    state: number;
    /** The other half didn't answer over the split cable (state 0xFF). */
    answered: boolean;
    protocol: number;
    slotBase: number;
    slotSize: number;
    maxImage: number;
    jedec: string;
    pointingId: number;
    hand: number;
    fwVersion: number;
    storageFormat: number;
    securityEpoch: number;
    flags: number;
    flash16MiB: boolean;
    writesFailing: boolean;
    releaseBuild: boolean;
    testHooks: boolean;
    otherDiffers: boolean;
    noChord: boolean;
    lastError: number;
    chunkMax: number;
    manifestMax: number;
    reportBytes: number;
}

/**
 * An INFO page 1 reply: page byte 1, then fw_version, then the tag as printable ASCII padded with
 * zeros (an empty tag on a dev build). Page 0 never looks like this (its slot sizes and JEDEC bytes sit where the tag would).
 */
export function looksLikeInfo1(rsp: Uint8Array): boolean {
    if (rsp[1] !== 1 || u32(rsp, 2) > 0xffff) return false;
    let i = 6;
    while (i < 22 && rsp[i] >= 0x20 && rsp[i] < 0x7f) i++;
    for (; i < 22; i++) if (rsp[i] !== 0) return false;
    return true;
}

/** A reply that answers another request: a late one, after that request timed out. */
export class ReplyMismatchError extends ReplyTimeoutError {
    constructor(op: number, what: string) {
        super(op);
        this.name = "ReplyMismatchError";
        this.message = `The keyboard's reply was for another request (${what})`;
    }
}

export function decodeInfo0({ rsp }: UpdaterReply): Info0 {
    if (looksLikeInfo1(rsp)) throw new ReplyMismatchError(Op.INFO, "INFO page 1 read as page 0");
    const flags = rsp[21];
    return {
        status: rsp[0],
        state: rsp[1],
        answered: rsp[1] !== STATE_NO_ANSWER,
        protocol: rsp[2],
        slotBase: u16(rsp, 3) * 4096,
        slotSize: u16(rsp, 5) * 4096,
        maxImage: u16(rsp, 7) * 4096,
        jedec: Array.from(rsp.subarray(9, 12)).map((b) => b.toString(16).padStart(2, "0")).join(""),
        pointingId: rsp[12],
        hand: rsp[13],
        fwVersion: u32(rsp, 14),
        storageFormat: rsp[18],
        securityEpoch: u16(rsp, 19),
        flags,
        flash16MiB: !!(flags & INFO_FLAG_16MIB),
        writesFailing: !!(flags & INFO_FLAG_WRITES_FAILING),
        releaseBuild: !!(flags & INFO_FLAG_RELEASE),
        testHooks: !!(flags & INFO_FLAG_TEST_HOOKS),
        otherDiffers: !!(flags & INFO_FLAG_OTHER_DIFFERS),
        noChord: !!(flags & INFO_FLAG_NO_CHORD),
        lastError: rsp[22],
        chunkMax: rsp[23],
        manifestMax: rsp[24],
        reportBytes: rsp[25],
    };
}

export function encodeInfo0(i: Omit<Info0, "answered" | "flash16MiB" | "writesFailing" | "releaseBuild" | "testHooks" | "otherDiffers" | "noChord" | "jedec"> & { jedec?: number[] }): Uint8Array {
    return makeRsp(i.status, [
        i.state, i.protocol, ...le16(i.slotBase / 4096), ...le16(i.slotSize / 4096), ...le16(i.maxImage / 4096),
        ...(i.jedec ?? [0xef, 0x40, 0x18]), i.pointingId, i.hand, ...le32(i.fwVersion), i.storageFormat,
        ...le16(i.securityEpoch), i.flags, i.lastError, i.chunkMax, i.manifestMax, i.reportBytes,
    ]);
}

export interface Info1 {
    status: number;
    page: number;
    fwVersion: number;
    /** The release tag, e.g. "v3". */
    tag: string;
}

export function decodeInfo1({ rsp }: UpdaterReply): Info1 {
    if (rsp[0] === Status.OK && !looksLikeInfo1(rsp)) throw new ReplyMismatchError(Op.INFO, "INFO page 0 read as page 1");
    return { status: rsp[0], page: rsp[1], fwVersion: u32(rsp, 2), tag: cString(rsp.subarray(6, 22)) };
}

export function encodeInfo1(status: number, fwVersion: number, tag: string): Uint8Array {
    const text = Array.from(new TextEncoder().encode(tag.slice(0, 16)));
    return makeRsp(status, [1, ...le32(fwVersion), ...text, ...new Array(16 - text.length).fill(0)]);
}

export interface StatusReply {
    status: number;
    state: number;
    staged: number;
    imageLen: number;
    sectorsErased: number;
    sectorsToErase: number;
    lastError: number;
    verifyMs: number;
    eraseMsMax: number;
    crcLo16: number;
    flags: number;
    chordMade: boolean;
    bound: boolean;
    writesFailing: boolean;
    presence: number;
    flags2: number;
    /** F-N3: an approval is held for this half's next install. */
    approvalHeld: boolean;
    /** The current session was pre-approved. */
    preApproved: boolean;
}

export function decodeStatus({ rsp }: UpdaterReply): StatusReply {
    const flags = rsp[21];
    const flags2 = rsp[23];
    return {
        status: rsp[0],
        state: rsp[1],
        staged: u24(rsp, 2),
        imageLen: u24(rsp, 5),
        sectorsErased: u16(rsp, 8),
        sectorsToErase: u16(rsp, 10),
        lastError: rsp[12],
        verifyMs: u16(rsp, 15),
        eraseMsMax: u16(rsp, 17),
        crcLo16: u16(rsp, 19),
        flags,
        chordMade: !!(flags & STATUS_FLAG_CHORD_MADE),
        bound: !!(flags & STATUS_FLAG_BOUND),
        writesFailing: !!(flags & STATUS_FLAG_WRITES_FAILING),
        presence: rsp[22],
        flags2,
        approvalHeld: !!(flags2 & STATUS2_APPROVAL_HELD),
        preApproved: !!(flags2 & STATUS2_PRE_APPROVED),
    };
}

export function encodeStatus(s: Pick<StatusReply, "status" | "state" | "staged" | "imageLen" | "sectorsErased" | "sectorsToErase" | "lastError" | "verifyMs" | "eraseMsMax" | "crcLo16" | "flags" | "presence" | "flags2">): Uint8Array {
    return makeRsp(s.status, [
        s.state, ...le24(s.staged), ...le24(s.imageLen), ...le16(s.sectorsErased), ...le16(s.sectorsToErase),
        s.lastError, 0, 0, ...le16(s.verifyMs), ...le16(s.eraseMsMax), ...le16(s.crcLo16), s.flags, s.presence, s.flags2,
    ]);
}

export interface RelayReply {
    status: number;
    phase: number;
    otherState: number;
    otherError: number;
    acked: number;
    imageLen: number;
    otherErased: number;
    otherToErase: number;
    retries: number;
    relayMs: number;
    linkPaused: boolean;
    unconfirmed: boolean;
    error: number;
    state: number;
}

export function decodeRelay({ rsp }: UpdaterReply): RelayReply {
    return {
        status: rsp[0],
        phase: rsp[1],
        otherState: rsp[2],
        otherError: rsp[3],
        acked: u24(rsp, 4),
        imageLen: u24(rsp, 7),
        otherErased: u16(rsp, 10),
        otherToErase: u16(rsp, 12),
        retries: u16(rsp, 14),
        relayMs: u32(rsp, 16),
        linkPaused: !!(rsp[20] & 1),
        unconfirmed: !!(rsp[20] & 2),
        error: rsp[21],
        state: rsp[22],
    };
}

export function encodeRelay(r: Omit<RelayReply, "linkPaused" | "unconfirmed"> & { linkPaused?: boolean; unconfirmed?: boolean }): Uint8Array {
    return makeRsp(r.status, [
        r.phase, r.otherState, r.otherError, ...le24(r.acked), ...le24(r.imageLen), ...le16(r.otherErased),
        ...le16(r.otherToErase), ...le16(r.retries), ...le32(r.relayMs), (r.linkPaused ? 1 : 0) | (r.unconfirmed ? 2 : 0),
        r.error, r.state,
    ]);
}

export interface ArmReply {
    status: number;
    nonce: number;
    /** The first 4 bytes of SHA-512 of the session's 108-byte manifest. */
    manifestHash: Uint8Array;
    /** The first 4 bytes of SHA-512 of the pair manifest (pair ARM; zeros otherwise). */
    pairHash: Uint8Array;
    flags: number;
    preApproved: boolean;
    byPair: boolean;
    noChord: boolean;
    pair: boolean;
}

export function decodeArm({ rsp }: UpdaterReply): ArmReply {
    const flags = rsp[13];
    return {
        status: rsp[0],
        nonce: u32(rsp, 1),
        manifestHash: rsp.slice(5, 9),
        pairHash: rsp.slice(9, 13),
        flags,
        preApproved: !!(flags & ARM_PRE_APPROVED),
        byPair: !!(flags & ARM_BY_PAIR),
        noChord: !!(flags & ARM_NO_CHORD),
        pair: !!(flags & ARM_PAIR),
    };
}

export function encodeArm(status: number, nonce: number, manifestHash: ArrayLike<number>, pairHash: ArrayLike<number>, flags: number): Uint8Array {
    return makeRsp(status, [...le32(nonce), ...Array.from(manifestHash).slice(0, 4), ...Array.from(pairHash).slice(0, 4), flags]);
}

/** [status][filled]: bytes of the manifest loaded so far. */
export const decodeFilled = ({ rsp }: UpdaterReply): number => rsp[1];
/** CHUNK's [status][next offset u24]. */
export const decodeNextOffset = ({ rsp }: UpdaterReply): number => u24(rsp, 1);
/** BEGIN, END, COMMIT, ABORT, REBIND: [status][state]. */
export const decodeStateReply = ({ rsp }: UpdaterReply): number => rsp[1];
/** SETTINGS_RESET's [status][done mask]: bit0 this half, bit1 the other half. */
export const decodeResetMask = ({ rsp }: UpdaterReply): number => rsp[1];

function cString(bytes: Uint8Array): string {
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end));
}

export const hex = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
