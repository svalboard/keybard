// Touchpad tuning (svalboard/qmk docs/protocol.md "Touchpad tuning" and
// "Touchpad touch").
//
// Firmware with GET_INFO byte 20 bit 5 stores the dead zone a tap or a press
// and hold must stay inside, the tap time and the two-finger scroll distance
// (VIA values 55-57, physical units), next to the tap switches and hold time
// (51-54). Firmware with bit 6 also answers the touch page of POINTING_MOTION
// (0x2D page 1): each pad's touch as the chip's tap and press-and-hold rules
// see it, which the tuning view draws live.

/** GET_INFO byte 20 (feature_flags3) bit 5: VIA values 55-57. */
export const SVIL_FLAG3_PAD_TUNING = 0x20;
/** GET_INFO byte 20 bit 6: the touch page of 0x2D. */
export const SVIL_FLAG3_PAD_TOUCH = 0x40;

export const PAD_DEAD_ZONE_KEY = "id_pad_dead_zone";
export const PAD_TAP_MS_KEY = "id_pad_tap_ms";
export const PAD_SCROLL_KEY = "id_pad_scroll_start";
/**
 * VIA value 59 (GET_INFO byte 21 bit 1): the touchpad mode. Automatic (0, the
 * default and what ships): a touchpad whenever Windows or Linux asks for one.
 * Built-in gestures (1): the chip's own taps and scrolling even then, as on a
 * Mac or in a BIOS.
 */
export const PAD_MODE_KEY = "id_pad_touchpad_mode";
export const PAD_MODE_AUTO = 0;
export const PAD_MODE_BUILTIN = 1;
export const PAD_MODE_LABELS = ["Automatic", "Built-in gestures"] as const;
export const SVIL_FLAG4_PAD_MODE = 0x02;
export const hasPadMode = (flags4: number | undefined | null): boolean => ((flags4 ?? 0) & SVIL_FLAG4_PAD_MODE) !== 0;
/**
 * Board values that belong to the computer the board is plugged into, not to
 * the layout: never exported to a .svil and never imported from one. The
 * touchpad mode is chosen per computer (touchpad mode on Windows and Linux,
 * built-in gestures for a Mac or by choice), and switching it on import would
 * skip its confirmation.
 */
export const NOT_LAYOUT_VALUES: readonly string[] = [PAD_MODE_KEY];
/** VIA value 58 (GET_INFO byte 21 bit 0): the palm rejection, an area in the chip's channels; 0 off. */
export const PAD_PALM_KEY = "id_pad_palm";
export const PAD_TUNING_KEYS = [PAD_DEAD_ZONE_KEY, PAD_TAP_MS_KEY, PAD_SCROLL_KEY, PAD_PALM_KEY] as const;
/** The menu entry that opens the tuning view (an app action, not a value). */
export const TUNE_TOUCHPAD_ACTION = "app:touchpad-tuning";
export const TUNE_TOUCHPAD_LABEL = "Tune touchpad…";

/** The values the board stores (pad_gestures.c), each default first; a write takes the nearest. */
export const PAD_DEAD_ZONE_MM100 = [120, 20, 30, 40, 50, 60, 70, 80, 90, 100, 140, 160, 200, 250, 300, 400] as const;
export const PAD_TAP_MS = [150, 50, 75, 100, 125, 175, 200, 225, 250, 300, 350, 400, 500, 600, 800, 1000] as const;
/** 0 is the build's own (50 chip pixels; 1.05 mm on the native touchpad). */
export const PAD_SCROLL_MM100 = [0, 30, 50, 75, 100, 125, 150, 175, 200, 250, 300, 400, 500, 600, 800, 1000] as const;
export const PAD_DEAD_ZONE_DEFAULT = PAD_DEAD_ZONE_MM100[0];
export const PAD_TAP_DEFAULT_MS = PAD_TAP_MS[0];
/** The TPS43 pad, 0.01 mm. */
export const PAD_WIDTH_MM100 = 4300;
export const PAD_HEIGHT_MM100 = 4000;

export const hasPadTuning = (flags3: number | undefined | null): boolean => ((flags3 ?? 0) & SVIL_FLAG3_PAD_TUNING) !== 0;
export const hasPadTouch = (flags3: number | undefined | null): boolean => ((flags3 ?? 0) & SVIL_FLAG3_PAD_TOUCH) !== 0;

