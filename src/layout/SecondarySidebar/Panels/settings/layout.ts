import { THEME_SETTING_NAME } from "@/lib/theme";
import { KEY_SIZE_SETTING, PANEL_POSITION_SETTING } from "@/lib/appearance-settings";
import { COMBO_COLORBLIND_SETTING, COMBO_INDICATOR_SETTING } from "@/lib/comboIndicators";
import { ALTGR_LEGENDS_SETTING, SHIFTED_LEGENDS_SETTING } from "@/lib/shiftedLegends";

/**
 * The Settings page, declared. Settings holds the setup a board needs once
 * (its hardware, firmware, backups and typing behavior), and preferences for
 * the Keybard app. What people use while editing a layout (layers, combos,
 * pointing modes and the rest) lives on the rail, never here.
 *
 * The page is one short list of cards. Every card opens and collapses, and
 * opens the way it was left in this browser (sectionStateSetting); until then
 * it follows `defaultOpen`.
 *
 * A row is either a setting from SETTINGS (by name, with an optional label or
 * description for this page) or a block this page renders itself. To add a
 * preference, add its definition to SETTINGS and its name to a section here.
 */
export type SettingsBlock = "hardware" | "firmware" | "board" | "backups" | "typing" | "power" | "about" | "status" | "debug";

export type SettingsRow =
    | { setting: string; label?: string; description?: string }
    | { block: SettingsBlock };

export interface SettingsSection {
    id: string;
    title: string;
    /** The jump chip's label. */
    chip: string;
    rows: SettingsRow[];
    /** Open on a first visit in this browser. */
    defaultOpen: boolean;
    /** What the card holds, in a few words, under its heading. */
    summary: string;
}

/** QMK settings groups shown in Typing behavior, in order. */
export const TYPING_BEHAVIOR_SECTIONS = ["Tap-Hold", "Auto Shift", "One Shot Keys", "Magic", "Grave Escape"];

/**
 * The app setting that remembers whether a section was left "open" or
 * "collapsed" in this browser (unset until first toggled).
 */
export const sectionStateSetting = (id: string) => `settings-${id}-open`;

/** Whether Hardware was left "open" or "collapsed". */
export const HARDWARE_OPEN_SETTING = sectionStateSetting("hardware");

export const SETTINGS_PAGE: SettingsSection[] = [
    {
        id: "hardware",
        title: "Hardware",
        chip: "Hardware",
        // Set up once when the board arrives: open until someone collapses it.
        defaultOpen: true,
        rows: [{ block: "hardware" }, { block: "board" }],
        summary: "Clusters, pointing modules, ball color and board name",
    },
    {
        id: "firmware",
        title: "Firmware",
        chip: "Firmware",
        defaultOpen: false,
        rows: [{ block: "firmware" }],
        summary: "Version, updates and firmware files",
    },
    {
        id: "backups",
        title: "Backups",
        chip: "Backups",
        defaultOpen: false,
        rows: [
            { block: "backups" },
            { setting: "import", label: "Import layout", description: "Open a .svil or .vil file. You review the changes before anything is written." },
            { setting: "export", label: "Export layout", description: "Save the layout as .svil or .vil, or print it." },
        ],
        summary: "Saved layouts, restore, import and export",
    },
    {
        id: "appearance",
        title: "Appearance and editing",
        chip: "Appearance",
        defaultOpen: false,
        rows: [
            { setting: THEME_SETTING_NAME, label: "Theme", description: "System follows your computer's light or dark mode." },
            { setting: KEY_SIZE_SETTING },
            { setting: PANEL_POSITION_SETTING },
            { setting: "typing-binds-key", label: "Typing binds a key" },
            { setting: "serial-assignment", label: "Advance after assigning", description: "After you assign a key, select the next one in this order." },
            { setting: "international-keyboards", label: "Key legends", description: "The keyboard layout your computer uses, so keys show what they type." },
            { setting: SHIFTED_LEGENDS_SETTING, label: "Shifted Key Symbols" },
            { setting: ALTGR_LEGENDS_SETTING, label: "AltGr Symbols" },
            { setting: COMBO_INDICATOR_SETTING, label: "Combo indicators" },
            { setting: COMBO_COLORBLIND_SETTING, label: "Colorblind-friendly combo colors" },
        ],
        summary: "Theme, key size, legends and combo indicators",
    },
    {
        id: "typing",
        title: "Typing behavior",
        chip: "Typing",
        defaultOpen: false,
        rows: [{ block: "typing" }],
        summary: "Tap-hold, Auto Shift, one-shot keys and key swaps",
    },
    {
        id: "power",
        title: "Power and scanning",
        chip: "Power",
        // Set once, if ever: closed until someone opens it.
        defaultOpen: false,
        // Only on a board whose firmware carries these values (SettingsPanel).
        rows: [{ block: "power" }],
        summary: "Idle timing, scan pacing and the trackball rest mode",
    },
    {
        id: "about",
        title: "About",
        chip: "About",
        defaultOpen: false,
        rows: [
            { block: "about" },
            // Only on firmware with the status report command: opens StatusReportDialog.
            { block: "status" },
            // Only on firmware with the debug console command (DebugConsoleRow).
            { block: "debug" },
            { setting: "scan-lab", label: "Scan Lab", description: "Measure key scanning and sensor timing." },
            { setting: "key-proof-sheet", label: "Key proof sheet", description: "Every key rendering at every size, for visual checks." },
        ],
        summary: "Version, status report, manual, community and developer tools",
    },
];

