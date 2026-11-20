/**
 * Review deep links: URL params that set up a page load for review on the
 * test site. Each is read once per load, never saved, and harmless anywhere
 * else (nothing happens without the param). They compose with the other
 * review params (comboEditor, railMode, spotLight, pickerShape...).
 *
 * - ?demo loads the QWERTY Example on start; ?demo=combos loads it with a
 *   few combos, tap dances and macros filled in (DEMO_FEATURES), two of the
 *   combos named (DEMO_COMBO_NAMES).
 * - ?theme=light|dark forces the theme for this load only.
 * - ?edit=combo:N | tapdance:N | macro:N opens that editor once a layout is loaded.
 * - ?fakeBoard connects to a simulated Svalboard (src/dev/fake-board) as if it
 *   were plugged in, firmware with combo names; ?fakeBoard=old simulates
 *   firmware without them; ?fakeBoard=nopause simulates firmware that can't
 *   pause typing for the matrix tester; ?fakeBoard=turbo6 is this firmware
 *   on a board that ran turbo 6 with both scan waits at 0 before updating
 *   (its migration lands on 15 / 15 µs; it starts fresh on every load);
 *   ?fakeBoard=touchpad is this firmware with an Azoteq touchpad on each half,
 *   in touchpad mode as Windows and Linux have it (?fakeBoard=touchpad-os too);
 *   ?fakeBoard=touchpad-gestures the same board on built-in gestures, as on a
 *   Mac (the computer never asks for touchpad mode); ?fakeBoard=touchpad-434
 *   v4.3.4's firmware in touchpad mode (the touch page only: no fingers page,
 *   palm rejection or touchpad mode setting).
 *   ?fakeBoard=pointing is this board with a PMW3389 trackball on the left half and
 *   the touchpad (built-in gestures) on the right: the Pointing Devices panel with a card of each.
 *   ?fakeBoard=pointing-os is the same board on a computer that drives the touchpad
 *   (Windows or Linux in Automatic): the touchpad card grays its speed and Scroll Mode.
 *   ?fakeBoard=two-balls is a PMW3389 trackball on each half, ?fakeBoard=ball-trackpoint
 *   a trackball on the left and a TrackPoint on the right, and ?fakeBoard=no-module this
 *   firmware with no pointing module on either half: each is a layout of the Pointing
 *   Devices panel to review.
 *   ?fakeBoard=legends is this firmware with a few digit and punctuation keys
 *   wrapped in a modifier, a mod-tap and a layer-tap, some in combos (the
 *   shifted-legends checks, LEGEND_SEED_KEYS in seed.ts; fresh on every load).
 *   ?fakeBoard=altrepeat is this firmware with one Alt-Repeat entry, to review the
 *   Alt-Repeat panel with an entry (under the rail's More; fresh on every load).
 *   ?fakeBoard=leader0 is firmware from before x4.3.3 whose settings reset
 *   stored a leader timeout of 0 (fresh on every load).
 *   Its settings stay in this browser across reloads (except turbo6 and leader0).
 * - ?keyLegends=german opens with that layout chosen for Key legends (any layout id in
 *   Keyboards/layouts.ts), and ?altgrLegends=on|off sets AltGr Symbols, for this load only.
 * - ?tester opens the matrix tester once a board is connected or a layout loaded.
 * - ?panel=scanlab opens the Scan Lab once a board is connected (PointingDeepLink.tsx,
 *   with ?panel=settings and the old panel names); ?panel=pointing opens the
 *   Pointing Devices panel, the keys you assign; ?panel=keyboard opens
 *   Standard Keys. ?panel=pointing-settings is the same panel, and
 *   ?panel=pointing-automouse the same, scrolled to AutoMouse (old name: pointing-advanced). ?panel=firmware and
 *   ?panel=backups open Settings at that card. ?tune=touchpad and ?tune=trackball open
 *   that tuner modal over the panel the link lands on (?panel=pointing,
 *   ?panel=hardware for Settings > Hardware); ?panelPosition=bottombar shows the
 *   tray for this load.
 */
import type { ResolvedTheme } from "@/lib/theme";

export const DEMO_PARAM = "demo";
export const THEME_PARAM = "theme";
export const EDIT_PARAM = "edit";
export const FAKE_BOARD_PARAM = "fakeBoard";
export const TESTER_PARAM = "tester";

export const KEY_LEGENDS_PARAM = "keyLegends";
export const ALTGR_LEGENDS_PARAM = "altgrLegends";
export const PICKER_ALTGR_PARAM = "pickerAltGr";