/** The table's values in rising order (the default sits where it belongs). */
export function steps(table: readonly number[]): number[] {
    return [...table].sort((a, b) => a - b);
}

/** The nearest stored value (a tie takes the smaller), as the board picks it. */
export function nearest(table: readonly number[], v: number): number {
    let best = table[0];
    for (const t of table) {
        const d = Math.abs(t - v), b = Math.abs(best - v);
        if (d < b || (d === b && t < best)) best = t;
    }
    return best;
}

/** 0.01 mm as "0.8 mm". */
export function formatMm(mm100: number): string {
    return `${(mm100 / 100).toFixed(mm100 % 10 === 0 ? (mm100 % 100 === 0 ? 0 : 1) : 2)} mm`;
}

// ---------------------------------------------------------------- the touch page

export const TOUCH_EV = {
    down: 0x01, up: 0x02, tap: 0x04, twoTap: 0x08, hold: 0x10, scroll: 0x20, drift: 0x40, other: 0x80,
} as const;

export interface PadTouchBlock {
    valid: boolean;
    down: boolean;
    /** The computer has this pad as a touchpad: its clicks are the computer's, not the chip's. */
    os: boolean;
    outside: boolean;
    fingers: number;
    holding: boolean;
    events: number;
    /** 0.01 mm, in the pad's own orientation. */
    x: number;
    y: number;
    downX: number;
    downY: number;
    /** ms since touch-down while down; the last touch's length after it lifts. */
    ms: number;
    /** The farthest this touch has been from its down point, 0.01 mm. */
    farthest: number;
    tapPx: number;
    /** The first finger's touch strength (sum of its channel deltas) and area (channels); 0 when not reported or no finger. */
    strength: number;
    area: number;
}

export interface PadTouchReport {
    tapOn: boolean;
    twoFingerOn: boolean;
    holdOn: boolean;
    elapsedMs: number;
    deadZone: number;
    tapMs: number;
    holdMs: number;
    width: number;
    height: number;
    scrollStart: number;
    /** The channel grid the area counts in (0 when the firmware reports no finger size). */
    channelsX: number;
    channelsY: number;
    left: PadTouchBlock;
    right: PadTouchBlock;
    /** Every finger on each pad (the fingers page, page 2), when the firmware has it and the read worked. */
    fingers?: PadFingersReport | null;
}

export const PAD_TOUCH_PAGE = 1;
export const PAD_TOUCH_FORMAT = 2;
const PAGE_BYTES = 48;
/** Firmware with finger sizes sends 56 (bytes 48-55). */
const SIZED_PAGE_BYTES = 56;

function block(view: DataView, o: number): PadTouchBlock {
    const f = view.getUint8(o);
    const u16 = (k: number) => view.getUint16(o + k, true);
    return {
        valid: (f & 0x01) !== 0, down: (f & 0x02) !== 0, os: (f & 0x04) !== 0, outside: (f & 0x08) !== 0,
        fingers: (f >> 4) & 7, holding: (f & 0x80) !== 0, events: view.getUint8(o + 1),
        x: u16(2), y: u16(4), downX: u16(6), downY: u16(8), ms: u16(10), farthest: u16(12), tapPx: u16(14),
        strength: 0, area: 0,
    };
}

/** The reply to DF 2D <reader> 01, from the command byte on. Null for anything but format 2. */
export function parsePadTouch(reply: Uint8Array | null | undefined, cmd = 0x2d): PadTouchReport | null {
    if (!reply || reply.length < 1 + PAGE_BYTES || reply[0] !== cmd || reply[1] !== PAD_TOUCH_FORMAT) return null;
    const sized = reply.length >= 1 + SIZED_PAGE_BYTES && (reply[1 + 3] & 1) !== 0;
    const view = new DataView(reply.buffer, reply.byteOffset + 1, sized ? SIZED_PAGE_BYTES : PAGE_BYTES);
    const u16 = (k: number) => view.getUint16(k, true);
    const on = view.getUint8(1);
    const left = block(view, 14), right = block(view, 30);
    if (sized) {
        if (left.valid) Object.assign(left, { strength: u16(48), area: view.getUint8(50) });
        if (right.valid) Object.assign(right, { strength: u16(51), area: view.getUint8(53) });
    }
    return {
        tapOn: (on & 1) !== 0, twoFingerOn: (on & 2) !== 0, holdOn: (on & 4) !== 0,
        elapsedMs: view.getUint8(2), deadZone: u16(4), tapMs: u16(6), holdMs: u16(8),
        width: u16(10) || PAD_WIDTH_MM100, height: u16(12) || PAD_HEIGHT_MM100, scrollStart: u16(46),
        channelsX: sized ? view.getUint8(54) : 0, channelsY: sized ? view.getUint8(55) : 0,
        left, right,
    };
}

