import type { KeyboardInfo } from '../types/keyboard.types';
import { customValueService } from './custom-value.service';
import { MacroService } from './macro.service';
import { LabelService, validateLabelText } from './label.service';
import { keyService } from './key.service';
import { activeKeycodeVersion } from '@/constants/keycode-numbering';
import { usbInstance } from './usb.service';
import { FragmentService, NO_SELECTION } from './fragment.service';
import { FragmentComposerService } from './fragment-composer.service';
import { KleService } from './kle.service';
import { getClosestPresetColor } from '../utils/color-conversion';
import { sameCombo } from '../utils/combo-names';
import { boardMenuRefs, migrateCustomValues, type SettingReplacement } from './settings-migrate';
import { customValueLabel, qmkSettingLabel } from '../utils/setting-labels';
import { VARIABLE_LIMITS, ZERO_REPLACED_SETTINGS, ZERO_SETTINGS_RELEASE } from '../constants/qmk-settings';

export interface ImportReview {
    keyboard: KeyboardInfo;
    errors: string[];
    warnings: string[];
    summary: string[];
    /** Settings carried to the setting this firmware has in their place; their values are applied. */
    replaced: SettingReplacement[];
    /** Names of settings in the file that this firmware doesn't have; the keyboard keeps its own. */
    unavailable: string[];
}

/** Table names as people say them, for the capacity errors. */
const TABLE_NAMES = { macros: 'macros', combos: 'combos', tapdances: 'tap dances', key_overrides: 'key overrides', alt_repeat_keys: 'alt-repeat keys', leaders: 'leader sequences' } as const;

/**
 * A 0 in a setting that can't work at 0 (a leader timeout of 0 came from older
 * firmware's settings reset, and Keybard's default layouts carried it) is
 * imported as that setting's default, the value x4.3.3 firmware also stores in
 * its place. Each one is listed in the replaced-settings note.
 */
function replaceZeroSettings(settings: Record<number, number>): SettingReplacement[] {
    const replaced: SettingReplacement[] = [];
    for (const [id, fallback] of Object.entries(ZERO_REPLACED_SETTINGS)) {
        const qsid = Number(id);
        if (settings[qsid] !== 0) continue;
        settings[qsid] = fallback;
        const label = qmkSettingLabel(qsid);
        replaced.push({ from: `${label}: 0`, to: String(fallback), release: ZERO_SETTINGS_RELEASE });
    }
    return replaced;
}

/**
 * A value above what the firmware variable can hold (a mouse key interval of
 * 300, say: older firmware wrapped it to 44) is imported as that limit, the
 * largest value that works, and listed in the replaced-settings note.
 */
function holdSettingsAtLimits(settings: Record<number, number>): SettingReplacement[] {
    const replaced: SettingReplacement[] = [];
    for (const [id, limit] of Object.entries(VARIABLE_LIMITS)) {
        const qsid = Number(id);
        if (!(settings[qsid] > limit)) continue;
        replaced.push({ from: `${qmkSettingLabel(qsid)}: ${settings[qsid]}`, to: String(limit) });
        settings[qsid] = limit;
    }
    return replaced;
}