/** ?pickerAltGr=on opens the picker with its AltGr button active (review links; the button is shown only on a layout with AltGr data). */
export function pickerAltGrFromSearch(search: string): boolean {
    const value = param(search, PICKER_ALTGR_PARAM)?.trim().toLowerCase();
    return value === "on" || value === "1" || value === "true";
}


/** ?keyLegends=<layout id>, lower-cased; absent is null (the caller checks it names a layout). */
export function keyLegendsFromSearch(search: string): string | null {
    const value = param(search, KEY_LEGENDS_PARAM)?.trim().toLowerCase();
    return value ? value : null;
}

/** ?altgrLegends=on|1|true is true, off|0|false is false; anything else or absent is null. */
export function altgrLegendsFromSearch(search: string): boolean | null {
    const value = param(search, ALTGR_LEGENDS_PARAM)?.trim().toLowerCase();
    if (value === "on" || value === "1" || value === "true") return true;
    if (value === "off" || value === "0" || value === "false") return false;
    return null;
}

export const MORE_KEYS_PARAM = "moreKeys";
export const ANY_KEY_PARAM = "anyKey";

/** ?moreKeys opens every More keys group (or only ?moreKeys=special, mouse...), for this load only. */
export function moreKeysOpenFromSearch(search: string, category: string): boolean {
    const value = param(search, MORE_KEYS_PARAM)?.trim().toLowerCase();
    return value !== undefined && value !== null && (value === "" || value === "1" || value === "on" || value === category);
}

/** ?anyKey opens the Custom keycode dialog once a key is selected (review links). */
export function anyKeyFromSearch(search: string): boolean {
    return param(search, ANY_KEY_PARAM) !== null;
}

export type DemoChoice = "qwerty" | "combos";

function param(search: string, name: string): string | null {
    try {
        return new URLSearchParams(search).get(name);
    } catch {
        return null;
    }
}

/** ?demo (any value but "combos") is the plain QWERTY Example; absent is null. */
export function demoFromSearch(search: string): DemoChoice | null {
    const value = param(search, DEMO_PARAM);
    if (value === null) return null;
    return value.trim().toLowerCase() === "combos" ? "combos" : "qwerty";
}

/** ?theme=light|dark; anything else is null (the person's own setting). */
export function themeFromSearch(search: string): ResolvedTheme | null {
    const value = param(search, THEME_PARAM)?.trim().toLowerCase();
    return value === "light" || value === "dark" ? value : null;
}

/**
 * "combo-names": this firmware (combo names, typing pause); "old": firmware
 * without combo names; "no-pause": firmware that can't pause typing.
 */
export type FakeBoardChoice = "combo-names" | "old" | "no-pause" | "turbo6" | "leader0" | "touchpad" | "touchpad-gestures" | "touchpad-434" | "pointing" | "pointing-os" | "two-balls" | "ball-trackpoint" | "no-module" | "unread" | "legends" | "altrepeat";

/** ?fakeBoard (any value but "old" or "nopause") is the simulated board with combo names; absent is null. */
export function fakeBoardFromSearch(search: string): FakeBoardChoice | null {
    const value = param(search, FAKE_BOARD_PARAM);
    if (value === null) return null;
    const v = value.trim().toLowerCase();
    return v === "old" ? "old" : v === "nopause" || v === "no-pause" ? "no-pause" : v === "turbo6" ? "turbo6" : v === "leader0" ? "leader0" : v === "touchpad" || v === "touchpad-os" ? "touchpad" : v === "touchpad-gestures" ? "touchpad-gestures" : v === "touchpad-434" ? "touchpad-434" : v === "pointing" ? "pointing" : v === "pointing-os" ? "pointing-os" : v === "two-balls" ? "two-balls" : v === "ball-trackpoint" ? "ball-trackpoint" : v === "no-module" ? "no-module" : v === "unread" ? "unread" : v === "legends" ? "legends" : v === "altrepeat" ? "altrepeat" : "combo-names";
}

/** ?tester: open the matrix tester on start. */
export function testerFromSearch(search: string): boolean {
    return param(search, TESTER_PARAM) !== null;
}

export type EditKind = "combo" | "tapdance" | "macro";
export interface EditTarget {
    kind: EditKind;
    index: number;
}

/** The side panel each editor kind lives in, and the binding type it edits. */
export const EDIT_PANELS: Record<EditKind, string> = {
    combo: "combos",
    tapdance: "tapdances",
    macro: "macros",
};

/** ?edit=combo:N | tapdance:N | macro:N (N from 0); anything else is null. */
export function editFromSearch(search: string): EditTarget | null {
    const value = param(search, EDIT_PARAM);
    const m = /^(combo|tapdance|macro):(\d{1,4})$/i.exec(value?.trim() ?? "");
    if (!m) return null;
    return { kind: m[1].toLowerCase() as EditKind, index: Number(m[2]) };
}