/** The 48 bytes of a touch page (for the simulated board and tests). */
export function packPadTouch(r: PadTouchReport): Uint8Array {
    const out = new Uint8Array(SIZED_PAGE_BYTES);
    const view = new DataView(out.buffer);
    const u16 = (k: number, v: number) => view.setUint16(k, Math.max(0, Math.min(0xffff, Math.round(v))), true);
    out[0] = PAD_TOUCH_FORMAT;
    out[1] = (r.tapOn ? 1 : 0) | (r.twoFingerOn ? 2 : 0) | (r.holdOn ? 4 : 0);
    out[2] = Math.min(255, r.elapsedMs);
    if (r.channelsX) { out[3] = 1; out[54] = r.channelsX; out[55] = r.channelsY; }
    u16(4, r.deadZone); u16(6, r.tapMs); u16(8, r.holdMs); u16(10, r.width); u16(12, r.height); u16(46, r.scrollStart);
    for (const [o, b] of [[14, r.left], [30, r.right]] as const) {
        if (!b.valid) continue;
        out[o] = 0x01 | (b.down ? 0x02 : 0) | (b.os ? 0x04 : 0) | (b.outside ? 0x08 : 0) | ((b.fingers & 7) << 4) | (b.holding ? 0x80 : 0);
        out[o + 1] = b.events;
        u16(o + 2, b.x); u16(o + 4, b.y); u16(o + 6, b.downX); u16(o + 8, b.downY); u16(o + 10, b.ms); u16(o + 12, b.farthest); u16(o + 14, b.tapPx);
        if (r.channelsX) { const k = o === 14 ? 48 : 51; u16(k, b.strength); out[k + 2] = b.area; }
    }
    return out;
}

export const EMPTY_BLOCK: PadTouchBlock = {
    valid: false, down: false, os: false, outside: false, fingers: 0, holding: false, events: 0,
    x: 0, y: 0, downX: 0, downY: 0, ms: 0, farthest: 0, tapPx: 0, strength: 0, area: 0,
};

/**
 * The radius of a circle with the finger's reported footprint, 0.01 mm: its
 * area in channels times one channel's size. 0 when the firmware reports none.
 */
export function contactRadius(area: number, r: Pick<PadTouchReport, "width" | "height" | "channelsX" | "channelsY">): number {
    if (!area || !r.channelsX || !r.channelsY) return 0;
    const cell = (r.width / r.channelsX) * (r.height / r.channelsY);
    return Math.round(Math.sqrt((area * cell) / Math.PI));
}

// ---------------------------------------------------------------- the fingers page

/** GET_INFO byte 20 bit 7: the fingers page of 0x2D (page 2), every finger on each pad. */
export const SVIL_FLAG3_PAD_FINGERS = 0x80;
/** GET_INFO byte 21 (feature_flags4) bit 0: VIA value 58, the palm rejection. */
export const SVIL_FLAG4_PAD_PALM = 0x01;
export const hasPadFingers = (flags3: number | undefined | null): boolean => ((flags3 ?? 0) & SVIL_FLAG3_PAD_FINGERS) !== 0;
export const hasPadPalm = (flags4: number | undefined | null): boolean => ((flags4 ?? 0) & SVIL_FLAG4_PAD_PALM) !== 0;

/**
 * The palm thresholds offered, in the chip's channels (about 5.4 x 5.7 mm each
 * on the TPS43); 0 is off, the default. The board stores any 0-56.
 */
export const PAD_PALM_CHANNELS = [0, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20, 24, 30, 40] as const;
/** A threshold in plain words. */
export function formatPalm(channels: number): string {
    return channels ? `over ${channels} channels` : "Off";
}

export const PAD_FINGERS_PAGE = 2;
export const PAD_FINGERS_FORMAT = 1;
const FINGERS_PAGE_BYTES = 56;
const FINGERS_BLOCK_BYTES = 27;

export interface PadFinger {
    /** The chip's slot: a finger keeps it while it is down. */
    slot: number;
    /** 0.01 mm, in the pad's own orientation (0.02 mm steps). */
    x: number;
    y: number;
    /** Channels the finger covers. */
    area: number;
}

