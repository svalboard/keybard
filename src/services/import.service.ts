import { KeyboardInfo } from "../types/keyboard.types";
import { PendingChange } from "./changes.service";
import { customValueService } from "./custom-value.service";
import { boardStoresComboNames } from "@/utils/combo-name-storage";
import { LabelService } from "./label.service";
import { usbInstance } from "./usb.service";
import { keyService } from "./key.service";
import { NO_SELECTION } from "./fragment.service";
import { NOT_LAYOUT_VALUES } from "../utils/touchpad-tuning";

/** A keycode as the firmware stores it: entries read from a file hold names, the board's hold names or numbers. */
const kc = (value: unknown): number => typeof value === "string" ? keyService.parse(value) : Number(value ?? 0);

/**
 * Each table entry reduced to what its write sends, so an entry read from a file
 * and the same entry read from the board compare equal: field order, index
 * fields, keycode spelling and `enabled` on tables that keep it in `options`
 * don't matter.
 */
const canonical: Record<string, (entry: any) => unknown> = {
    combos: c => [[0, 1, 2, 3].map(i => kc(c.keys?.[i] ?? 0)), kc(c.output), (c.options ?? 0) >>> 0],
    // Every tap dance write turns it on, so `enabled` isn't compared.
    tapdances: t => [kc(t.tap), kc(t.hold), kc(t.doubletap), kc(t.taphold), t.tapping_term ?? 200],
    key_overrides: o => [kc(o.trigger), kc(o.replacement), (o.layers ?? 0xFFFF) >>> 0, o.trigger_mods || 0, o.negative_mod_mask || 0, o.suppressed_mods || 0, o.options || 0],
    alt_repeat_keys: a => [kc(a.keycode), kc(a.alt_keycode), a.allowed_mods || 0, a.options || 0],
    // The board's reader drops empty sequence slots, so compare without them.
    leaders: l => [(l.sequence ?? []).map(kc).filter((k: number) => k !== 0), kc(l.output), l.options || 0],
};

/** Whether a table entry from the file would change the board's entry. */
export function entryChanged(table: keyof typeof canonical, next: unknown, current: unknown): boolean {
    if (next === undefined || current === undefined) return next !== current;
    return JSON.stringify(canonical[table](next)) !== JSON.stringify(canonical[table](current));
}

