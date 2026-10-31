// The touchpad tap setting (svalboard/qmk docs/protocol.md "Touchpad taps").
//
// The Azoteq touchpad chip makes clicks of its own while the pads are a mouse
// (macOS, a BIOS, Windows and Linux before touchpad mode): a tap clicks, a
// two-finger tap right clicks, and press and hold presses the left button for
// dragging. Firmware with GET_INFO byte 20 bit 4 lets each be turned off, and
// sets the hold time, through VIA custom values 51-54 on the pointing menu's
// channel. The firmware's menu doesn't list them, so Keybard adds them to the
// Pointing Device menu when the flag is set, and shows them only while a half
// has a touchpad.
import type { CustomUIMenuItem, KeyboardInfo } from "@/types/keyboard.types";

/** GET_INFO byte 20 (feature_flags3) bit 4: VIA values 51-54. */
export const SVIL_FLAG3_PAD_GESTURES = 0x10;

export const PAD_TAP_KEY = "id_pad_tap";
export const PAD_TWO_FINGER_KEY = "id_pad_two_finger";
export const PAD_HOLD_KEY = "id_pad_hold";
export const PAD_HOLD_MS_KEY = "id_pad_hold_ms";
export const PAD_KEYS = [PAD_TAP_KEY, PAD_TWO_FINGER_KEY, PAD_HOLD_KEY, PAD_HOLD_MS_KEY] as const;

/**
 * The hold times the board stores (pad_gestures.c sval_pad_hold_ms), the
 * default first; a write takes the nearest.
 */
export const PAD_HOLD_MS = [300, 20, 50, 100, 150, 200, 250, 350, 400, 500, 600, 700, 800, 1000, 1200, 1500] as const;
/** Press and hold's default hold time (firmware with the setting; older firmware held for 20 ms). */
export const PAD_HOLD_DEFAULT_MS = PAD_HOLD_MS[0];

export const TOUCHPAD_SECTION_LABEL = "Touchpad";
export const TOUCHPAD_NOTE = "Windows and Linux use their own touchpad settings while the pads are in touchpad mode.";

/** sval_pointer_sensor / fragment id of an Azoteq pad in 0x18 (pointing_touchpad_azoteq). */
const AZOTEQ_FRAGMENT_ID = 7;

export const hasPadGestures = (featureFlags3: number | undefined | null): boolean =>
    ((featureFlags3 ?? 0) & SVIL_FLAG3_PAD_GESTURES) !== 0;

function refs(items: CustomUIMenuItem[], out: { key: string; channel: number }[] = []) {
    for (const item of items) {
        const c = item.content;
        if (Array.isArray(c) && typeof c[0] === "string") out.push({ key: c[0], channel: Number(c[1]) });
        else if (Array.isArray(c)) refs(c as CustomUIMenuItem[], out);
    }
    return out;
}

/** The Touchpad section, on the channel the menu's own values use. */
export function touchpadSection(channel: number): CustomUIMenuItem {
    return {
        label: TOUCHPAD_SECTION_LABEL,
        note: TOUCHPAD_NOTE,
        content: [
            { label: "Tap to Click", type: "toggle", content: [PAD_TAP_KEY, channel, 51] },
            { label: "Two-Finger Tap to Right Click", type: "toggle", content: [PAD_TWO_FINGER_KEY, channel, 52] },
            { label: "Press and Hold to Drag", type: "toggle", content: [PAD_HOLD_KEY, channel, 53] },
            // Grayed out, not hidden, while press and hold is off: it keeps its time.
            { label: "Hold Time (ms)", type: "range", options: [20, 1500, 10], disabledIf: `{${PAD_HOLD_KEY}} == 0`, content: [PAD_HOLD_MS_KEY, channel, 54] },
        ],
    };
}

/**
 * The menus with the Touchpad section added to the pointing menu, when the
 * firmware has the setting and its menu doesn't list it already. Otherwise
 * the same array.
 */
export function withTouchpadTaps(menus: CustomUIMenuItem[], featureFlags3: number | undefined | null): CustomUIMenuItem[] {
    if (!hasPadGestures(featureFlags3)) return menus;
    const index = menus.findIndex(menu => menu.label?.toLowerCase().includes("pointing"));
    if (index < 0) return menus;
    const menu = menus[index];
    const content = (menu.content ?? []) as CustomUIMenuItem[];
    const present = refs(content);
    if (present.some(r => (PAD_KEYS as readonly string[]).includes(r.key))) return menus;
    const channel = present[0]?.channel ?? 0;
    // After the pointers and auto mouse, before Scroll Settings and Advanced.
    const at = content.findIndex(item => item.label === "Scroll Settings" || item.label === "Advanced");
    const next = [...content];
    next.splice(at < 0 ? next.length : at, 0, touchpadSection(channel));
    const out = [...menus];
    out[index] = { ...menu, content: next };
    return out;
}

/**
 * A half of the board has an Azoteq touchpad: from POINTING_HARDWARE (0x2C)
 * read at connect, or a late find of the pointing probe (0x18).
 */
export function boardHasTouchpad(kbinfo: KeyboardInfo | null | undefined): boolean {
    if (!kbinfo) return false;
    if (kbinfo.pointing_hardware?.halves.some(h => h.detected === "azoteq")) return true;
    const hw = kbinfo.fragmentState?.hwDetection;
    if (!hw) return false;
    const ids = hw instanceof Map ? [...hw.values()] : Object.values(hw as Record<string, number>);
    return ids.includes(AZOTEQ_FRAGMENT_ID);
}
