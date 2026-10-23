// Pointing-device firmware vs. hardware: Sval POINTING_HARDWARE (0x2C).
//
// Up to vLaunch2, each pointing module (trackball, Azoteq trackpad, TrackPoint)
// needs its own firmware, PMW3360 and PMW3389 trackballs need different firmware,
// and the wrong one leaves the module dead with no other sign. From vNext1 the
// plain left and right builds drive whichever module answers at startup (flag
// bit 3). Svalboard QMK reports, for each half, its side, the module its firmware
// drives and the module that answered, so Keybard can name the .uf2 that fixes it,
// or, on a build that drives any module, say the module wasn't picked up.
//
// Reply after the wrapper: [0x2C] [format = 1] [USB half: 5 bytes] [other half: 5 bytes]
// Each half: [flags] [built_for] [detected] [id0] [id1]
//   flags: bit 0 reported, bit 1 left half, bit 2 the module's driver started,
//          bit 3 the build drives whichever module is attached,
//          bit 5 the half has no side yet (one-image firmware): bit 1 means nothing
//   built_for: 0 no pointing module, 1 PMW3360, 2 PMW3389, 5 Azoteq, 6 TrackPoint
//              (on a bit-3 build, the module it chose at startup; 0 when none answered)
//   detected: 0 not checked yet, 1 PMW3360, 2 PMW3389, 3 no module answered,
//             4 the trackball bus answered with another ID, 5 Azoteq, 6 TrackPoint
//   ids: PMW Product_ID / Inverse_Product_ID, Azoteq product number, or PS/2 device ID
// Documented in svalboard/qmk keyboards/svalboard/docs/protocol.md.

/** GET_INFO second feature byte: the board answers POINTING_HARDWARE (0x2C). */
export const SVIL_FLAG2_POINTING_HARDWARE = 0x02;

export type TrackballSensor = "pmw3360" | "pmw3389";
export type PointingModule = TrackballSensor | "azoteq" | "trackpoint";
export type Side = "left" | "right";

export interface PointingHalfReport {
    /** The half plugged into the computer (it answers for both). */
    usb: boolean;
    side: Side;
    /** The module this half's firmware drives; "none" for a build without one. */
    builtFor: PointingModule | "none";
    /** What answered: a module, "none" (nothing), "unknown" (another trackball ID), or null (not checked yet). */
    detected: PointingModule | "none" | "unknown" | null;
    sensorStarted: boolean;
    /** The build drives whichever module answers at startup, so builtFor is the one it chose. */
    auto: boolean;
    /** One-image firmware: the half has no side yet, so `side` means nothing. Not drawn as a hand. */
    noSide?: boolean;
    productId: number;
    inverseProductId: number;
}

export interface PointingHardwareReport {
    /** The halves that reported: the USB half first, then the other half when it answered. */
    halves: PointingHalfReport[];
}

const FLAG_REPORTED = 0x01;
const FLAG_LEFT = 0x02;
const FLAG_INIT_OK = 0x04;
const FLAG_AUTO = 0x08;
const FLAG_NO_SIDE = 0x20;
const BLOCK_SIZE = 5;

const MODULES: Record<number, PointingModule> = { 1: "pmw3360", 2: "pmw3389", 5: "azoteq", 6: "trackpoint" };

function parseHalf(bytes: Uint8Array, offset: number, usb: boolean): PointingHalfReport | null {
    if (bytes.length < offset + BLOCK_SIZE) return null;
    const flags = bytes[offset];
    if (!(flags & FLAG_REPORTED)) return null;
    const detectedCode = bytes[offset + 2];
    return {
        usb,
        side: flags & FLAG_LEFT ? "left" : "right",
        builtFor: MODULES[bytes[offset + 1]] ?? "none",
        detected: MODULES[detectedCode] ?? (detectedCode === 3 ? "none" : detectedCode === 4 ? "unknown" : null),
        sensorStarted: (flags & FLAG_INIT_OK) !== 0,
        auto: (flags & FLAG_AUTO) !== 0,
        ...((flags & FLAG_NO_SIDE) !== 0 ? { noSide: true } : {}),
        productId: bytes[offset + 3],
        inverseProductId: bytes[offset + 4],
    };
}

/** Parses a POINTING_HARDWARE reply (command echo first). Null when it has nothing to report. */
export function parsePointingHardware(reply: Uint8Array, cmd = 0x2c): PointingHardwareReport | null {
    if (reply.length < 2 || reply[0] !== cmd || reply[1] !== 1) return null;
    // A half with no side has no hand to draw: leave it out.
    const halves = [parseHalf(reply, 2, true), parseHalf(reply, 2 + BLOCK_SIZE, false)].filter(
        (h): h is PointingHalfReport => h !== null && !h.noSide,
    );
    return halves.length ? { halves } : null;
}