/** True when `target` names an entry the loaded layout has. */
export function editTargetExists(target: EditTarget, counts: { combos: number; tapdances: number; macros: number }): boolean {
    const count = target.kind === "combo" ? counts.combos : target.kind === "tapdance" ? counts.tapdances : counts.macros;
    return target.index >= 0 && target.index < count;
}

/**
 * The ?demo=combos content: a few entries of each kind in the QWERTY
 * Example, so every editor has something real to open.
 */
export const DEMO_FEATURES = {
    combo: [
        { on: true, keys: ["KC_F", "KC_D", "KC_NO", "KC_NO"], output: "KC_ESCAPE", combo_term: 0 },
        { on: true, keys: ["KC_J", "KC_K", "KC_NO", "KC_NO"], output: "KC_ENTER", combo_term: 0 },
        { on: true, keys: ["KC_S", "KC_D", "KC_F", "KC_NO"], output: "KC_TAB", combo_term: 0 },
    ],
    tap_dance: [
        { on: true, on_tap: "KC_A", on_hold: "KC_LCTRL", on_double_tap: "KC_NO", on_tap_hold: "KC_NO", tapping_term: 200 },
        { on: true, on_tap: "KC_ESCAPE", on_hold: "KC_NO", on_double_tap: "KC_CAPSLOCK", on_tap_hold: "KC_NO", tapping_term: 200 },
    ],
    macro: [
        [["tap", "KC_A"]],
        [["tap", "KC_H", "KC_I"], ["text", "hello world"], ["delay", 100], ["down", "KC_LSHIFT"], ["tap", "KC_A", "KC_B", "KC_C"], ["up", "KC_LSHIFT"]],
    ],
} as const;

/** Names for two of the ?demo=combos combos (Keybard-only names); the middle one stays unnamed. */
export const DEMO_COMBO_NAMES: Readonly<Record<string, string>> = { "0": "Quick escape", "2": "Next field" };

/**
 * The demo layout text with DEMO_FEATURES written over its first entries.
 * The file's uid is too large for a JS number, so its exact digits are put
 * back after the round trip.
 */
export function withDemoFeatures(svilText: string): string {
    const rawUid = /"uid"\s*:\s*(\d+)/.exec(svilText)?.[1];
    const js = JSON.parse(svilText);
    for (const field of ["combo", "tap_dance", "macro"] as const) {
        const entries = DEMO_FEATURES[field] as readonly unknown[];
        const list: unknown[] = Array.isArray(js[field]) ? js[field] : [];
        entries.forEach((entry, i) => { if (i < list.length) list[i] = structuredClone(entry); });
        js[field] = list;
    }
    js.cosmetic = { ...js.cosmetic, combos: { ...DEMO_COMBO_NAMES } };
    js.uid = 0;
    const out = JSON.stringify(js, null, 2);
    return rawUid ? out.replace(/"uid"\s*:\s*0\b/, `"uid": ${rawUid}`) : out;
}

let demoStarted = false;
/** The ?demo load happens once per page load, not again after a disconnect. */
export function claimDemoStart(): boolean {
    if (demoStarted) return false;
    demoStarted = true;
    return true;
}

let editStarted = false;
/** The ?edit open happens once per page load, on the first layout loaded. */
export function claimEditStart(): boolean {
    if (editStarted) return false;
    editStarted = true;
    return true;
}

let testerStarted = false;
/** The ?tester open happens once per page load. */
export function claimTesterStart(): boolean {
    if (testerStarted) return false;
    testerStarted = true;
    return true;
}

let fakeBoardStarted = false;
/** The ?fakeBoard connect happens once per page load, not again after a disconnect. */
export function claimFakeBoardStart(): boolean {
    if (fakeBoardStarted) return false;
    fakeBoardStarted = true;
    return true;
}

/** Tests only: forget that this load already used its deep links. */
export function resetDeepLinksForTests() {
    demoStarted = false;
    editStarted = false;
    fakeBoardStarted = false;
    testerStarted = false;
}

/** ?tune=touchpad or trackball: open that tuner modal over the panel the link lands on (with ?panel=settings, ?panel=pointing or ?panel=hardware). */
export function tuneKindFromSearch(search: string): "touchpad" | "trackball" | null {
    const v = param(search, "tune")?.trim().toLowerCase();
    return v === "touchpad" || v === "trackball" ? v : null;
}

/** ?tune=touchpad: open the Tune touchpad modal. */
export function tuneFromSearch(search: string): boolean {
    return tuneKindFromSearch(search) === "touchpad";
}
