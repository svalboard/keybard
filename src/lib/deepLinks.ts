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
 *   ?fakeBoard=touchpad is this firmware with an Azoteq touchpad on each half.
 *   ?fakeBoard=leader0 is firmware from before x4.3.3 whose settings reset
 *   stored a leader timeout of 0 (fresh on every load).
 *   Its settings stay in this browser across reloads (except turbo6 and leader0).
 * - ?tester opens the matrix tester once a board is connected or a layout loaded.
 * - ?panel=scanlab opens the Scan Lab once a board is connected (PointingDeepLink.tsx,
 *   with ?panel=settings and the old panel names); ?panel=pointing opens the
 *   Pointing Devices panel, where the auto mouse settings are; ?panel=keyboard opens
 *   Standard Keys. ?panel=firmware and
 *   ?panel=backups open Settings at that card.
 */
import type { ResolvedTheme } from "@/lib/theme";

export const DEMO_PARAM = "demo";
export const THEME_PARAM = "theme";
export const EDIT_PARAM = "edit";
export const FAKE_BOARD_PARAM = "fakeBoard";
export const TESTER_PARAM = "tester";

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
export type FakeBoardChoice = "combo-names" | "old" | "no-pause" | "turbo6" | "leader0" | "touchpad";

/** ?fakeBoard (any value but "old" or "nopause") is the simulated board with combo names; absent is null. */
export function fakeBoardFromSearch(search: string): FakeBoardChoice | null {
    const value = param(search, FAKE_BOARD_PARAM);
    if (value === null) return null;
    const v = value.trim().toLowerCase();
    return v === "old" ? "old" : v === "nopause" || v === "no-pause" ? "no-pause" : v === "turbo6" ? "turbo6" : v === "leader0" ? "leader0" : v === "touchpad" ? "touchpad" : "combo-names";
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
