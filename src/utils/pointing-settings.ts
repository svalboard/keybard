// Pointing Devices panel: what each hand's card shows, from what the board reports.
//
// One card per hand, named by the module detected on that half. Pointer speed
// lists only the DPI values that do something on that module; Scroll speed is
// a per-hand multiplier (VIA 61 left, 62 right, percent) that never reads the
// pointer speed. The wire format is in svalboard/qmk keyboards/svalboard/docs/protocol.md.
import type { CustomUIMenuItem, KeyboardInfo } from "@/types/keyboard.types";
import type { PointingHalfReport, PointingModule, Side } from "./pointing-hardware";

// ---------------------------------------------------------------- flags

/**
 * GET_INFO byte 21 (feature_flags4) bit 5: Scroll speed per hand (VIA values 61 and 62).
 * Bit 3 is the trackball sensor page (0x39), and the test build set bit 4 for its
 * touchpad-only value 60, so neither means 61 and 62.
 */
export const SVIL_FLAG4_SCROLL_SPEED = 0x20;
/** GET_INFO byte 21 bit 6: a TrackPoint's Pointer speed is software scaling, so its DPI choices up to 3200 do something. */
export const SVIL_FLAG4_TRACKPOINT_SPEED = 0x40;

export const hasScrollSpeed = (flags4: number | undefined | null): boolean => ((flags4 ?? 0) & SVIL_FLAG4_SCROLL_SPEED) !== 0;
export const hasTrackpointSpeed = (flags4: number | undefined | null): boolean => ((flags4 ?? 0) & SVIL_FLAG4_TRACKPOINT_SPEED) !== 0;

// ---------------------------------------------------------------- value ids

export const LEFT_DPI_KEY = "id_left_dpi";
export const RIGHT_DPI_KEY = "id_right_dpi";
export const LEFT_SCROLL_KEY = "id_left_scroll";
export const RIGHT_SCROLL_KEY = "id_right_scroll";
export const LEFT_SCROLL_SPEED_KEY = "id_left_scroll_speed";
export const RIGHT_SCROLL_SPEED_KEY = "id_right_scroll_speed";
export const VIA_LEFT_SCROLL_SPEED = 61;
export const VIA_RIGHT_SCROLL_SPEED = 62;
export const NATURAL_SCROLL_KEY = "id_natural_scroll";
export const AXIS_LOCK_KEY = "id_axis_lock";

export const AUTOMOUSE_ENABLE_KEY = "id_automouse_enable";
export const AUTOMOUSE_NO_TIMEOUT_KEY = "id_automouse_no_timeout";
export const AUTOMOUSE_TIMEOUT_KEY = "id_automouse_timeout_ms";
export const AUTOMOUSE_THRESHOLD_KEY = "id_automouse_threshold";
export const AUTOMOUSE_DECAY_KEY = "id_automouse_decay";
/** Activation Decay is stored in 10 ms steps; it is at least 10 ms. Older firmware menus start at 0, which meant "never forget". */
export const AUTOMOUSE_DECAY_MIN = 1;
export const LEFT_AUTOMOUSE_KEY = "id_left_automouse";
export const RIGHT_AUTOMOUSE_KEY = "id_right_automouse";

export const HAND_KEYS: Record<Side, { dpi: string; scroll: string; scrollSpeed: string; automouse: string }> = {
    left: { dpi: LEFT_DPI_KEY, scroll: LEFT_SCROLL_KEY, scrollSpeed: LEFT_SCROLL_SPEED_KEY, automouse: LEFT_AUTOMOUSE_KEY },
    right: { dpi: RIGHT_DPI_KEY, scroll: RIGHT_SCROLL_KEY, scrollSpeed: RIGHT_SCROLL_SPEED_KEY, automouse: RIGHT_AUTOMOUSE_KEY },
};

// ---------------------------------------------------------------- scroll speed

/** Stored as a percent: 20 to 1000, 100 the standard (1.0x). */
export const SCROLL_SPEED_MIN = 20;
export const SCROLL_SPEED_MAX = 1000;
export const SCROLL_SPEED_DEFAULT = 100;

