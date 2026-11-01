import type { CustomValueEntry, KeyboardInfo } from "../types/keyboard.types";
import { ComboOptions } from "../types/keyboard.types";
import { getClosestPresetColor } from "../utils/color-conversion";
import { FragmentComposerService, isWidgetInstance } from "./fragment-composer.service";
import { FragmentService } from "./fragment.service";
import { keyService } from "./key.service";
import { activeKeycodeVersion } from '@/constants/keycode-numbering';
import { SVALBOARD_VIAL_CUSTOM_KEYCODES, SVALBOARD_VIAL_UID } from '@/constants/svalboard-vial';
import { KleService } from "./kle.service";
import { usableTapdanceTerm } from "@/utils/tapdance-term";
import { isOverrideEnabled, overrideOptionsFromFile } from '@/utils/key-override';
import { importBalls, savedBalls } from "./pointing-look.service";
import { NOT_LAYOUT_VALUES } from "../utils/touchpad-tuning";

// Default template for KBINFO if needed (simplified from SVALBOARD)
const DEFAULT_KB_INFO: any = {
    cols: 6,
    combo_count: 50,
    combos: [],
    key_override_count: 30,
    key_overrides: [],
    macro_count: 16,
    macros: [],
    tapdance_count: 10,
    tapdances: [],
    layers: 4,
    rows: 4,
    keymap: [],
    filters: [],
    // Add other default fields as necessary based on SVALBOARD
    settings: {} as any,
    uid: "0",
    name: "Unknown",
    layout_options: -1
};