export class ImportService {
    async syncWithKeyboard(
        newKb: KeyboardInfo,
        currentKb: KeyboardInfo,
        enqueue: (desc: string, cb: () => Promise<void>, metadata?: Partial<PendingChange>) => Promise<void>,
        services: any
    ): Promise<void> {
        if (!currentKb) return;

        // Build the complete write set before executing anything. Live mode then sees
        // one batch, so a partial import cannot be acknowledged as fully saved.
        const writes: Array<{ desc: string; cb: () => Promise<void>; metadata?: Partial<PendingChange> }> = [];
        const queue = async (desc: string, cb: () => Promise<void>, metadata?: Partial<PendingChange>) => { writes.push({ desc, cb, metadata }); };

        // Copy hardware properties from connected keyboard (these are not in save files)
        // macros_size is required for the macro buffer allocation
        newKb.macros_size = currentKb.macros_size;

        // 1. Sync Keymap
        // Use hardware dimensions from currentKb for iteration
        if (newKb.keymap && currentKb.keymap) {
            const layers = Math.min(newKb.layers || 0, currentKb.layers || 0);
            const rows = currentKb.rows;
            const cols = currentKb.cols;

            for (let l = 0; l < layers; l++) {
                if (!newKb.keymap[l]) continue;
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        // Map using file's cols for reading, hardware cols for writing
                        const newCols = newKb.cols || cols;
                        const keyIndex = (r * newCols) + c;
                        const newVal = newKb.keymap[l][keyIndex];
                        const oldVal = currentKb.keymap?.[l]?.[keyIndex];

                        if (newVal !== undefined && newVal !== oldVal) {
                            const keyLabel = keyService.stringify(newVal);
                            await queue(
                                `Update key L${l} R${r} C${c} to ${keyLabel}`,
                                async () => {
                                    await services.keyboardService.updateKey(l, r, c, newVal);
                                },
                                {
                                    writeKey: `key:${l}:${r}:${c}`,
                                    type: "key",
                                    layer: l,
                                    row: r,
                                    col: c,
                                    keycode: newVal,
                                    previousValue: oldVal
                                }
                            );
                        }
                    }
                }
            }
        }

        // 2. Sync Macros
        // Compare actions only: macros read from a file and from the board order their fields differently.
        const macroActions = (kb: KeyboardInfo) => JSON.stringify((kb.macros ?? []).map(macro => macro.actions));
        if (macroActions(newKb) !== macroActions(currentKb)) {
            await queue(
                "Update All Macros",
                async () => {
                    await services.keyboardService.updateMacros(newKb);
                },
                { type: "macro", writeKey: "macros" }
            );
        }

        // 3. Sync Combos
        const newCombos = newKb.combos;
        const currentCombos = currentKb.combos;

        if (newCombos && currentCombos) {
            for (let idx = 0; idx < newCombos.length; idx++) {
                const combo = newCombos[idx];
                const oldCombo = currentCombos[idx];
                if (entryChanged("combos", combo, oldCombo)) {
                    await queue(
                        `Update Combo ${idx}`,
                        async () => {
                            await services.keyboardService.updateCombo(newKb, idx);
                        },
                        { type: "combo", comboId: idx, writeKey: `combo:${idx}` }
                    );
                }
            }
        }

        // 4. Sync Tapdances
        const newTds = newKb.tapdances;
        const oldTds = currentKb.tapdances;

        if (newTds && oldTds) {
            for (let idx = 0; idx < newTds.length; idx++) {
                const td = newTds[idx];
                const oldTd = oldTds[idx];
                if (entryChanged("tapdances", td, oldTd)) {
                    await queue(
                        `Update Tapdance ${idx}`,
                        async () => {
                            await services.keyboardService.updateTapdance(newKb, idx);
                        },
                        { type: "tapdance", tapdanceId: idx, writeKey: `tapdance:${idx}` }
                    );
                }
            }
        }

        // 4b. Sync Alt Repeat Keys and Leader sequences
        for (const [field, kind, label, update] of [
            ["alt_repeat_keys", "altrepeat", "Alt Repeat Key", "updateAltRepeatKey"],
            ["leaders", "leader", "Leader", "updateLeader"],
        ] as const) {
            const entries = newKb[field];
            const oldEntries = currentKb[field];
            if (!entries || !oldEntries) continue;
            for (let idx = 0; idx < entries.length; idx++) {
                if (!entryChanged(field, entries[idx], oldEntries[idx])) continue;
                await queue(
                    `Update ${label} ${idx}`,
                    async () => {
                        await services.keyboardService[update](newKb, idx);
                    },
                    { type: "key", writeKey: `${kind}:${idx}` }
                );
            }
        }

        // 5. Sync Key Overrides
        const newOverrides = newKb.key_overrides;
        const currentOverrides = currentKb.key_overrides;

        if (newOverrides && currentOverrides) {
            for (let idx = 0; idx < newOverrides.length; idx++) {
                const ko = newOverrides[idx];
                const oldKo = currentOverrides[idx];
                if (entryChanged("key_overrides", ko, oldKo)) {
                    await queue(
                        `Update Key Override ${idx}`,
                        async () => {
                            await services.keyboardService.updateKeyoverride(newKb, idx);
                        },
                        { type: "override", writeKey: `override:${idx}` }
                    );
                }
            }
        }

        // Board labels. Combo names (cosmetic.combos) are written only to firmware
        // that stores them; elsewhere they stay in Keybard (the preflight already
        // put them in newKb, and nothing is written for them).
        const labels = services.labelService ?? new LabelService(usbInstance);
        if ((currentKb.svil_proto ?? 0) >= 2) {
            const fields = [["layer", "layer", currentKb.layers], ["macros", "macro", currentKb.macro_count], ["tapdances", "tapdance", currentKb.tapdance_count]] as const;
            const combos = [["combos", "combo", currentKb.combo_count ?? currentKb.combos?.length]] as const;
            for (const [field, kind, count] of [...fields, ...(boardStoresComboNames(currentKb) ? combos : [])]) {
                if (!newKb.cosmetic?.[field]) continue;
                for (let index = 0; index < (count ?? 0); index++) {
                    const name = newKb.cosmetic[field]?.[index] ?? "";
                    if (name === (currentKb.cosmetic?.[field]?.[index] ?? "")) continue;
                    await queue(`Rename ${kind} ${index}`, () => labels.saveName(currentKb, kind, index, name), { type: "key", writeKey: `label:${kind}:${index}` });
                }
            }
        }

        // Hardware positions: the preflight already set the selections the board should hold.
        const wantedSelections = newKb.fragmentState?.eepromSelections;
        if (wantedSelections instanceof Map && currentKb.fragmentState) {
            for (const [idx] of (newKb.composition?.instances ?? []).entries()) {
                const wanted = wantedSelections.get(idx) ?? NO_SELECTION;
                const was = currentKb.fragmentState.eepromSelections instanceof Map ? currentKb.fragmentState.eepromSelections.get(idx) : (currentKb.fragmentState.eepromSelections as any)?.[idx];
                if (wanted === (was ?? NO_SELECTION)) continue;
                await queue(`Hardware position ${newKb.composition!.instances[idx].id}`, async () => {
                    if (!await services.keyboardService.updateFragmentSelection(newKb, idx, wanted)) throw new Error(`Keyboard rejected the selection for ${newKb.composition!.instances[idx].id}`);
                }, { writeKey: `fragment:${idx}` });
            }
        }

        // 6. Sync QMK Settings
        if (newKb.settings && currentKb.settings) {
            for (const key of Object.keys(newKb.settings)) {
                const qsid = parseInt(key);
                const newVal = newKb.settings![qsid];
                const oldVal = currentKb.settings![qsid];

                if (newVal !== oldVal) {
                    await queue(
                        `Update QMK Setting ${qsid}`,
                        async () => {
                            await services.keyboardService.updateQMKSetting(newKb, qsid);
                        },
                        { type: "key", writeKey: `setting:${qsid}` }
                    );
                }
            }
        }

        // 7. Sync VIA3 Custom Values (DPI, scroll mode, automouse, bump filter, etc.)
        if (newKb.custom_values && newKb.custom_values.length > 0 && currentKb.menus) {
            // Walk connected keyboard's menu tree to get channel/valueId/width for each key
            const menuItemsWithRefs = customValueService.extractAllItemsWithRefs(currentKb.menus);
            const menuRefMap = new Map(menuItemsWithRefs.map(({ item, ref }) => [ref.key, { item, ref }]));

            const channelsToSave = new Set<number>();

            for (const entry of newKb.custom_values) {
                // Per-board settings that aren't layout (the touchpad mode) are never imported.
                if (NOT_LAYOUT_VALUES.includes(entry.key)) continue;
                const menuEntry = menuRefMap.get(entry.key);
                if (!menuEntry) {
                    console.warn(`[Import] Custom value key "${entry.key}" not found in connected keyboard menus, skipping`);
                    continue;
                }

                const { item, ref } = menuEntry;
                const width = customValueService.getByteWidth(item);

                // Prepare data bytes - handle backward compat:
                // Old format: data: [integer] where the single number is the full value
                // New format: data: [byte0, byte1, ...] raw little-endian bytes
                let dataBytes: number[];
                if (entry.data.length === 1 && width > 1) {
                    // Old format: single integer, expand to bytes
                    dataBytes = customValueService.intToBytes(entry.data[0], width);
                } else {
                    dataBytes = entry.data.slice(0, width);
                    // Pad if needed
                    while (dataBytes.length < width) {
                        dataBytes.push(0);
                    }
                }

                // Unchanged values need no write.
                const was = currentKb.custom_values?.find(value => value.key === entry.key)?.data;
                if (was && was.length === dataBytes.length && was.every((byte, index) => byte === dataBytes[index])) continue;

                await queue(
                    `Update custom value ${entry.key}`,
                    async () => {
                        await customValueService.setRaw(ref.channel, ref.valueId, dataBytes);
                    },
                    { type: "custom_ui" as any, writeKey: `custom:${entry.key}` }
                );

                channelsToSave.add(ref.channel);
            }

            // Save each affected channel
            for (const channel of channelsToSave) {
                await queue(
                    `Save custom values channel ${channel}`,
                    async () => {
                        await customValueService.save(channel);
                    },
                    { type: "custom_ui" as any, writeKey: `custom-save:${channel}` }
                );
            }
        }
        if (writes.length) {
            await queue("Save imported configuration", () => services.keyboardService.saveSvil(), { type: "key", writeKey: "save-svil" });
        }
        await Promise.all(writes.map(write => enqueue(write.desc, write.cb, write.metadata)));
    }
}

export const importService = new ImportService();
