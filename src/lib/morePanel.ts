/**
 * The rail's More item: editors that most people never need. More opens a short list
 * of them (Overrides, Alt-Repeat and, on firmware with app rules, App Layers); each
 * opens its own editor, and the rail keeps More marked while one is open.
 * This only places the editors: their entries on the board, in backups and in
 * import/export are kept and written exactly as before.
 */
export const MORE_PANEL = "more";
export const OVERRIDES_PANEL = "overrides";
export const ALT_REPEAT_PANEL = "altrepeat";
export const APP_LAYERS_PANEL = "app-layers";

/** The editors opened from More, in the order More lists them. */
export const MORE_EDITOR_PANELS: readonly string[] = [OVERRIDES_PANEL, ALT_REPEAT_PANEL, APP_LAYERS_PANEL];

/** The rail item that stands for a panel: More for the editors it holds, the panel itself otherwise. */
export const railPanelFor = <T extends string | null | undefined>(panel: T): T | typeof MORE_PANEL =>
    panel && MORE_EDITOR_PANELS.includes(panel) ? MORE_PANEL : panel;
