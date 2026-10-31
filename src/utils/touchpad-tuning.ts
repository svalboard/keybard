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
export const PAD_TUNING_KEYS = [PAD_DEAD_ZONE_KEY, PAD_TAP_MS_KEY, PAD_SCROLL_KEY] as const;
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

// ---------------------------------------------------------------- one touch's outcome

export type TouchOutcomeKind = "tap" | "right" | "hold" | "canceled" | "late" | "short" | "moved" | "scroll";

export interface TouchOutcome {
    kind: TouchOutcomeKind;
    /** Plain words for the list under the pad. */
    text: string;
    /** How long the touch lasted and how far it went from its down point. */
    ms: number;
    farthest: number;
    /** Where it began and ended, 0.01 mm. */
    downX: number;
    downY: number;
    x: number;
    y: number;
}

/**
 * Follows one pad across reads and tells, for each touch that ends, what the
 * chip made of it and why. The chip's own events decide clicks; the dead zone
 * cancel is the firmware's reading of the chip's rule (bit 6).
 */
export class TouchTracker {
    private open = false;
    private events = 0;
    private maxFingers = 0;
    private last: PadTouchBlock = EMPTY_BLOCK;
    /** The touch now, while a finger is down. */
    current: PadTouchBlock | null = null;
    /** Events of the touch now (or the last one), for the marks on the pad. */
    touchEvents = 0;
    /** Where the touch now (or the last one) has been, 0.01 mm, as read. */
    trail: { x: number; y: number }[] = [];

    take(b: PadTouchBlock, settings: Pick<PadTouchReport, "tapMs" | "holdMs" | "holdOn" | "tapOn" | "twoFingerOn">): TouchOutcome | null {
        if (!b.valid) { this.current = null; this.open = false; return null; }
        if (b.events & TOUCH_EV.down) {
            if (this.open) this.events = 0; // a lift and a new touch between reads
            this.open = true;
            this.events = 0;
            this.maxFingers = 0;
            this.trail = [{ x: b.downX, y: b.downY }];
        }
        if (!this.open && b.down) { this.open = true; this.events = 0; this.maxFingers = 0; this.trail = [{ x: b.downX, y: b.downY }]; }
        if (this.open && this.trail.length < 400) this.trail = [...this.trail, { x: b.x, y: b.y }];
        if (this.open) {
            this.events |= b.events;
            this.maxFingers = Math.max(this.maxFingers, b.fingers);
        }
        this.touchEvents = this.events;
        this.last = b;
        this.current = b.down ? b : null;
        if (!this.open || b.down) return null;
        this.open = false;
        return outcome(this.events, this.maxFingers, b, settings);
    }

    get latest(): PadTouchBlock {
        return this.last;
    }
}

export function outcome(events: number, maxFingers: number, b: PadTouchBlock,
    s: Pick<PadTouchReport, "tapMs" | "holdMs" | "holdOn" | "tapOn" | "twoFingerOn">): TouchOutcome {
    const base = { ms: b.ms, farthest: b.farthest, downX: b.downX, downY: b.downY, x: b.x, y: b.y };
    const sec = `${b.ms} ms`;
    const moved = formatMm(b.farthest);
    const holdAt = s.tapMs + s.holdMs;
    // On a pad the computer has as a touchpad these are the chip's decisions; the view says the computer makes the clicks.
    if (events & TOUCH_EV.twoTap) return { kind: "right", text: `Right click: two fingers, ${sec}`, ...base };
    if (events & TOUCH_EV.hold) return { kind: "hold", text: `Press and hold at ${holdAt} ms, released at the lift (${sec})`, ...base };
    if (events & TOUCH_EV.tap) return { kind: "tap", text: `Tap: ${sec}, moved ${moved}`, ...base };
    if (events & TOUCH_EV.scroll) return { kind: "scroll", text: `Scroll: two fingers, ${sec}`, ...base };
    if (events & TOUCH_EV.drift) return { kind: "canceled", text: `Canceled: moved ${moved}, out of the dead zone (${sec})`, ...base };
    if (maxFingers >= 2) return { kind: "short", text: s.twoFingerOn ? `No click: two fingers, ${sec}` : `No click: two-finger tap is off (${sec})`, ...base };
    if (b.ms < s.tapMs) return { kind: "short", text: s.tapOn ? `No click: ${sec}, moved ${moved}` : `No click: tap to click is off (${sec})`, ...base };
    if (!s.holdOn) return { kind: "late", text: `No click: ${sec} is past the ${s.tapMs} ms tap time, and press and hold is off`, ...base };
    if (b.ms >= holdAt) return { kind: "moved", text: `No click: moved ${moved} (a pointer move, ${sec})`, ...base };
    return { kind: "late", text: `No click: lifted at ${sec}, after the ${s.tapMs} ms tap time and before the ${holdAt} ms hold`, ...base };
}

// ---------------------------------------------------------------- a chip model

export interface ChipSettings {
    deadZone: number; // 0.01 mm
    tapMs: number;
    holdMs: number;
    tapOn: boolean;
    twoFingerOn: boolean;
    holdOn: boolean;
}

/** One finger sample: time, position in 0.01 mm, fingers down. */
export interface TouchSample { t: number; x: number; y: number; fingers: number; strength?: number; area?: number }

/**
 * The chip's tap and press-and-hold rules (IQS5xx-B000 datasheet 6.1-6.4),
 * for the simulated board: a tap lifts within the tap time inside the dead
 * zone; press and hold fires at tap time + hold time inside it; leaving the
 * dead zone while either could still fire cancels both.
 */
export class ChipModel {
    private block: PadTouchBlock = { ...EMPTY_BLOCK, valid: true };
    private t0 = 0;
    private maxFingers = 0;

    constructor(private settings: () => ChipSettings) {}

    sample(s: TouchSample): void {
        const cfg = this.settings();
        const b = this.block;
        if (s.fingers > 0 && !b.down) {
            Object.assign(b, { down: true, outside: false, holding: false, farthest: 0, downX: s.x, downY: s.y, x: s.x, y: s.y });
            this.t0 = s.t;
            this.maxFingers = 0;
            b.events |= TOUCH_EV.down;
        }
        if (s.fingers > 0) {
            b.x = s.x; b.y = s.y;
            b.strength = s.strength ?? 0;
            b.area = s.area ?? 0;
            this.maxFingers = Math.max(this.maxFingers, s.fingers);
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
            if (this.maxFingers >= 2 && Math.hypot(s.x - b.downX, s.y - b.downY) > 3 * cfg.deadZone) b.events |= TOUCH_EV.scroll;
            b.ms = elapsed;
        } else if (b.down) {
            const elapsed = s.t - this.t0;
            b.down = false;
            b.holding = false;
            b.strength = 0;
            b.area = 0;
            b.ms = elapsed;
            b.events |= TOUCH_EV.up;
            if (!b.outside && elapsed < cfg.tapMs) {
                if (this.maxFingers >= 2 && cfg.twoFingerOn) b.events |= TOUCH_EV.twoTap;
                else if (this.maxFingers === 1 && cfg.tapOn) b.events |= TOUCH_EV.tap;
            }
        }
        b.fingers = s.fingers;
    }

    /** The block a read returns now; clears the events. */
    read(now: number): PadTouchBlock {
        const cfg = this.settings();
        const out = { ...this.block, ms: this.block.down ? now - this.t0 : this.block.ms, tapPx: Math.round(cfg.deadZone * 2048 / PAD_WIDTH_MM100) };
        this.block.events = 0;
        return out;
    }
}
