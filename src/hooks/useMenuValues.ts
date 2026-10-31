import { useCallback, useEffect, useState } from "react";

import { useChanges } from "@/contexts/ChangesContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { customValueService } from "@/services/custom-value.service";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { readBackKeys, timingWrites } from "@/utils/scan-timing";

/** The firmware's Pointing Device menu ("Pointing Device" or "Pointing Devices"), or -1. */
export function pointingMenuIndex(menus: CustomUIMenuItem[] | undefined): number {
    return menus?.findIndex((menu) => menu.label?.toLowerCase().includes("pointing")) ?? -1;
}

/**
 * One VIA3 custom menu's values, and the write path every view of them uses:
 * seeded from kbinfo.custom_values (read at connect), written through the
 * changes queue (so Live Updating and Manual Updates both apply), saved, then
 * read back for the values the board may have changed (clamped, rounded, or
 * set together) so every view shows the board's own values.
 */
export function useMenuValues(menu: CustomUIMenuItem | undefined) {
    const { keyboard, setKeyboard, isConnected } = useKeyboard();
    const { queue } = useChanges();
    const [values, setValues] = useState<Map<string, number>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!menu) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            if (keyboard?.custom_values) customValueService.populateCacheFromEntries(keyboard.custom_values);
            setValues(customValueService.getCache());
        } catch (err) {
            console.error("Failed to load custom values:", err);
            setError("Failed to load settings from keyboard");
        } finally {
            setLoading(false);
        }
    }, [menu, isConnected, keyboard?.custom_values]);

    const setValue = useCallback(async (key: string, value: number) => {
        if (!menu || !isConnected || !keyboard) return;
        const refs = customValueService.extractAllItemsWithRefs([menu]);
        const find = (k: string) => refs.find(({ ref }) => ref.key === k);
        const found = find(key);
        if (!found) { setError(`Unknown setting: ${key}`); return; }
        const writes = timingWrites(key, value, customValueService.getCache()).filter(([k]) => find(k));
        const store = (pairs: [string, number][]) => {
            setValues(prev => {
                const next = new Map(prev);
                for (const [k, v] of pairs) next.set(k, v);
                return next;
            });
            setKeyboard(current => {
                if (!current) return current;
                const entries = [...(current.custom_values ?? [])];
                for (const [k, v] of pairs) {
                    const f = find(k);
                    if (!f) continue;
                    const index = entries.findIndex(entry => entry.key === k);
                    const entry = { key: k, channel: f.ref.channel, valueId: f.ref.valueId, data: customValueService.intToBytes(v, customValueService.getByteWidth(f.item)) };
                    if (index >= 0) entries[index] = { ...entries[index], ...entry };
                    else entries.push(entry);
                }
                return { ...current, custom_values: entries };
            });
        };
        store(writes);
        await queue(`Setting ${key}`, async () => {
            for (const [k, v] of writes) await customValueService.setValue(k, v, [menu]);
            await customValueService.save(found.ref.channel);
            const back: [string, number][] = [];
            for (const k of readBackKeys(key)) {
                const f = find(k);
                if (!f) continue;
                const v = await customValueService.get(f.ref.channel, f.ref.valueId, customValueService.getByteWidth(f.item));
                customValueService.setCached(k, v);
                back.push([k, v]);
            }
            if (back.length) store(back);
        }, { type: "custom_ui", writeKey: `custom:${key}` });
    }, [menu, isConnected, queue, keyboard, setKeyboard]);

    return { values, setValue, loading, error };
}