/** Pure preflight: never queues commands or touches the device. */
export function prepareImport(file: KeyboardInfo, current?: KeyboardInfo): ImportReview {
    const errors: string[] = [], warnings: string[] = [], unavailable: string[] = [];
    let replaced: SettingReplacement[] = [];
    const summary = [`${file.layers ?? 0} layers`, `${file.macros?.length ?? 0} macros`, `${file.combos?.length ?? 0} combos`, `${file.tapdances?.length ?? 0} tap dances`, `${file.key_overrides?.length ?? 0} overrides`];
    if (file.alt_repeat_keys?.length) summary.push(`${file.alt_repeat_keys.length} alt-repeat keys`);
    if (file.leaders?.length) summary.push(`${file.leaders.length} leader sequences`);
    if (!current) return { keyboard: structuredClone(file), errors, warnings, summary, replaced, unavailable };
    const next = structuredClone(current);
    if (file.rows !== current.rows || file.cols !== current.cols) errors.push(`Matrix mismatch: file ${file.rows} × ${file.cols}; keyboard ${current.rows} × ${current.cols}. Automatic remapping is not supported.`);
    if ((file.layers ?? 0) > (current.layers ?? 0)) errors.push(`The file has ${file.layers} layers; this keyboard supports ${current.layers}.`);
    if (file.kbid && current.kbid && file.kbid.toLowerCase() !== current.kbid.toLowerCase()) warnings.push('This file identifies a different keyboard. Matching dimensions do not guarantee matching physical key positions.');
    const boardNumbering = current.keycode_version ?? activeKeycodeVersion();
    if (file.raw_keycode_count && file.keycode_version !== boardNumbering) {
        warnings.push(`${file.raw_keycode_count} keycode${file.raw_keycode_count === 1 ? ' is' : 's are'} stored as a number rather than a name, written in ${file.keycode_version ? `QMK keycode numbering ${file.keycode_version}` : 'an unrecorded keycode numbering'}; this keyboard uses ${boardNumbering}. Check ${file.raw_keycode_count === 1 ? 'it' : 'them'} after importing.`);
    }
    const vial = file.vial_import;
    if (vial?.foreign_custom_keycodes) errors.push(`This Vial layout uses ${vial.foreign_custom_keycodes} custom key${vial.foreign_custom_keycodes === 1 ? '' : 's'} (USER00…) from another keyboard's firmware, which this keyboard cannot interpret.`);
    if (vial?.unassigned_custom_keycodes) warnings.push(`${vial.unassigned_custom_keycodes} key${vial.unassigned_custom_keycodes === 1 ? ' uses a custom keycode' : 's use custom keycodes'} that Svalboard's Vial firmware left unassigned; ${vial.unassigned_custom_keycodes === 1 ? 'it' : 'they'} did nothing there and will be set to KC_NO.`);
    if (vial?.svalboard) warnings.push('Vial layout files do not include pointing and hardware settings (DPI, scrolling, automouse, layer colors). Set them again after importing.');
    next.keymap = current.keymap?.map((layer, index) => file.keymap?.[index] ? [...file.keymap[index]] : [...layer]);
    for (const [field, count] of [['macros','macro_count'], ['combos','combo_count'], ['tapdances','tapdance_count'], ['key_overrides','key_override_count'], ['alt_repeat_keys','alt_repeat_key_count'], ['leaders','leader_count']] as const) {
        const incoming = file[field];
        if (!incoming) continue;
        if (incoming.length > (current[count] ?? 0)) errors.push(`The file has ${incoming.length} ${TABLE_NAMES[field]}; this keyboard holds ${current[count] ?? 0}.`);
        (next as any)[field] = Array.from({ length: Math.max(current[field]?.length ?? 0, incoming.length) }, (_, index) => incoming[index] ?? current[field]?.[index]);
    }
    if (file.macros?.some(macro => macro.actions.some(action => action[0] === 'text' && /[^\x20-\x7e]/.test(String(action[1]))))) {
        errors.push('Macro text contains non-ASCII or control characters. The backup preserves them, but this firmware cannot reliably type them. Edit those macros before importing.');
    }
    for (const macro of file.macros ?? []) {
        for (const action of macro.actions ?? []) {
            if (!['text', 'delay', 'tap', 'down', 'up'].includes(action[0])) errors.push(`Unsupported macro action: ${action[0]}.`);
            if (action[0] === 'delay' && (!Number.isInteger(action[1]) || Number(action[1]) < 0 || Number(action[1]) > 65024)) errors.push('Macro delays must be whole milliseconds between 0 and 65024.');
        }
    }
    const validKey = (key: string | number) => {
        const value = keyService.parse(key);
        return Number.isInteger(value) && value >= 0 && value <= 65535;
    };
    for (const [index, macro] of (file.macros ?? []).entries()) {
        for (const action of macro.actions ?? []) {
            if (['tap', 'down', 'up'].includes(action[0]) && !validKey(action[1])) errors.push(`Macro ${index} contains an unrecognized keycode.`);
        }
    }
    if (file.combos?.some(combo => [...combo.keys, combo.output].some(key => !validKey(key)))) errors.push('A combo contains an unrecognized keycode.');
    if (file.tapdances?.some(td => [td.tap, td.hold, td.doubletap, td.taphold].some(key => !validKey(key)))) errors.push('A tap dance contains an unrecognized keycode.');
    if (file.tapdances?.some(td => !Number.isInteger(td.tapping_term) || td.tapping_term < 0 || td.tapping_term > 32767)) errors.push('Tap dance timing must be whole milliseconds between 0 and 32767.');
    if (file.key_overrides?.some(override => [override.trigger, override.replacement].some(key => !validKey(key)))) errors.push('An override contains an unrecognized keycode.');
    if (file.alt_repeat_keys?.some(ark => [ark.keycode, ark.alt_keycode].some(key => !validKey(key)))) errors.push('An alt-repeat key contains an unrecognized keycode.');
    if (file.alt_repeat_keys?.some(ark => [ark.allowed_mods, ark.options].some(value => !Number.isInteger(value) || value < 0 || value > 255))) errors.push('Alt-repeat key modifiers and options must be whole numbers between 0 and 255.');
    if (file.leaders?.some(leader => !Array.isArray(leader.sequence) || leader.sequence.length > 5 || [...leader.sequence, leader.output].some(key => !validKey(key)))) errors.push('A leader sequence contains an unrecognized keycode or more than 5 keys.');
    if (file.leaders?.some(leader => !Number.isInteger(leader.options) || leader.options < 0 || leader.options > 65535)) errors.push('Leader options must be whole numbers between 0 and 65535.');
    if (Object.values(file.settings ?? {}).some(value => !Number.isInteger(value) || value < 0)) errors.push('QMK settings must contain non-negative integer values.');
    if (file.macros?.length) {
        try { new MacroService(usbInstance).dump(current.macros_size ?? 0, next.macros ?? []); }
        catch { errors.push('The imported macros do not fit the keyboard’s macro buffer or contain invalid actions.'); }
    }
    restoreFragments(file, current, next, warnings);
    next.settings = { ...current.settings };
    for (const [id, value] of Object.entries(file.settings ?? {})) {
        if (Object.prototype.hasOwnProperty.call(current.settings ?? {}, id)) next.settings[Number(id)] = value;
        else unavailable.push(qmkSettingLabel(Number(id)));
    }
    // Before the one-shot block copies 5 and 6, so it gets the held value too.
    const limited = holdSettingsAtLimits(next.settings);
    // One-shot timeout and tap toggle are QMK settings 6 and 5, restored with the others.
    // Files may also hold an older one-shot block that no Keybard screen could set; the settings win.
    if (next.one_shot && next.settings && 5 in next.settings && 6 in next.settings) next.one_shot = { timeout: next.settings[6], tap_toggle: next.settings[5] };
    const boardRefs = boardMenuRefs(current.menus);
    const menuItems = new Map([...boardRefs].map(([key, { item }]) => [key, item]));
    // Settings a firmware release replaced land on their replacement, either way round.
    const migrated = migrateCustomValues(file.custom_values ?? [], boardRefs);
    replaced = [...replaceZeroSettings(next.settings), ...limited, ...migrated.replaced];
    // Layer colors are custom values on the board; the file loader keeps them in layer_colors.
    const layerColorValues = (file.layer_colors ?? []).flatMap((color, layer) =>
        color && layer < (current.layers ?? 0) ? [{ key: `id_layer${layer}_color`, channel: 0, valueId: 0, data: [color.hue, color.sat] }] : []);
    const supportedValues = [...migrated.values, ...layerColorValues].filter(entry => {
        if (menuItems.has(entry.key)) {
            const name = customValueLabel(entry.key, current.menus);
            const width = customValueService.getByteWidth(menuItems.get(entry.key)!);
            if (entry.data.length !== width && !(entry.data.length === 1 && width > 1)) errors.push(`The setting ${name} has ${entry.data.length} bytes; the keyboard expects ${width}.`);
            if (entry.data.length === 1 && entry.data[0] >= 2 ** (8 * width)) errors.push(`The setting ${name} exceeds the keyboard’s ${width}-byte value capacity.`);
            if (!Array.isArray(entry.data) || !entry.data.length || entry.data.some(value => !Number.isInteger(value) || value < 0 || (entry.data.length > 1 && value > 255))) errors.push(`The setting ${name} contains invalid value bytes.`);
            return true;
        }
        unavailable.push(customValueLabel(entry.key, file.menus));
        return false;
    });
    next.custom_values = [...(current.custom_values ?? []).filter(entry => !supportedValues.some(value => value.key === entry.key)), ...supportedValues];
    next.cosmetic = { ...current.cosmetic };
    for (const entry of supportedValues) {
        const layer = Number(entry.key.match(/^id_layer(\d+)_color$/)?.[1] ?? -1);
        if (layer < 0) continue;
        next.layer_colors = [...(next.layer_colors ?? [])];
        next.layer_colors[layer] = { hue: entry.data[0], sat: entry.data[1], val: 255 };
        next.cosmetic.layer_colors = { ...next.cosmetic.layer_colors, [layer]: file.cosmetic?.layer_colors?.[layer] ?? getClosestPresetColor(entry.data[0], entry.data[1], 255) };
    }
    const labels = new LabelService(usbInstance);
    for (const [field, kind, count] of [['layer','layer',file.layers], ['macros','macro',file.macros?.length], ['tapdances','tapdance',file.tapdances?.length]] as const) {
        if (!file.cosmetic?.[field]) continue;
        if ((current.svil_proto ?? 0) < 2) {
            const named = Object.values(file.cosmetic[field] ?? {}).filter(name => String(name ?? '').trim()).length;
            const what = kind === 'tapdance' ? 'tap dance' : kind;
            if (named) warnings.push(`${named} ${what} name${named === 1 ? '' : 's'} can't be stored on this firmware, so the keyboard keeps its own.`);
            continue;
        }
        const map = { ...current.cosmetic?.[field] };
        for (let i = 0; i < (count ?? 0); i++) {
            const name = file.cosmetic[field]?.[i] ?? '';
            try { labels.validateName(current, kind, name); } catch (error) { errors.push(`${kind} ${i}: ${(error as Error).message}`); }
            map[i] = name;
        }
        next.cosmetic[field] = map;
    }
    // Combo names live in Keybard only, so any firmware takes them. A file with
    // combo names decides the name of every combo it sets. A file without them
    // (a .vil, an older .svil) keeps a name only where the combo is unchanged.
    if (file.combos) {
        const count = Math.min(file.combos.length, current.combo_count ?? 0);
        const fileNames = file.cosmetic?.combos;
        const map: Record<string, string> = { ...current.cosmetic?.combos };
        for (let i = 0; i < count; i++) {
            const name = fileNames ? (fileNames[i] ?? '').trim()
                : sameCombo(file.combos[i], current.combos?.[i]) ? (map[i] ?? '') : '';
            try { validateLabelText(name); } catch (error) { errors.push(`combo ${i}: ${(error as Error).message}`); }
            if (name) map[i] = name;
            else delete map[i];
        }
        if (Object.keys(map).length || current.cosmetic?.combos) next.cosmetic.combos = map;
    }
    summary.push('Entries beyond the file’s layers and tables will be kept from the keyboard.');
    return { keyboard: next, errors, warnings, summary, replaced, unavailable: [...new Set(unavailable)] };
}