export interface PadFingersBlock {
    valid: boolean;
    /** The computer has this pad as a touchpad: its taps and scrolling are the computer's. */
    os: boolean;
    /** The chip's own palm detect, and more fingers than it reports. */
    chipPalm: boolean;
    tooMany: boolean;
    /** A two-finger touch is live: two fingers, and only two, since the second landed. */
    two: boolean;
    /** The chip started a scroll during that two-finger touch. */
    scrolled: boolean;
    /** The chip reported a two-finger tap since the last read. */
    twoTap: boolean;
    /** The two-finger numbers below hold a touch (the live one, or the last). */
    hadTwo: boolean;
    fingers: PadFinger[];
    /** Where the two fingers' centroid was when the second landed, 0.01 mm. */
    startX: number;
    startY: number;
    /** The two fingers' average travel since then, 0.01 mm: what the chip compares with the scroll start. */
    travel: number;
    /** ms since the second finger landed (or how long the two-finger touch lasted). */
    twoMs: number;
}

export interface PadFingersReport {
    /** The palm rejection threshold in force, channels; 0 off. */
    palm: number;
    left: PadFingersBlock;
    right: PadFingersBlock;
}

export const EMPTY_FINGERS: PadFingersBlock = {
    valid: false, os: false, chipPalm: false, tooMany: false, two: false, scrolled: false, twoTap: false, hadTwo: false,
    fingers: [], startX: 0, startY: 0, travel: 0, twoMs: 0,
};

const getPos = (b: Uint8Array, o: number) => {
    const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    return { x: (v & 0xfff) * 2, y: ((v >> 12) & 0xfff) * 2 };
};
const setPos = (b: Uint8Array, o: number, x: number, y: number) => {
    const c = (n: number) => Math.max(0, Math.min(0xfff, Math.round(n / 2)));
    const v = c(x) | (c(y) << 12);
    b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = (v >> 16) & 0xff;
};

function fingersBlock(b: Uint8Array, o: number): PadFingersBlock {
    const f = b[o];
    if (!(f & 0x01)) return EMPTY_FINGERS;
    const mask = b[o + 1];
    const fingers: PadFinger[] = [];
    for (let slot = 0; slot < 5; slot++) {
        if (!(mask & (1 << slot))) continue;
        fingers.push({ slot, ...getPos(b, o + 2 + 4 * slot), area: b[o + 5 + 4 * slot] });
    }
    const start = getPos(b, o + 22);
    return {
        valid: true, os: (f & 0x02) !== 0, chipPalm: (f & 0x04) !== 0, tooMany: (f & 0x08) !== 0, two: (f & 0x10) !== 0,
        scrolled: (f & 0x20) !== 0, twoTap: (f & 0x40) !== 0, hadTwo: (f & 0x80) !== 0, fingers,
        startX: start.x, startY: start.y, travel: b[o + 25] * 5, twoMs: b[o + 26] * 4,
    };
}

/** The reply to DF 2D <reader> 02, from the command byte on. Null for anything but format 1 of this page. */
export function parsePadFingers(reply: Uint8Array | null | undefined, cmd = 0x2d): PadFingersReport | null {
    if (!reply || reply.length < 1 + FINGERS_PAGE_BYTES || reply[0] !== cmd || reply[1] !== PAD_FINGERS_FORMAT) return null;
    const b = reply.subarray(1, 1 + FINGERS_PAGE_BYTES);
    return { palm: b[1], left: fingersBlock(b, 2), right: fingersBlock(b, 2 + FINGERS_BLOCK_BYTES) };
}

/** The 56 bytes of a fingers page (for the simulated board and tests). */
export function packPadFingers(r: PadFingersReport): Uint8Array {
    const out = new Uint8Array(FINGERS_PAGE_BYTES);
    out[0] = PAD_FINGERS_FORMAT;
    out[1] = r.palm;
    for (const [o, f] of [[2, r.left], [2 + FINGERS_BLOCK_BYTES, r.right]] as const) {
        if (!f.valid) continue;
        out[o] = 0x01 | (f.os ? 0x02 : 0) | (f.chipPalm ? 0x04 : 0) | (f.tooMany ? 0x08 : 0) | (f.two ? 0x10 : 0)
            | (f.scrolled ? 0x20 : 0) | (f.twoTap ? 0x40 : 0) | (f.hadTwo ? 0x80 : 0);
        for (const p of f.fingers) {
            out[o + 1] |= 1 << p.slot;
            setPos(out, o + 2 + 4 * p.slot, p.x, p.y);
            out[o + 5 + 4 * p.slot] = p.area;
        }
        if (f.hadTwo) {
            setPos(out, o + 22, f.startX, f.startY);
            out[o + 25] = Math.min(255, Math.round(f.travel / 5));
            out[o + 26] = Math.min(255, Math.floor(f.twoMs / 4));
        }
    }
    return out;
}

