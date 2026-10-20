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
 * - ?demo&boardLayer=N stands in for a board reporting layer N as its live
 *   layer, while no board is connected. Unlike the others it is read on each
 *   layer poll, so a test can change it without reloading the page.
 */
import type { ResolvedTheme } from "@/lib/theme";

export const DEMO_PARAM = "demo";
export const THEME_PARAM = "theme";
export const EDIT_PARAM = "edit";
export const BOARD_LAYER_PARAM = "boardLayer";

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

/** ?demo&boardLayer=N (N from 0 to 31): the simulated board's live layer; otherwise null. */
export function boardLayerFromSearch(search: string): number | null {
    if (demoFromSearch(search) === null) return null;
    const value = param(search, BOARD_LAYER_PARAM)?.trim() ?? "";
    if (!/^\d{1,2}$/.test(value)) return null;
    const layer = Number(value);
    return layer <= 31 ? layer : null;
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

/** Tests only: forget that this load already used its deep links. */
export function resetDeepLinksForTests() {
    demoStarted = false;
    editStarted = false;
}