export const MODULE_NAMES: Record<PointingModule, string> = {
    pmw3360: "PMW3360 trackball",
    pmw3389: "PMW3389 trackball",
    azoteq: "Azoteq trackpad",
    trackpoint: "TrackPoint",
};

export const isTrackball = (module: PointingModule | "none"): module is TrackballSensor =>
    module === "pmw3360" || module === "pmw3389";

/**
 * The release asset for a half with this module (or none), as svalboard/qmk names them.
 * A board that reports no bit-3 build runs vLaunch2 or older, and the release Keybard
 * links to (LATEST_FIRMWARE_RELEASE) still has one image per module. Once the latest
 * release has only the plain left and right images, which drive any module, name
 * svalboard_<side>_sval_<release>.uf2 for every module.
 */
export function firmwareFile(module: PointingModule | "none", side: Side): string {
    if (module === "none") return `svalboard_${side}_sval_<release>.uf2`;
    if (isTrackball(module)) return `svalboard_trackball_${module}_${side}_sval_<release>.uf2`;
    return `svalboard_${module}_${side}_sval_<release>.uf2`;
}

export type PointingProblem =
    | { kind: "wrong-module"; half: PointingHalfReport; builtFor: PointingModule | "none"; actual: PointingModule; file: string }
    | { kind: "no-module"; half: PointingHalfReport; builtFor: PointingModule; file: string }
    | { kind: "unknown-sensor"; half: PointingHalfReport; builtFor: TrackballSensor }
    /** A build that drives any module started without the one that answers now. */
    | { kind: "not-picked-up"; half: PointingHalfReport; actual: PointingModule };

/** What's wrong with the firmware on each half, if anything. */
export function findPointingProblems(report: PointingHardwareReport | null | undefined): PointingProblem[] {
    if (!report) return [];
    const problems: PointingProblem[] = [];
    for (const half of report.halves) {
        const { builtFor, detected } = half;
        if (detected === null) continue;
        if (half.auto) {
            if (detected !== "none" && detected !== "unknown" && detected !== builtFor)
                problems.push({ kind: "not-picked-up", half, actual: detected });
            continue;
        }
        if (detected === "none") {
            if (builtFor !== "none") problems.push({ kind: "no-module", half, builtFor, file: firmwareFile("none", half.side) });
        } else if (detected === "unknown") {
            if (isTrackball(builtFor) && !half.sensorStarted) problems.push({ kind: "unknown-sensor", half, builtFor });
        } else if (detected !== builtFor) {
            problems.push({ kind: "wrong-module", half, builtFor, actual: detected, file: firmwareFile(detected, half.side) });
        }
    }
    return problems;
}

/**
 * Both halves have reported and finished checking for a module. Firmware that
 * retries its probe can still turn "none" into a module later; the late
 * detection poller (pointing-detect.service) keeps asking in that case.
 */
export function isPointingReportSettled(report: PointingHardwareReport | null | undefined): boolean {
    return !!report && report.halves.length === 2 && report.halves.every((h) => h.detected !== null);
}

/** What one half has attached, for display. */
export interface PointingHalfSummary {
    side: Side;
    /** The module attached, "none", "unknown" (an unrecognized trackball sensor), "checking", or "silent" (the half hasn't reported). */
    module: PointingModule | "none" | "unknown" | "checking" | "silent";
    usb: boolean;
    /** The half's firmware drives what's attached (always true while checking or silent). */
    firmwareMatches: boolean;
}

/** One summary per side, left then right. Both halves claiming one side are listed as they reported. */
export function summarizePointingHardware(report: PointingHardwareReport | null | undefined): PointingHalfSummary[] {
    const summarize = (half: PointingHalfReport): PointingHalfSummary => {
        const module = half.detected ?? "checking";
        const firmwareMatches = module === "checking" || module === "unknown" ? true : module === half.builtFor;
        return { side: half.side, module, usb: half.usb, firmwareMatches };
    };
    const halves = report?.halves ?? [];
    if (halves.length === 2 && halves[0].side === halves[1].side) return halves.map(summarize);
    return (["left", "right"] as const).map((side) => {
        const half = halves.find((h) => h.side === side);
        return half ? summarize(half) : { side, module: "silent", usb: false, firmwareMatches: true };
    });
}