/** A finger of this area is a palm under this threshold (0: off). */
export const isPalm = (palm: number, area: number): boolean => palm > 0 && area > palm;

// ---------------------------------------------------------------- one touch's outcome

export type TouchOutcomeKind = "tap" | "right" | "hold" | "canceled" | "late" | "short" | "moved" | "scroll" | "palm" | "multi" | "touch";

export interface TouchOutcome {
    kind: TouchOutcomeKind;
    /** Plain words for the list under the pad. */
    text: string;
    /** The computer had the pad as a touchpad: the text gives only the fingers (and a palm). */
    os: boolean;
    /** How long the touch lasted and how far it went from its down point. */
    ms: number;
    farthest: number;
    /** Where it began and ended, 0.01 mm. */
    downX: number;
    downY: number;
    x: number;
    y: number;
}

/** What the fingers page added to a touch, from touch-down to the lift. */
export interface MultiTouch {
    /** The most fingers down at once. */
    maxFingers: number;
    /** A two-finger touch happened, and how far its fingers went on average (0.01 mm). */
    hadTwo: boolean;
    maxTravel: number;
    /** The average travel when the chip's scroll first showed; 0: it never scrolled. */
    scrolledAt: number;
    twoTap: boolean;
    /** The largest finger, and whether it went over the palm threshold. */
    maxArea: number;
    palm: number;
    scrollStart: number;
    deadZone: number;
}