/** The slider's detents, as multipliers: log spaced, about 20 of them. */
export const SCROLL_SPEED_STEPS: readonly number[] = [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The detent a stored percent sits on, or the nearest in log distance when the board holds an off-detent value. */
export function scrollSpeedIndex(percent: number): number {
    const p = Math.max(SCROLL_SPEED_MIN, Math.min(SCROLL_SPEED_MAX, percent || SCROLL_SPEED_DEFAULT));
    let best = 0;
    for (let i = 1; i < SCROLL_SPEED_STEPS.length; i++) {
        if (Math.abs(Math.log(SCROLL_SPEED_STEPS[i] * 100 / p)) < Math.abs(Math.log(SCROLL_SPEED_STEPS[best] * 100 / p))) best = i;
    }
    return best;
}

/** A detent as the percent that is stored. */
export const scrollSpeedPercent = (index: number): number => Math.round(SCROLL_SPEED_STEPS[Math.max(0, Math.min(SCROLL_SPEED_STEPS.length - 1, index))] * 100);

/** "1.0×", "0.25×", "2.5×", "10×". */
export function formatScrollSpeed(multiplier: number): string {
    if (multiplier >= 10) return `${Math.round(multiplier)}×`;
    return `${Number.isInteger(multiplier * 10) ? multiplier.toFixed(1) : multiplier.toFixed(2)}×`;
}

/**
 * The Scroll speed an older backup's DPI stands for: DPI / 800 as a percent, rounded to nearest,
 * the same rule as the firmware's one-time migration (scroll_speed.c). The touchpad counts at
 * most 1210 DPI, a TrackPoint stays 1.0x, and the result is held to 20-1000.
 */
export function scrollSpeedFromDpi(dpi: number, module: PointingModule | null): number {
    if (module === "trackpoint") return SCROLL_SPEED_DEFAULT;
    const counted = module === "azoteq" ? Math.min(dpi, 1210) : dpi;
    const percent = Math.floor((counted * 100 + 400) / 800);
    return Math.max(SCROLL_SPEED_MIN, Math.min(SCROLL_SPEED_MAX, percent));
}

// ---------------------------------------------------------------- pointer speed

/** The highest DPI that does something on a module: the pad's resolution limit, each sensor's own, and the TrackPoint's software speed (4x). */
export const MODULE_MAX_DPI: Record<PointingModule, number> = { azoteq: 1200, pmw3360: 12000, pmw3389: 16000, trackpoint: 3200 };

/**
 * The highest DPI worth listing for a module, or null for no limit. A TrackPoint
 * has no Pointer speed until the firmware scales it in software (then up to
 * 3200): undefined means the card shows none.
 */
export function maxDpiFor(module: PointingModule | null, trackpointSpeed: boolean): number | null | undefined {
    if (module === "trackpoint" && !trackpointSpeed) return undefined;
    if (!module) return null;
    return MODULE_MAX_DPI[module] ?? null;
}

export interface DpiChoice { index: number; dpi: number }

/** The menu's DPI options that do something (index is what the board stores). */
export function dpiChoices(options: readonly (string | number)[] | undefined, max: number | null): DpiChoice[] {
    return (options ?? [])
        .map((o, index) => ({ index, dpi: Number(o) }))
        .filter((c) => Number.isFinite(c.dpi) && (max === null || c.dpi <= max));
}

/** The choice a stored index shows as: a saved index past the limit shows the highest one that does something. */
export function effectiveDpiIndex(choices: DpiChoice[], stored: number | undefined): number | undefined {
    if (stored === undefined || !choices.length) return undefined;
    const match = choices.find((c) => c.index === stored);
    return match ? match.index : choices[choices.length - 1].index;
}

// ---------------------------------------------------------------- hands

export const MODULE_CARD_NAMES: Record<PointingModule, string> = {
    pmw3360: "Trackball, PMW3360",
    pmw3389: "Trackball, PMW3389",
    azoteq: "Touchpad, Azoteq",
    trackpoint: "TrackPoint",
};

export interface HandModel {
    side: Side;
    /** The detected module, or the one the firmware drives when nothing is checked yet; null when the board doesn't say. */
    module: PointingModule | null;
    /** What the card says it is. */
    moduleName: string;
    /**
     * The computer drives this hand's touchpad as a Precision Touchpad (0x2C flags bit 4,
     * SVAL_POINTER_OS_TOUCHPAD: Windows or Linux in Automatic), so the pad's own Pointer speed,
     * Scroll speed and Scroll Mode have no effect. False on a Mac and with Built-in gestures.
     */
    osDriven?: boolean;
}

export function moduleOf(half: PointingHalfReport): PointingModule | null {
    if (half.detected && half.detected !== "none" && half.detected !== "unknown") return half.detected;
    return half.builtFor !== "none" ? half.builtFor : null;
}

/**
 * The cards to draw: one per half with a pointing module. A board that reports
 * no hardware (older firmware) still has its menu's left and right pointers, so
 * both hands show with a generic name.
 */
export function pointingHands(keyboard: KeyboardInfo | null | undefined): HandModel[] {
    const halves = keyboard?.pointing_hardware?.halves;
    if (halves?.length) {
        const out: HandModel[] = [];
        for (const half of halves) {
            const module = moduleOf(half);
            if (!module) continue;
            out.push({ side: half.side, module, moduleName: MODULE_CARD_NAMES[module], ...(module === "azoteq" && half.osTouchpad ? { osDriven: true } : {}) });
        }
        return out.sort((a, b) => (a.side === b.side ? 0 : a.side === "left" ? -1 : 1));
    }
    if (!keyboard?.menus?.length) return [];
    return (["left", "right"] as const).map((side) => ({ side, module: null, moduleName: "Pointing device" }));
}

/** The Pointing section has something to show: a half with a module, or an older board's pointer menu. */
export function hasPointingCards(keyboard: KeyboardInfo | null | undefined): boolean {
    if (!keyboard) return false;
    if (keyboard.pointing_hardware?.halves?.length) return pointingHands(keyboard).length > 0;
    return (keyboard.menus ?? []).some((m) => m.label?.toLowerCase().includes("pointing"));
}

// ---------------------------------------------------------------- the menu

function firstChannel(items: readonly CustomUIMenuItem[]): number {
    for (const item of items) {
        const c = item.content;
        if (Array.isArray(c) && typeof c[0] === "string") return Number(c[1]) || 0;
        if (Array.isArray(c)) { const found = firstChannel(c as CustomUIMenuItem[]); if (found) return found; }
    }
    return 0;
}

/** Firmware with Scroll speed: its two values join the pointing menu, so they load at connect. */
export function withScrollSpeed(menus: CustomUIMenuItem[], featureFlags4: number | undefined | null): CustomUIMenuItem[] {
    if (!hasScrollSpeed(featureFlags4)) return menus;
    const index = menus.findIndex((menu) => menu.label?.toLowerCase().includes("pointing"));
    if (index < 0) return menus;
    const menu = menus[index];
    const content = (menu.content ?? []) as CustomUIMenuItem[];
    const has = (key: string): boolean => JSON.stringify(content).includes(`"${key}"`);
    if (has(LEFT_SCROLL_SPEED_KEY)) return menus;
    const channel = firstChannel(content);
    const section: CustomUIMenuItem = {
        label: "Scroll speed",
        content: [
            { label: "Left Scroll speed", type: "range", options: [SCROLL_SPEED_MIN, SCROLL_SPEED_MAX, 1], content: [LEFT_SCROLL_SPEED_KEY, channel, VIA_LEFT_SCROLL_SPEED] },
            { label: "Right Scroll speed", type: "range", options: [SCROLL_SPEED_MIN, SCROLL_SPEED_MAX, 1], content: [RIGHT_SCROLL_SPEED_KEY, channel, VIA_RIGHT_SCROLL_SPEED] },
        ],
    };
    const at = content.findIndex((item) => item.label === "Scroll Settings" || item.label === "Advanced");
    const next = [...content];
    next.splice(at < 0 ? next.length : at, 0, section);
    const out = [...menus];
    out[index] = { ...menu, content: next };
    return out;
}

/** A leaf item of the menu by its value key, with the nested sections searched. */
export function findMenuItem(items: readonly CustomUIMenuItem[] | undefined, key: string): CustomUIMenuItem | undefined {
    for (const item of items ?? []) {
        const c = item.content;
        if (Array.isArray(c) && typeof c[0] === "string") { if (c[0] === key) return item; }
        else if (Array.isArray(c)) { const found = findMenuItem(c as CustomUIMenuItem[], key); if (found) return found; }
    }
    return undefined;
}