/**
 * Hardware positions (thumb clusters and the like). The file records the fragment
 * each position resolved to. A position that matches what the hardware detects is
 * cleared to follow detection; any other is saved as the board's selection.
 */
function restoreFragments(file: KeyboardInfo, current: KeyboardInfo, next: KeyboardInfo, warnings: string[]) {
    const wanted = file.fragmentState?.userSelections;
    const fragments = new FragmentService(null as any);
    if (!wanted || !current.fragmentState || !fragments.hasFragments(current)) return;
    const get = (map: any, key: string | number) => map instanceof Map ? map.get(key) : map?.[key];
    // Files and snapshots may hold these as plain objects rather than Maps.
    const copy = <K, V>(source: any, key: (k: string) => K): Map<K, V> =>
        source instanceof Map ? new Map(source) : new Map(Object.entries(source ?? {}).map(([k, v]) => [key(k), v as V]));
    const was = current.fragmentState;
    const state = next.fragmentState = {
        hwDetection: copy<number, number>(was.hwDetection, Number),
        eepromSelections: copy<number, number>(was.eepromSelections, Number),
        userSelections: copy<string, string>(was.userSelections, String),
        selectionsRead: was.selectionsRead,
    };
    let changed = false;
    for (const { idx, instance } of fragments.getSelectableInstances(current)) {
        const name = get(wanted, instance.id);
        if (!name) continue;
        const options = instance.fragment_options ?? [];
        if (!options.some(option => option.fragment === name)) {
            warnings.push(`Hardware position ${instance.id}: ${name} is not an option on this keyboard and will be kept from the keyboard.`);
            continue;
        }
        const detectedId = get(was.hwDetection, idx);
        const detected = detectedId === undefined ? undefined : fragments.getFragmentNameById(current, detectedId);
        if (detected && instance.allow_override === false) {
            if (detected !== name) warnings.push(`Hardware position ${instance.id} is fixed by the detected hardware and will be kept from the keyboard.`);
            continue;
        }
        const selection = detected === name ? NO_SELECTION : fragments.getOptionIndex(instance, name);
        if (selection === (get(was.eepromSelections, idx) ?? NO_SELECTION)) continue;
        if (selection === NO_SELECTION) state.eepromSelections.delete(idx);
        else state.eepromSelections.set(idx, selection);
        state.userSelections.set(instance.id, name);
        changed = true;
    }
    if (!changed) return;
    const layout = new FragmentComposerService(new KleService(), fragments).composeLayout(next);
    if (Object.keys(layout).length > 0) next.keylayout = layout;
}