const COUNT = ["no", "one", "two", "three", "four", "five"];
const fingersWord = (n: number) => `${COUNT[n] ?? n} finger${n === 1 ? "" : "s"}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function outcome(events: number, maxFingers: number, b: PadTouchBlock,
    s: Pick<PadTouchReport, "tapMs" | "holdMs" | "holdOn" | "tapOn" | "twoFingerOn">, multi?: MultiTouch): TouchOutcome {
    const base = { os: b.os, ms: b.ms, farthest: b.farthest, downX: b.downX, downY: b.downY, x: b.x, y: b.y };
    const say = (kind: TouchOutcomeKind, text: string): TouchOutcome => ({ kind, text, ...base });
    const sec = `${b.ms} ms`;
    const moved = formatMm(b.farthest);
    const holdAt = s.tapMs + s.holdMs;
    // Palm rejection is the firmware's, in both modes: said plainly, never as the chip's.
    if (multi && isPalm(multi.palm, multi.maxArea)) {
        const what = b.os ? "the computer ignores it" : "the pad ignored it";
        return { kind: "palm", text: `Palm: ${multi.maxArea} channels, over ${multi.palm}: ${what} (${sec})`, ...base };
    }
    const fingers = Math.max(maxFingers, multi?.maxFingers ?? 0, 1);
    // Touchpad mode: the computer makes the taps and scrolls, so a touch is its fingers and how long it lasted.
    if (b.os) return { kind: "touch", text: `${capital(fingersWord(fingers))}, ${sec}`, ...base };
    if (multi && fingers >= 3) return say("multi", `${capital(fingersWord(fingers))}: no tap or scroll on the chip (${sec})`);
    if (multi?.twoTap || (events & TOUCH_EV.twoTap)) {
        return say("right", multi ? `Two-finger tap ✓ right click, ${sec}` : `Right click: two fingers, ${sec}`);
    }
    if (multi?.scrolledAt) return say("scroll", `Two-finger scroll: started after ${formatMm(multi.scrolledAt)} (scroll start ${formatMm(multi.scrollStart)})`);
    if (multi?.hadTwo) {
        const why = !s.twoFingerOn ? "two-finger tap is off" : b.ms >= s.tapMs ? `lifted at ${sec}, past the ${s.tapMs} ms tap time` : `a finger left the ${formatMm(multi.deadZone)} dead zone`;
        return say("short", `Two fingers, no click: moved ${formatMm(multi.maxTravel)} of the ${formatMm(multi.scrollStart)} scroll start; ${why}`);
    }
    if (events & TOUCH_EV.hold) return say("hold", `Press and hold at ${holdAt} ms, released at the lift (${sec})`);
    if (events & TOUCH_EV.tap) return say("tap", `Tap: ${sec}, moved ${moved}`);
    if (events & TOUCH_EV.scroll) return say("scroll", `Scroll: two fingers, ${sec}`);
    if (events & TOUCH_EV.drift) return say("canceled", `Canceled: moved ${moved}, out of the dead zone (${sec})`);
    if (fingers >= 2) return say("short", s.twoFingerOn ? `No click: two fingers, ${sec}` : `No click: two-finger tap is off (${sec})`);
    if (b.ms < s.tapMs) return say("short", s.tapOn ? `No click: ${sec}, moved ${moved}` : `No click: tap to click is off (${sec})`);
    if (!s.holdOn) return say("late", `No click: ${sec} is past the ${s.tapMs} ms tap time, and press and hold is off`);
    if (b.ms >= holdAt) return say("moved", `No click: moved ${moved} (a pointer move, ${sec})`);
    return say("late", `No click: lifted at ${sec}, after the ${s.tapMs} ms tap time and before the ${holdAt} ms hold`);
}

type TrackSettings = Pick<PadTouchReport, "tapMs" | "holdMs" | "holdOn" | "tapOn" | "twoFingerOn" | "scrollStart" | "deadZone">;

/**
 * Follows one pad across reads and tells, for each touch that ends, what the
 * chip made of it and why. The chip's own events decide clicks; the dead zone
 * cancel is the firmware's reading of the chip's rule (bit 6). With the
 * fingers page it also follows every finger: the two-finger touch, the
 * chip's scroll and two-finger tap, and palms.
 */
export class TouchTracker {
    private open = false;
    private events = 0;
    private maxFingers = 0;
    private last: PadTouchBlock = EMPTY_BLOCK;
    private multi: MultiTouch | null = null;
    /** The touch now, while a finger is down. */
    current: PadTouchBlock | null = null;
    /** Events of the touch now (or the last one), for the marks on the pad. */
    touchEvents = 0;
    /** Where the touch now (or the last one) has been, 0.01 mm, as read. */
    trail: { x: number; y: number }[] = [];
    /** Every finger now (or at the last read of the last touch), and the two-finger state. */
    fingers: PadFingersBlock = EMPTY_FINGERS;
    /** Where the two fingers' centroid has been since the second landed, 0.01 mm. */
    twoTrail: { x: number; y: number }[] = [];
    /** The touch now (or the last one): the most fingers, the two-finger numbers, the largest finger. */
    get touch(): MultiTouch | null {
        return this.multi;
    }

    private begin(b: PadTouchBlock, s: TrackSettings, palm: number) {
        this.open = true;
        this.events = 0;
        this.maxFingers = 0;
        this.trail = [{ x: b.downX, y: b.downY }];
        this.twoTrail = [];
        this.multi = { maxFingers: 0, hadTwo: false, maxTravel: 0, scrolledAt: 0, twoTap: false, maxArea: 0, palm, scrollStart: s.scrollStart, deadZone: s.deadZone };
    }

    take(b: PadTouchBlock, settings: TrackSettings | Pick<PadTouchReport, "tapMs" | "holdMs" | "holdOn" | "tapOn" | "twoFingerOn">,
        f?: PadFingersBlock | null, palm = 0): TouchOutcome | null {
        const s: TrackSettings = { scrollStart: 0, deadZone: 0, ...settings };
        if (!b.valid) { this.current = null; this.open = false; this.fingers = EMPTY_FINGERS; return null; }
        if (b.events & TOUCH_EV.down) this.begin(b, s, palm);
        if (!this.open && b.down) this.begin(b, s, palm);
        if (this.open && this.trail.length < 400) this.trail = [...this.trail, { x: b.x, y: b.y }];
        if (this.open) {
            this.events |= b.events;
            this.maxFingers = Math.max(this.maxFingers, b.fingers);
        }
        const m = this.multi;
        if (f?.valid && m) {
            if (this.open || f.twoTap) {
                m.palm = palm;
                m.scrollStart = s.scrollStart;
                m.maxFingers = Math.max(m.maxFingers, f.fingers.length);
                for (const p of f.fingers) m.maxArea = Math.max(m.maxArea, p.area);
                if (f.twoTap) m.twoTap = true;
                if (f.hadTwo && (f.two || m.hadTwo)) {
                    m.hadTwo = true;
                    m.maxTravel = Math.max(m.maxTravel, f.travel);
                    if (f.scrolled && !m.scrolledAt) m.scrolledAt = Math.max(f.travel, 1);
                }
                if (f.two && this.twoTrail.length < 400) {
                    const [a, c] = f.fingers;
                    if (a && c) this.twoTrail = [...this.twoTrail, { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }];
                }
            }
            this.fingers = f;
        } else if (!f) {
            this.fingers = EMPTY_FINGERS;
        }
        this.touchEvents = this.events;
        this.last = b;
        this.current = b.down ? b : null;
        if (!this.open || b.down) return null;
        this.open = false;
        return outcome(this.events, this.maxFingers, b, s, f?.valid && m ? m : undefined);
    }

    get latest(): PadTouchBlock {
        return this.last;
    }
}

// ---------------------------------------------------------------- a chip model

export interface ChipSettings {
    deadZone: number; // 0.01 mm
    tapMs: number;
    holdMs: number;
    tapOn: boolean;
    twoFingerOn: boolean;
    holdOn: boolean;
    /** The scroll start, 0.01 mm (105: the build's own on the native touchpad). */
    scrollStart?: number;
}

/** One finger in a sample: its slot, position (0.01 mm) and area (channels). */
export interface TouchPoint { slot: number; x: number; y: number; area?: number }

/**
 * One sample: time, the first finger's position in 0.01 mm, fingers down, and
 * every finger (points). Without points, a second finger stands 15 mm to the
 * right of the first.
 */
export interface TouchSample { t: number; x: number; y: number; fingers: number; strength?: number; area?: number; points?: TouchPoint[] }

const DEFAULT_SCROLL = 105;

/**
 * The chip's rules (IQS5xx-B000 datasheet 6.1-6.7), for the simulated board:
 * a tap lifts within the tap time inside the dead zone; press and hold fires
 * at tap time + hold time inside it; leaving the dead zone while either could
 * still fire cancels both. Two fingers: a two-finger touch starts when a
 * second lands beside one and lasts while the same two, and only two, stay
 * down; it scrolls once their average travel passes the scroll start, and is
 * a two-finger tap when both lift within the tap time, each inside the dead
 * zone.
 */
export class ChipModel {
    private block: PadTouchBlock = { ...EMPTY_BLOCK, valid: true };
    private t0 = 0;
    private maxFingers = 0;
    private f: PadFingersBlock = { ...EMPTY_FINGERS, valid: true };
    private prevN = 0;
    private twoAt = 0;
    private twoSlots: number[] = [];
    private starts = new Map<number, { x: number; y: number; t: number; far: number }>();
    private twoBroken = false;
    private lastPoints: TouchPoint[] = [];

    constructor(private settings: () => ChipSettings) {}

    private points(s: TouchSample): TouchPoint[] {
        if (s.points) return s.points;
        if (s.fingers <= 0) return [];
        const out: TouchPoint[] = [{ slot: 0, x: s.x, y: s.y, area: s.area }];
        for (let i = 1; i < s.fingers; i++) out.push({ slot: i, x: s.x + 1500 * i, y: s.y, area: s.area });
        return out;
    }

    sample(s: TouchSample): void {
        const cfg = this.settings();
        const b = this.block;
        const pts = this.points(s);
        const n = pts.length;
        if (n > 0 && !b.down) {
            Object.assign(b, { down: true, outside: false, holding: false, farthest: 0, downX: s.x, downY: s.y, x: s.x, y: s.y });
            this.t0 = s.t;
            this.maxFingers = 0;
            this.twoBroken = false;
            this.starts.clear();
            Object.assign(this.f, { hadTwo: false, two: false, scrolled: false, travel: 0, twoMs: 0 });
            b.events |= TOUCH_EV.down;
        }
        // Each finger's own start and farthest travel (for the two-finger tap).
        for (const p of pts) {
            const st = this.starts.get(p.slot);
            if (!st) this.starts.set(p.slot, { x: p.x, y: p.y, t: s.t, far: 0 });
            else st.far = Math.max(st.far, Math.hypot(p.x - st.x, p.y - st.y));
        }
        for (const slot of [...this.starts.keys()]) if (!pts.some((p) => p.slot === slot) && n > 0) this.starts.delete(slot);
        // The two-finger touch.
        if (n === 2 && this.prevN < 2) {
            Object.assign(this.f, { two: true, hadTwo: true, scrolled: false, travel: 0, twoMs: 0 });
            this.twoAt = s.t;
            this.twoSlots = pts.map((p) => p.slot);
            this.f.startX = Math.round((pts[0].x + pts[1].x) / 2);
            this.f.startY = Math.round((pts[0].y + pts[1].y) / 2);
            for (const p of pts) this.starts.set(p.slot, { ...(this.starts.get(p.slot) ?? { t: s.t, far: 0 }), x: p.x, y: p.y });
        } else if (this.f.two && (n !== 2 || pts.some((p) => !this.twoSlots.includes(p.slot)))) {
            this.f.two = false;
            if (n > 2) this.twoBroken = true;
        }
        if (n > 2) this.twoBroken = true;
        if (this.f.two) {
            const travel = pts.reduce((sum, p) => { const st = this.starts.get(p.slot)!; return sum + Math.hypot(p.x - st.x, p.y - st.y); }, 0) / 2;
            this.f.travel = Math.round(travel);
            this.f.twoMs = s.t - this.twoAt;
            if (!this.f.scrolled && travel > (cfg.scrollStart || DEFAULT_SCROLL)) {
                this.f.scrolled = true;
                b.events |= TOUCH_EV.scroll;
            }
        }
        this.prevN = n;
        this.f.fingers = pts.map((p) => ({ slot: p.slot, x: p.x, y: p.y, area: p.area ?? 0 }));
        if (n > 0) this.lastPoints = pts;

        if (n > 0) {
            b.x = s.x; b.y = s.y;
            b.strength = s.strength ?? 0;
            b.area = s.area ?? 0;
            this.maxFingers = Math.max(this.maxFingers, n);
            const d = Math.round(Math.hypot(s.x - b.downX, s.y - b.downY));
            b.farthest = Math.max(b.farthest, d);
            const elapsed = s.t - this.t0;
            if (!b.outside && d > cfg.deadZone) {
                b.outside = true;
                const tapOk = elapsed < cfg.tapMs;
                const holdOk = cfg.holdOn && !b.holding && elapsed < cfg.tapMs + cfg.holdMs;
                if (tapOk || holdOk) b.events |= TOUCH_EV.drift;
            }
            if (cfg.holdOn && !b.outside && !b.holding && this.maxFingers === 1 && elapsed >= cfg.tapMs + cfg.holdMs) {
                b.holding = true;
                b.events |= TOUCH_EV.hold;
            }
            b.ms = elapsed;
        } else if (b.down) {
            const elapsed = s.t - this.t0;
            b.down = false;
            b.holding = false;
            b.strength = 0;
            b.area = 0;
            b.ms = elapsed;
            b.events |= TOUCH_EV.up;
            if (this.maxFingers === 2 && this.f.hadTwo && !this.twoBroken) {
                // Two taps at once: each finger inside the dead zone, and lifted within the tap time.
                const each = this.lastPoints.map((p) => this.starts.get(p.slot));
                const ok = each.length === 2 && each.every((st) => st && st.far <= cfg.deadZone && s.t - st.t <= cfg.tapMs);
                if (ok && !this.f.scrolled && cfg.twoFingerOn) {
                    b.events |= TOUCH_EV.twoTap;
                    this.f.twoTap = true;
                }
            } else if (this.maxFingers === 1 && !b.outside && elapsed < cfg.tapMs && cfg.tapOn) {
                b.events |= TOUCH_EV.tap;
            }
            if (this.f.two) { this.f.two = false; }
            this.starts.clear();
        }
        b.fingers = n;
    }

    /** The block a read returns now; clears the events. */
    read(now: number): PadTouchBlock {
        const cfg = this.settings();
        const out = { ...this.block, ms: this.block.down ? now - this.t0 : this.block.ms, tapPx: Math.round(cfg.deadZone * 2048 / PAD_WIDTH_MM100) };
        this.block.events = 0;
        return out;
    }

    /** The fingers block a read returns now; clears its two-finger tap. */
    readFingers(now: number): PadFingersBlock {
        const out: PadFingersBlock = { ...this.f, fingers: [...this.f.fingers], twoMs: this.f.two ? now - this.twoAt : this.f.twoMs };
        this.f.twoTap = false;
        return out;
    }
}