/** Keycodes a layout file stores as numbers instead of names (layout ints, "0x…" strings). */
function countRawKeycodes(js: any): number {
    let count = 0;
    const visit = (value: unknown): void => {
        if (typeof value === "string") { if (/^0x[0-9a-f]{1,4}$/i.test(value)) count++; }
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    for (const layer of js.layout ?? []) for (const row of layer) for (const key of row) if (typeof key === "number" && key > 0) count++;
    for (const field of ["layout", "macro", "combo", "tap_dance", "key_override", "alt_repeat_key", "leader", "encoder_layout"]) visit(js[field]);
    return count;
}

export class FileService {
    private static readonly MAX_FILE_SIZE = 1048576; // 1MB
    private kleService: KleService;

    constructor() {
        this.kleService = new KleService();
    }

    async loadFile(file: File): Promise<KeyboardInfo> {
        await this.validateFile(file);
        const content = await this.readFile(file);
        // Use parseContent to handle all file formats (.vil, .svil)
        return this.parseContent(content);
    }

    private async validateFile(file: File): Promise<void> {
        if (file.size > FileService.MAX_FILE_SIZE) {
            throw new Error("File too large");
        }
    }

    private async readFile(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (event) => {
                if (event.target?.result) {
                    resolve(event.target.result as string);
                } else {
                    reject(new Error("Failed to read file"));
                }
            };

            reader.onerror = () => {
                reject(new Error("Failed to read file"));
            };

            reader.readAsText(file);
        });
    }

    private normalizeKeymap(kbinfo: KeyboardInfo): void {
        // If keymap exists and has string values, convert them to numbers
        if (kbinfo.keymap && Array.isArray(kbinfo.keymap)) {
            kbinfo.keymap = kbinfo.keymap.map((layer) => {
                if (Array.isArray(layer)) {
                    return layer.map((keycode) => {
                        // If it's a string, parse it to a number
                        if (typeof keycode === "string") {
                            return keyService.parse(keycode);
                        }
                        // If it's already a number, keep it
                        return keycode;
                    });
                }
                return layer;
            });
        }
    }

    async downloadVIL(kbinfo: KeyboardInfo, includeMacros: boolean = true): Promise<void> {
        const vil = this.kbinfoToVIL(structuredClone(kbinfo), includeMacros);
        await this.downloadTEXT(vil, {
            suggestedName: includeMacros ? 'keyboard.vil' : 'keyboard-nomacro.vil',
            types: [{
                description: 'Vial .vil files',
                accept: {
                    'text/vial': ['.vil'],
                },
            }],
        });
    }

    async downloadSvil(kbinfo: KeyboardInfo, includeMacros: boolean = true): Promise<void> {
        const svil = this.kbinfoToSvil(structuredClone(kbinfo), includeMacros);
        await this.downloadTEXT(svil, {
            suggestedName: includeMacros ? 'keyboard.svil' : 'keyboard-nomacro.svil',
            types: [{
                description: 'Svalboard layout files',
                accept: {
                    'application/json': ['.svil'],
                },
            }],
        });
    }

    /** Save .svil text that is already serialized (e.g. a stored backup). */
    async downloadSvilText(svil: string, suggestedName: string): Promise<void> {
        await this.downloadTEXT(svil, {
            suggestedName,
            types: [{
                description: 'Svalboard layout files',
                accept: {
                    'application/json': ['.svil'],
                },
            }],
        });
    }

    async downloadKeymapH(_kbinfo: KeyboardInfo): Promise<void> {
        // TODO: Implement kbinfoToCKeymap logic here or import it if available
        // For now, leaving as placeholder or assuming global exists (which we should avoid)
        // const content = kbinfoToCKeymap(kbinfo);
        // await this.downloadTEXT(content, { ... });
        console.warn("downloadKeymapH not fully migrated yet");
    }

    private async downloadTEXT(content: string, opts: any) {
        try {
            if ((window as any).showSaveFilePicker) {
                const handle = await (window as any).showSaveFilePicker(opts);
                const writable = await handle.createWritable();
                const blob = new Blob([content], { type: 'text/plain' });
                await writable.write(blob);
                await writable.close();
            } else {
                // Fallback
                const blob = new Blob([content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', opts.suggestedName || 'download.txt');
                link.setAttribute('target', '_blank');
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
            }
        } catch (err) {
            throw err;
        }
    }

    // --- Upload Logic ---

    async uploadFile(file: File): Promise<KeyboardInfo> {
        return this.loadFile(file);
    }

    parseContent(content: string): KeyboardInfo {
        // Extract raw UID before JSON.parse (which loses precision on large numbers)
        const uidMatch = content.match(/"uid"\s*:\s*(\d+)/);
        const rawUidStr = uidMatch ? uidMatch[1] : null;

        const js = JSON.parse(content);
        if (!js || typeof js !== "object" || !("uid" in js)) throw new Error("Unknown file format. Expected .svil or .vil; raw .kbi snapshots are not supported.");
        if (!js || typeof js !== "object" || !Array.isArray(js.layout) || !js.layout.length) {
            throw new Error("Invalid layout file: expected a non-empty layout. Raw .kbi snapshots are not supported; export .svil or .vil instead.");
        }
        const rows = js.layout[0]?.length;
        const cols = js.layout[0]?.[0]?.length;
        if (!rows || !cols || js.layout.some((layer: any) => !Array.isArray(layer) || layer.length !== rows || layer.some((row: any) => !Array.isArray(row) || row.length !== cols || row.some((key: any) => typeof key !== "string" && (!Number.isInteger(key) || key < -1 || key > 65535))))) {
            throw new Error("Invalid layout file: all layers must have the same rectangular matrix and valid keycodes.");
        }
        for (const field of ["macro", "combo", "tap_dance", "key_override", "alt_repeat_key", "leader"]) {
            if (js[field] !== undefined && !Array.isArray(js[field])) throw new Error(`Invalid layout file: ${field} must be a list.`);
            js[field] ??= [];
        }
        let kbinfo: KeyboardInfo | null = null;

        if (js.uid !== undefined && (js.sval_protocol !== undefined || js.svil_protocol !== undefined || js.viable_protocol !== undefined || (js.version === 1 && js.vial_protocol === undefined))) {
            // It's a .svil / legacy .viable file (has uid + svil_protocol or version: 1)
            kbinfo = this.svilToKBINFO(js);
        } else if (js.uid !== undefined) {
            // It's a .vil (has uid but no svil_protocol)
            kbinfo = this.vilToKBINFO(js);
        } else {
            throw new Error('Unknown file format. Expected .svil (or legacy .viable) or .vil file.');
        }

        // Keycodes saved as numbers rather than names are only meaningful in the
        // numbering the file was written in; the import check warns when it differs.
        kbinfo.keycode_version = typeof js.keycode_version === "string" ? js.keycode_version : undefined;
        kbinfo.raw_keycode_count = countRawKeycodes(js);

        // Restore precise UID (JSON.parse loses precision on large integers)
        if (rawUidStr && kbinfo) {
            kbinfo.kbid = BigInt(rawUidStr).toString(16);
        }
        // Some tools wrote Svalboard Vial files with the UID already rounded.
        if (kbinfo?.vial_import?.svalboard) kbinfo.kbid = SVALBOARD_VIAL_UID.toString(16);

        // Deserialize layout using KLE logic
        // We assume convertVIL layout to keymap handled key codes, 
        // but we might need to populate 'keylayout' for UI.
        // In the original code: kbinfo.keylayout = KLE.deserializeToKeylayout(kbinfo, kbinfo.payload.layouts.keymap);
        // We need to implement deserializeToKeylayout.

        // This part depends on where 'payload.layouts.keymap' comes from. 
        // In .vil upload, standard .vil doesn't have QMK payload. 
        // .kbi usually does.

        if (kbinfo.payload?.layouts?.keymap) {
            kbinfo.keylayout = this.deserializeToKeylayout(kbinfo, kbinfo.payload.layouts.keymap as any);
        }

        // Normalize keycodes (string -> number) if necessary
        this.normalizeKeymap(kbinfo);
        if (kbinfo.keymap?.some(layer => layer.some(key => !Number.isInteger(key) || key < 0 || key > 65535))) {
            throw new Error("This layout contains unrecognized keycodes. No changes have been applied.");
        }

        return kbinfo;
    }

    // --- Conversion Logic ---

    kbinfoToVIL(kbinfo: KeyboardInfo, includeMacros: boolean): string {
        let macros: any[];
        if (includeMacros && kbinfo.macros) {
            macros = (kbinfo.macros as any).map((macro: any) => macro.actions);
        } else {
            macros = new Array(kbinfo.macro_count).fill([]);
        }

        const kbidrepl = "BiGKBidGoesHere";
        const vil: any = {
            combo: kbinfo.combos,
            encoder_layout: new Array(16).fill([]), // TODO: check encoder count
            key_override: (kbinfo.key_overrides as any)?.map((ko: any) => {
                const { ...rest } = ko;
                // @ts-ignore
                delete rest.koid;
                return rest;
            }) || [],
            layout_options: -1,
            macro: macros,
            settings: kbinfo.settings,
            tap_dance: (kbinfo.tapdances as any)?.map((td: any) => [td.tap, td.hold, td.doubletap, td.taphold, td.tapping_term]) || [],
            uid: kbidrepl,
            version: 1,
            via_protocol: 12,
            vial_protocol: 6,
        };

        // Layout conversion
        vil.layout = [];
        if (kbinfo.keymap && kbinfo.rows && kbinfo.cols) {
            for (let l = 0; l < (kbinfo.layers || 0); l++) {
                const km = kbinfo.keymap[l];
                const layer = [];
                for (let r = 0; r < kbinfo.rows; r++) {
                    const row = [];
                    for (let c = 0; c < kbinfo.cols; c++) {
                        // Use keyService to convert keycode to string (vilify logic)
                        // Assuming keyService.stringify is compatible or we need custom logic
                        row.push(keyService.stringify(km[(r * kbinfo.cols) + c]));
                    }
                    layer.push(row);
                }
                vil.layout.push(layer);
            }
        }

        let jsvil = JSON.stringify(vil, undefined, 2);
        // Replace placeholder with numeric UID (svil expects number)
        // Use BigInt to handle 64-bit UIDs without precision loss
        const numericUid = kbinfo.kbid ? BigInt('0x' + kbinfo.kbid).toString() : '0';
        jsvil = jsvil.replace('"' + kbidrepl + '"', numericUid);
        return jsvil;
    }

    /**
     * Convert KeyboardInfo to .svil format (native Svalboard layout format; same JSON structure as viable-gui's layout files)
     * This format preserves all Svil-specific features
     */
    kbinfoToSvil(kbinfo: KeyboardInfo, includeMacros: boolean = true): string {
        // Build layout array [layers][rows][cols]
        const layout: string[][][] = [];
        if (kbinfo.keymap && kbinfo.rows && kbinfo.cols) {
            for (let l = 0; l < (kbinfo.layers || 0); l++) {
                const layerArr: string[][] = [];
                const km = kbinfo.keymap[l];
                for (let r = 0; r < kbinfo.rows; r++) {
                    const rowArr: string[] = [];
                    for (let c = 0; c < kbinfo.cols; c++) {
                        rowArr.push(keyService.stringify(km[(r * kbinfo.cols) + c]));
                    }
                    layerArr.push(rowArr);
                }
                layout.push(layerArr);
            }
        }

        // Backups preserve text verbatim. Firmware compatibility is checked at import.
        const macros = includeMacros
            ? (kbinfo.macros || []).map(macro => macro.actions || [])
            : new Array(kbinfo.macro_count || 0).fill([]);

        // Build tap dances (dict format with "on" flag)
        // Tap dance values are stored as strings, use them directly
        const tapDances = (kbinfo.tapdances || []).map((td: any) => ({
            on: td.enabled !== false,
            on_tap: typeof td.tap === 'string' ? td.tap : keyService.stringify(td.tap || 0),
            on_hold: typeof td.hold === 'string' ? td.hold : keyService.stringify(td.hold || 0),
            on_double_tap: typeof td.doubletap === 'string' ? td.doubletap : keyService.stringify(td.doubletap || 0),
            on_tap_hold: typeof td.taphold === 'string' ? td.taphold : keyService.stringify(td.taphold || 0),
            tapping_term: td.tapping_term ?? 200,
        }));

        // Build combos (dict format with "on" flag).
        // In-memory combos use a single uint16 `options` field (bit 15 = enabled,
        // bits 0-14 = combo term) matching the wire format. Decompose for the
        // file's separate on/combo_term fields.
        const combos = (kbinfo.combos || []).map((c: any) => {
            const opts = (c.options ?? 0) >>> 0;
            return {
                on: (opts & ComboOptions.ENABLED) !== 0,
                keys: (c.keys || []).map((k: any) => typeof k === 'string' ? k : keyService.stringify(k)),
                output: typeof c.output === 'string' ? c.output : keyService.stringify(c.output || 0),
                combo_term: opts & 0x7FFF,
            };
        });

        // Build key overrides (dict format with "on" flag)
        // "on" is derived from options bit 7, the only owner of on/off.
        const keyOverrides = (kbinfo.key_overrides || []).map((ko: any) => ({
            on: isOverrideEnabled(ko),
            trigger: typeof ko.trigger === 'string' ? ko.trigger : keyService.stringify(ko.trigger || 0),
            replacement: typeof ko.replacement === 'string' ? ko.replacement : keyService.stringify(ko.replacement || 0),
            layers: ko.layers ?? 0xFFFF,
            trigger_mods: ko.trigger_mods || 0,
            negative_mod_mask: ko.negative_mod_mask || 0,
            suppressed_mods: ko.suppressed_mods || 0,
            options: ko.options || 0,
        }));

        // Build alt repeat keys (Svil-specific)
        const altRepeatKeys = (kbinfo.alt_repeat_keys || []).map((ark: any) => ({
            on: ark.enabled !== false,
            keycode: typeof ark.keycode === 'string' ? ark.keycode : keyService.stringify(ark.keycode || 0),
            alt_keycode: typeof ark.alt_keycode === 'string' ? ark.alt_keycode : keyService.stringify(ark.alt_keycode || 0),
            allowed_mods: ark.allowed_mods || 0,
            options: ark.options || 0,
        }));

        // Build leaders (Svil-specific)
        const leaders = (kbinfo.leaders || []).map((ldr: any) => ({
            on: ldr.enabled !== false,
            sequence: (ldr.sequence || []).map((k: any) => typeof k === 'string' ? k : keyService.stringify(k)),
            output: typeof ldr.output === 'string' ? ldr.output : keyService.stringify(ldr.output || 0),
            options: ldr.options || 0,
        }));

        // Build one-shot settings
        const oneshot = kbinfo.one_shot ? {
            timeout: kbinfo.one_shot.timeout || 0,
            tap_toggle: kbinfo.one_shot.tap_toggle || 0,
        } : null;

        // Build the .svil structure
        // Use placeholder for UID since we need BigInt for 64-bit precision
        const uidPlaceholder = "UID_PLACEHOLDER_FOR_BIGINT";
        const svil: any = {
            version: 1,
            uid: uidPlaceholder,
            layout,
            encoder_layout: [], // TODO: implement encoder support
            layout_options: -1,
            macro: macros,
            svil_protocol: kbinfo.svil_proto || 1,
            // Keycodes are written by name; a keycode with no name is written as a
            // number, which only means something in this numbering.
            keycode_version: activeKeycodeVersion(),
            via_protocol: kbinfo.via_proto || 12,
            tap_dance: tapDances,
            combo: combos,
            key_override: keyOverrides,
            alt_repeat_key: altRepeatKeys,
            leader: leaders,
            settings: kbinfo.settings || {},
        };

        // Only include oneshot if present
        if (oneshot) {
            svil.oneshot = oneshot;
        }

        // Save resolved fragment selections for each instance (not just user selections)
        // This captures hardware-detected, EEPROM, or user-selected fragments
        if (kbinfo.composition?.instances && kbinfo.fragments) {
            const fragmentService = new FragmentService(null as any); // No USB needed
            const resolvedSelections: Record<string, string> = {};
            const getUserSelection = (instanceId: string): string | undefined => {
                const selections = kbinfo.fragmentState?.userSelections;
                if (!selections) return undefined;
                if (selections instanceof Map) {
                    return selections.get(instanceId);
                }
                return (selections as Record<string, string>)[instanceId];
            };

            kbinfo.composition.instances.forEach((instance, idx) => {
                // Widget instances (pointing slots) follow detection; they are not a selection.
                if (instance.fragment_options && !isWidgetInstance(kbinfo, instance)) {
                    const userSelection = getUserSelection(instance.id);
                    const hasUserSelection = userSelection
                        ? instance.fragment_options.some((opt) => opt.fragment === userSelection)
                        : false;
                    const resolved = hasUserSelection
                        ? userSelection!
                        : fragmentService.resolveFragment(kbinfo, idx, instance);
                    if (resolved) {
                        resolvedSelections[instance.id] = resolved;
                    }
                }
            });

            if (Object.keys(resolvedSelections).length > 0) {
                svil.fragment_selections = resolvedSelections;
            }
        }

        // Save fragment definitions and composition for offline loading
        if (kbinfo.fragments) {
            svil.fragments = kbinfo.fragments;
        }
        if (kbinfo.composition) {
            svil.composition = kbinfo.composition;
        }

        // Save keylayout for physical key positions (needed for proper rendering)
        if (kbinfo.keylayout) {
            svil.keylayout = kbinfo.keylayout;
        }

        // Save VIA3 dynamic menus (pointing device settings, etc.)
        if (kbinfo.menus) {
            svil.menus = kbinfo.menus;
        }

        // Save cosmetic data (layer names, etc.)
        if (kbinfo.cosmetic) {
            svil.cosmetic = kbinfo.cosmetic;
        }
        // The trackball ball each hand shows (kept per board in this browser, never on the board).
        const pointingBalls = savedBalls(kbinfo.kbid);
        if (Object.keys(pointingBalls).length) {
            svil.cosmetic = { ...(svil.cosmetic ?? {}), pointing_balls: pointingBalls };
        }

        // Save custom values (VIA3 dynamic menu values + layer colors)
        // Uses kbinfo.custom_values which are loaded at connect time with raw bytes
        const customValues: Array<{ key: string; channel: number; valueId: number; data: number[] }> = [];

        // Save layer colors from kbinfo.layer_colors (matching viable-gui format)
        if (kbinfo.layer_colors && kbinfo.layer_colors.length > 0) {
            kbinfo.layer_colors.forEach((color, idx) => {
                if (color) {
                    customValues.push({
                        key: `id_layer${idx}_color`,
                        channel: 0,
                        valueId: idx, // layer color index
                        data: [color.hue, color.sat]
                    });
                }
            });
        }

        // Save all VIA3 custom values from kbinfo (loaded at connect time)
        if (kbinfo.custom_values) {
            for (const entry of kbinfo.custom_values) {
                // Skip layer colors (already handled above)
                if (entry.key.match(/^id_layer\d+_color$/)) continue;
                // Per-board settings that aren't layout (the touchpad mode).
                if (NOT_LAYOUT_VALUES.includes(entry.key)) continue;
                customValues.push({
                    key: entry.key,
                    channel: entry.channel,
                    valueId: entry.valueId,
                    data: entry.data,
                });
            }
        }

        if (customValues.length > 0) {
            svil.custom_values = customValues;
        }

        // Stringify and replace UID placeholder with BigInt value (no quotes)
        let result = JSON.stringify(svil, undefined, 2);
        const numericUid = kbinfo.kbid ? BigInt('0x' + kbinfo.kbid).toString() : '0';
        result = result.replace('"' + uidPlaceholder + '"', numericUid);
        return result;
    }

    vilToKBINFO(vil: any): KeyboardInfo {
        const kbinfo: KeyboardInfo = structuredClone(DEFAULT_KB_INFO) as KeyboardInfo;

        // Vial names a board's custom keycodes by position (USER03). From
        // Svalboard's Vial firmware, give each its name, which Svalboard QMK
        // shares; a position Vial left unassigned did nothing there.
        // JSON parsing rounds the 64-bit UID, so compare it at that precision.
        const svalboard = Number(vil.uid) === Number(SVALBOARD_VIAL_UID);
        let unassigned = 0, foreign = 0;
        const named = (key: any): any => {
            const user = typeof key === 'string' ? /^USER(\d+)$/.exec(key) : null;
            if (!user) return key;
            if (!svalboard) { foreign++; return key; }
            const custom = SVALBOARD_VIAL_CUSTOM_KEYCODES[Number(user[1])];
            if (custom) return custom.name;
            unassigned++;
            return 'KC_NO';
        };
        if (svalboard) {
            kbinfo.custom_keycodes = SVALBOARD_VIAL_CUSTOM_KEYCODES.map(custom => ({ ...custom }));
            keyService.generateAllKeycodes(kbinfo);
        }
        const used = (key: any) => key !== 'KC_NO' && key !== 'KC_TRNS' && key !== -1 && key !== 0;

        kbinfo.key_override_count = vil.key_override?.length || 0;
        kbinfo.combo_count = vil.combo?.length || 0;
        kbinfo.macro_count = vil.macro?.length || 0;
        kbinfo.tapdance_count = vil.tap_dance?.length || 0;

        // Vial combos have no enable flag or timing of their own: a combo with
        // keys is on and uses the global combo term (0).
        kbinfo.combos = (vil.combo || []).map((combo: any[], cmbid: number) => {
            const keys = combo.slice(0, 4).map(named);
            return { cmbid, keys, output: named(combo[4]), options: used(keys[0]) ? ComboOptions.ENABLED : 0 };
        });
        kbinfo.key_overrides = (vil.key_override || []).map((ko: any, koid: number) => ({
            koid,
            trigger: named(ko.trigger),
            replacement: named(ko.replacement),
            layers: ko.layers ?? 0xFFFF,
            trigger_mods: ko.trigger_mods || 0,
            negative_mod_mask: ko.negative_mod_mask || 0,
            suppressed_mods: ko.suppressed_mods || 0,
            options: ko.options || 0, // bit 7 = enabled, in both firmwares
        }));
        // A .vil macro action is [type, value, value...]; split it into [type, value] pairs.
        kbinfo.macros = (vil.macro || []).map((macro: any[], mid: number) => {
            const actions: any[] = [];
            for (const act of macro) {
                if (!Array.isArray(act)) continue;
                for (let i = 1; i < act.length; i++) {
                    actions.push([act[0], ['tap', 'down', 'up'].includes(act[0]) ? named(act[i]) : act[i]]);
                }
            }
            return { actions, mid };
        });

        kbinfo.vial_proto = vil.vial_protocol || 6;
        kbinfo.settings = vil.settings;
        // A Vial tap dance with any action is on.
        kbinfo.tapdances = (vil.tap_dance || []).map((td: any[], idx: number) => {
            const [tap, hold, doubletap, taphold] = td.slice(0, 4).map(named);
            return { idx, enabled: true, tap, hold, doubletap, taphold, tapping_term: usableTapdanceTerm(td[4]) };
        });

        // vil.layout is [layer][row][col]; -1 marks an unused position.
        const km: number[][] = [];
        const keylayout: any[] = [];
        if (vil.layout) {
            const layers = vil.layout.length;
            const rows = vil.layout[0]?.length || 0;
            const cols = vil.layout[0]?.[0]?.length || 0;
            kbinfo.layers = layers;
            kbinfo.rows = rows;
            kbinfo.cols = cols;

            for (let l = 0; l < layers; l++) {
                km.push([]);
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        const keyStr = named(vil.layout[l][r][c]);
                        km[l][(r * cols) + c] = keyStr === -1 ? 0 : typeof keyStr === 'string' ? keyService.parse(keyStr) : keyStr;
                        if (l === 0) {
                            keylayout.push({ x: c, y: r, w: 1, h: 1, label: "", matrix: [(r * cols) + c] });
                        }
                    }
                }
            }
        }
        kbinfo.keymap = km;
        (kbinfo as any).keylayout = keylayout;
        kbinfo.kbid = '' + vil.uid;
        kbinfo.vial_import = { svalboard, unassigned_custom_keycodes: unassigned, foreign_custom_keycodes: foreign };

        return kbinfo;
    }

    /**
     * Convert .svil format to KeyboardInfo
     * .svil (formerly .viable) uses viable-gui's dict-style entries
     */
    svilToKBINFO(svil: any): KeyboardInfo {
        const kbinfo: KeyboardInfo = structuredClone(DEFAULT_KB_INFO) as KeyboardInfo;

        // Store protocol versions
        kbinfo.svil_proto = svil.sval_protocol || svil.svil_protocol || svil.viable_protocol || 1; // viable_protocol: legacy .viable files
        kbinfo.via_proto = svil.via_protocol || 12;

        // A Svalboard layout names Svalboard's own keys (SV_SNIPER_3). A connected
        // Svalboard registers them from its definition; with none, take them from
        // the built-in list, which keeps the firmware's positions (QK_USER_0 on).
        // JSON parsing rounds the 64-bit UID, so compare it at that precision.
        if (Number(svil.uid) === Number(SVALBOARD_VIAL_UID)) {
            keyService.registerKnownCustomKeycodes(SVALBOARD_VIAL_CUSTOM_KEYCODES);
        }

        // Update counts from data
        kbinfo.key_override_count = svil.key_override?.length || 0;
        kbinfo.combo_count = svil.combo?.length || 0;
        kbinfo.macro_count = svil.macro?.length || 0;
        kbinfo.tapdance_count = svil.tap_dance?.length || 0;
        kbinfo.alt_repeat_key_count = svil.alt_repeat_key?.length || 0;
        kbinfo.leader_count = svil.leader?.length || 0;

        // Convert combos (dict format with "on" flag) into the in-memory shape
        // (single uint16 `options`, bit 15 = enabled, bits 0-14 = combo term).
        kbinfo.combos = (svil.combo || []).map((c: any, cmbid: number) => {
            const term = (c.combo_term || 0) & 0x7FFF;
            const enabled = c.on !== false;
            return {
                cmbid,
                keys: c.keys || [],
                output: c.output,
                options: term | (enabled ? ComboOptions.ENABLED : 0),
            };
        });

        // Convert key overrides (dict format)
        kbinfo.key_overrides = (svil.key_override || []).map((ko: any, koid: number) => ({
            koid,
            trigger: ko.trigger,
            replacement: ko.replacement,
            layers: ko.layers ?? 0xFFFF,
            trigger_mods: ko.trigger_mods || 0,
            negative_mod_mask: ko.negative_mod_mask || 0,
            suppressed_mods: ko.suppressed_mods || 0,
            options: overrideOptionsFromFile(ko.on, ko.options),
        }));

        // Convert macros
        kbinfo.macros = (svil.macro || []).map((macro: any[], mid: number) => {
            const actions: any[] = [];
            for (const act of macro) {
                if (Array.isArray(act)) {
                    for (let i = 1; i < act.length; i++) {
                        actions.push([act[0], act[i]]);
                    }
                }
            }
            return { actions, mid };
        });

        // Convert tap dances (dict format with "on" flag)
        // Keep tap/hold/doubletap/taphold as strings (that's what the UI expects)
        kbinfo.tapdances = (svil.tap_dance || []).map((td: any, tdid: number) => ({
            idx: tdid,
            // Tap dances are always on, and a term below the minimum breaks one.
            enabled: true,
            tap: td.on_tap || 'KC_NO',
            hold: td.on_hold || 'KC_NO',
            doubletap: td.on_double_tap || 'KC_NO',
            taphold: td.on_tap_hold || 'KC_NO',
            tapping_term: usableTapdanceTerm(td.tapping_term),
        }));

        // Convert alt repeat keys (Svil-specific)
        kbinfo.alt_repeat_keys = (svil.alt_repeat_key || []).map((ark: any, arkid: number) => ({
            arkid,
            enabled: ark.on !== false,
            keycode: typeof ark.keycode === 'string' ? ark.keycode : keyService.stringify(ark.keycode || 0),
            alt_keycode: typeof ark.alt_keycode === 'string' ? ark.alt_keycode : keyService.stringify(ark.alt_keycode || 0),
            allowed_mods: ark.allowed_mods || 0,
            options: ark.options || 0,
        }));

        // Convert leaders (Svil-specific)
        kbinfo.leaders = (svil.leader || []).map((ldr: any, ldrid: number) => ({
            ldrid,
            enabled: ldr.on !== false,
            sequence: (ldr.sequence || []).map((k: any) => typeof k === 'string' ? k : keyService.stringify(k || 0)),
            output: typeof ldr.output === 'string' ? ldr.output : keyService.stringify(ldr.output || 0),
            options: ldr.options || 0,
        }));

        // Convert one-shot settings (Svil-specific)
        if (svil.oneshot) {
            kbinfo.one_shot = {
                timeout: svil.oneshot.timeout || 0,
                tap_toggle: svil.oneshot.tap_toggle || 0,
            };
        }

        kbinfo.settings = svil.settings || {};

        // Convert layout to keymap
        const km: number[][] = [];
        const keylayout: any[] = [];
        if (svil.layout) {
            const layers = svil.layout.length;
            const rows = svil.layout[0]?.length || 0;
            const cols = svil.layout[0]?.[0]?.length || 0;

            kbinfo.layers = layers;
            kbinfo.rows = rows;
            kbinfo.cols = cols;

            for (let l = 0; l < layers; l++) {
                km.push([]);
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        const keyStr = svil.layout[l][r][c];
                        // Handle -1 as KC_NO (unused key position)
                        let keycode: number;
                        if (keyStr === -1) {
                            keycode = 0; // KC_NO
                        } else if (typeof keyStr === 'string') {
                            keycode = keyService.parse(keyStr);
                        } else {
                            keycode = keyStr;
                        }
                        km[l][(r * cols) + c] = keycode;

                        if (l === 0) {
                            keylayout.push({
                                x: c,
                                y: r,
                                w: 1,
                                h: 1,
                                label: "",
                                matrix: [(r * cols) + c]
                            });
                        }
                    }
                }
            }
        }
        kbinfo.keymap = km;
        kbinfo.kbid = '' + svil.uid;

        // Restore keylayout from file if available, otherwise use generated fallback
        if (svil.keylayout) {
            kbinfo.keylayout = svil.keylayout;
            console.log("Loaded keylayout from file:", Object.keys(svil.keylayout).length, "keys");
        } else {
            kbinfo.keylayout = keylayout;
        }

        // Restore VIA3 dynamic menus (pointing device settings, etc.)
        if (svil.menus) {
            kbinfo.menus = svil.menus;
        }

        // Restore cosmetic data (layer names, etc.)
        if (svil.cosmetic) {
            const { pointing_balls: pointingBalls, ...cosmetic } = svil.cosmetic as Record<string, unknown>;
            kbinfo.cosmetic = cosmetic as KeyboardInfo["cosmetic"];
            if (pointingBalls) importBalls(kbinfo.kbid, pointingBalls);
        }

        // Restore fragment definitions and composition
        if (svil.fragments) {
            kbinfo.fragments = svil.fragments;
        }
        if (svil.composition) {
            kbinfo.composition = svil.composition;
        }

        // Restore fragment selections if present
        if (svil.fragment_selections) {
            kbinfo.fragmentState = {
                hwDetection: new Map(),
                eepromSelections: new Map(),
                userSelections: new Map(Object.entries(svil.fragment_selections)),
            };
        }

        // Restore custom_values (layer colors + VIA3 menu values)
        if (svil.custom_values && Array.isArray(svil.custom_values)) {
            const layerColors: Array<{ hue: number; sat: number; val: number }> = [];
            const customValues: CustomValueEntry[] = [];

            for (const cv of svil.custom_values) {
                // Check if it's a layer color value (id_layerX_color)
                const match = cv.key?.match(/^id_layer(\d+)_color$/);
                if (match && Array.isArray(cv.data) && cv.data.length >= 2) {
                    const layerIdx = parseInt(match[1], 10);
                    layerColors[layerIdx] = {
                        hue: cv.data[0],
                        sat: cv.data[1],
                        val: 255,
                    };
                } else if (cv.key && Array.isArray(cv.data) && cv.data.length >= 1) {
                    // Non-layer-color custom value (pointing device settings, etc.)
                    // New format has channel/valueId; old format has only key + data
                    customValues.push({
                        key: cv.key,
                        channel: cv.channel ?? 0,
                        valueId: cv.valueId ?? 0,
                        data: cv.data,
                    });
                }
            }

            if (layerColors.length > 0) {
                kbinfo.layer_colors = layerColors;
                console.log("Restored layer_colors from file:", layerColors.length, "colors");

                if (!kbinfo.cosmetic) {
                    kbinfo.cosmetic = { layer: {}, layer_colors: {} };
                }
                if (!kbinfo.cosmetic.layer_colors) {
                    kbinfo.cosmetic.layer_colors = {};
                }
                layerColors.forEach((c, idx) => {
                    if (c) {
                        const presetName = getClosestPresetColor(c.hue, c.sat, c.val);
                        kbinfo.cosmetic!.layer_colors![idx.toString()] = presetName;
                    }
                });
                console.log("Cosmetic layer colors restored:", kbinfo.cosmetic.layer_colors);
            }

            if (customValues.length > 0) {
                kbinfo.custom_values = customValues;
                console.log("Restored custom values from file:", customValues.length, "entries");
            }
        }

        // Compose layout from fragments if available
        if (kbinfo.fragments && kbinfo.composition) {
            try {
                const fragmentService = new FragmentService(null as any); // No USB needed for offline
                const fragmentComposer = new FragmentComposerService(this.kleService, fragmentService);
                if (fragmentComposer.hasFragments(kbinfo)) {
                    const composedLayout = fragmentComposer.composeLayout(kbinfo);
                    if (Object.keys(composedLayout).length > 0) {
                        kbinfo.keylayout = composedLayout;
                        console.log("Fragment layout composed from file:", Object.keys(composedLayout).length, "keys");
                    }
                }
            } catch (e) {
                console.warn("Failed to compose fragment layout from file:", e);
            }
        }

        return kbinfo;
    }

    // Minimal implementation of KLE deserializeToKeylayout
    // For full support, we might need the full KLE library logic.
    // This is a simplified version based on `kle.js` snippet logic.
    // Simplified KLE Deserializer to KeyLayout
    private deserializeToKeylayout(kbinfo: KeyboardInfo, rows: any[]): any {
        return this.kleService.deserializeToKeylayout(kbinfo, rows);
    }
}

export const fileService = new FileService();