/** Sections shown only on some boards: Power needs firmware that carries its values. */
export const CONDITIONAL_SECTIONS = ["power"] as const;

/** Blocks shown only on some boards: the status report and the debug console need firmware with their commands. */
export const CONDITIONAL_BLOCKS = ["status", "debug"] as const;

/**
 * The page this board shows: without the debug console command no Debug console row, and without AltGr data on the
 * chosen keyboard layout no AltGr symbols row.
 * Search and rendering both use it, so a search never finds a hidden row.
 */
export function shownPage(board: { debugConsole: boolean; statusReport?: boolean; altgr?: boolean; power?: boolean }, page: SettingsSection[] = SETTINGS_PAGE): SettingsSection[] {
    return page
        .filter((section) => (section.id !== "power" || board.power !== false))
        .map((section) => ({
            ...section,
            rows: section.rows.filter((row) =>
                !(!board.debugConsole && "block" in row && row.block === "debug") &&
                !(!board.statusReport && "block" in row && row.block === "status") &&
                // AltGr Symbols shows only when the Key legends layout has an AltGr level.
                !(board.altgr === false && "setting" in row && row.setting === ALTGR_LEGENDS_SETTING)),
        }));
}

/**
 * Settings that have a definition in SETTINGS but are deliberately not on this
 * page, with their one home. A definition that is in neither list fails a test.
 */
export const SETTINGS_SHOWN_ELSEWHERE: Record<string, string> = {
    "live-updating": "the toolbar (Live Updating / Manual Updates)",
    "trackball-characterization": "Pointing Devices, the Trackball sensors button on a trackball card",
};

/** Every setting name the page renders, in page order. */
export function settingsOnPage(page: SettingsSection[] = SETTINGS_PAGE): string[] {
    return page.flatMap((s) => s.rows.flatMap((r) => ("setting" in r ? [r.setting] : [])));
}

/** Every block the page renders, in page order. */
export function blocksOnPage(page: SettingsSection[] = SETTINGS_PAGE): SettingsBlock[] {
    return page.flatMap((s) => s.rows.flatMap((r) => ("block" in r ? [r.block] : [])));
}

/**
 * The Pointing Devices panel's AutoMouse group (the Auto Mouse settings, then its keys), always open
 * like the other key groups. ?panel=pointing-automouse scrolls to it.
 */
export const POINTING_AUTOMOUSE_ID = "pointing-automouse";
