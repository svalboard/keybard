import type { SettingDefinition } from "@/types/settings.types";
import { QMK_SETTINGS } from "@/constants/qmk-settings";
import { TYPING_BEHAVIOR_SECTIONS, type SettingsBlock, type SettingsRow, type SettingsSection } from "./layout";

/**
 * Settings search. A query is split into words; a row matches when every word
 * appears in its label, description, option names or synonyms, or in its
 * section's title or synonyms. A section whose own title or synonyms match
 * shows all its rows; otherwise it shows only the rows that match.
 */

/** Words people search with that are not on screen, by section. */
export const SECTION_SYNONYMS: Record<string, string[]> = {
    hardware: ["clusters", "fragments", "pointing devices"],
    firmware: ["update", "flash", "uf2"],
    backups: ["backup", "back up", "files", "layout files"],
    appearance: ["look", "display", "editor", "keymap"],
    typing: ["qmk settings", "timing"],
    about: ["developer", "dev", "debug"],
};

/** Synonyms for one setting row, by setting name. */
export const ROW_SYNONYMS: Record<string, string[]> = {
    theme: ["dark mode", "theme", "light mode", "night", "color scheme", "appearance"],
    "key-size": ["zoom", "scale", "bigger", "smaller"],
    "panel-position": ["sidebar", "bottom", "dock", "layout"],
    "typing-binds-key": ["keyboard input", "type to assign", "modifiers"],
    "serial-assignment": ["next key", "order", "sequence", "auto advance"],
    "international-keyboards": ["language", "locale", "layout", "qwertz", "azerty", "colemak", "keymap"],
    "combo-indicators": ["corner", "fold", "marker"],
    "colorblind-combo-colors": ["color blind", "accessibility", "texture", "contrast"],
    "show-alt-repeat": ["rail", "repeat"],
    import: ["open", "load", "restore", "svil", "vil"],
    export: ["save", "download", "print", "svil", "vil"],
};

/** The names of the QMK settings Typing behavior shows, and of their groups. */
function typingBehaviorWords(): string[] {
    const tabs = QMK_SETTINGS.tabs.filter((tab) => TYPING_BEHAVIOR_SECTIONS.includes(tab.name));
    return ["tap-hold", "tap hold", "hold", "tapping term", "qmk",
        ...tabs.flatMap((tab) => [tab.name, ...tab.fields.map((f) => f.title)])];
}

/** Synonyms for a block row (rendered by the page itself). */
export const BLOCK_SYNONYMS: Record<SettingsBlock, string[]> = {
    hardware: ["clusters", "cluster presets", "fragments", "finger", "thumb", "5-key", "6-key", "pointing", "trackball",
        "touchpad", "ball", "ball color", "pearl", "auto-detected", "detected", "hardware"],
    touchpad: ["touchpad", "trackpad", "tap", "tap to click", "dead zone", "deadzone", "tap time", "hold time", "press and hold", "drag", "scroll", "tuning", "visualizer"],
    firmware: ["update", "upgrade", "install", "flash", "version", "release", "qmk", "wipe", "reset", "bootloader"],
    board: ["board name", "serial", "rename", "identity"],
    backups: ["backups", "back up now", "restore", "recover", "undo", "history", "snapshot", "backup folder"],
    typing: typingBehaviorWords(),
    about: ["version", "help", "manual", "docs", "community", "discord", "support", "release notes", "credits"],
};

export const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export const queryTerms = (query: string): string[] => normalize(query).split(" ").filter(Boolean);

const containsAll = (haystack: string, terms: string[]) => terms.every((t) => haystack.includes(t));

export type DefinitionLookup = (name: string) => SettingDefinition | undefined;

export const rowKey = (row: SettingsRow) => ("block" in row ? `block:${row.block}` : row.setting);

/** All the text a row can be found by, lowercased. */
export function rowHaystack(row: SettingsRow, lookup: DefinitionLookup): string {
    if ("block" in row) return normalize([row.block, ...BLOCK_SYNONYMS[row.block]].join(" | "));
    const def = lookup(row.setting);
    return normalize([
        row.label ?? def?.label ?? "",
        row.description ?? def?.description ?? "",
        def?.label ?? "",
        ...(def?.items?.map((i) => i.label) ?? []),
        ...(ROW_SYNONYMS[row.setting] ?? []),
    ].join(" | "));
}

export function sectionHaystack(section: SettingsSection): string {
    return normalize([section.title, ...(SECTION_SYNONYMS[section.id] ?? [])].join(" | "));
}

export interface SectionMatch {
    /** Rows to show, by rowKey. */
    rows: Set<string>;
}

/**
 * Which sections and rows a query shows. Null for an empty query (show
 * everything). A section is in the map only if something in it matches.
 */
export function searchSettings(page: SettingsSection[], query: string, lookup: DefinitionLookup): Map<string, SectionMatch> | null {
    const terms = queryTerms(query);
    if (terms.length === 0) return null;
    const result = new Map<string, SectionMatch>();
    for (const section of page) {
        const sectionText = sectionHaystack(section);
        const all = containsAll(sectionText, terms);
        const rows = new Set<string>();
        for (const row of section.rows) {
            // Each word may be found in the row or in its section.
            const text = `${rowHaystack(row, lookup)} | ${sectionText}`;
            if (all || containsAll(text, terms)) rows.add(rowKey(row));
        }
        if (rows.size > 0) result.set(section.id, { rows });
    }
    return result;
}

/** Split text into parts, marking the ones that match a query term. */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
    const terms = queryTerms(query).sort((a, b) => b.length - a.length);
    if (terms.length === 0 || !text) return [{ text, match: false }];
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(${escaped.join("|")})`, "gi");
    return text.split(re).filter((p) => p !== "").map((p) => ({ text: p, match: terms.includes(p.toLowerCase()) }));
}
