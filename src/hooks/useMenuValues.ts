import { useCallback, useEffect, useState } from "react";

import { useChanges } from "@/contexts/ChangesContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { customValueService } from "@/services/custom-value.service";
import type { CustomUIMenuItem, KeyboardInfo } from "@/types/keyboard.types";
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
 *
 * setValue(key, value, { now: true }) writes to the board at once, outside
 * the pending changes, and reads the value back: board state, not an edit, so
 * it goes into the draft and the loaded copy alike (Discard never reverts it,
 * no unsaved-changes prompt). It resolves true once the board has it; on a
 * failed write it shows the board's value again and sets `error`. For the
 * touchpad tuning dialog, which tunes against the live pads.
 */
export function useMenuValues(menu: CustomUIMenuItem | undefined) {
    const { keyboard, setKeyboard, applyBoardState, isConnected } = useKeyboard();
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

    const setValue = useCallback(async (key: string, value: number, opts?: { now?: boolean }): Promise<boolean> => {
        if (!menu || !isConnected || !keyboard) return false;
        const refs = customValueService.extractAllItemsWithRefs([menu]);
        const find = (k: string) => refs.find(({ ref }) => ref.key === k);
        const found = find(key);
        if (!found) { setError(`Unknown setting: ${key}`); return false; }
        const writes = timingWrites(key, value, customValueService.getCache()).filter(([k]) => find(k));
        const store = (pairs: [string, number][]) => {
            setValues(prev => {
                const next = new Map(prev);
                for (const [k, v] of pairs) next.set(k, v);
                return next;
            });
            const patch = (current: KeyboardInfo): KeyboardInfo => {
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
            };
            if (opts?.now) applyBoardState(patch);
            else setKeyboard(current => current ? patch(current) : current);
        };
        store(writes);
        const write = async () => {
            for (const [k, v] of writes) await customValueService.setValue(k, v, [menu]);
            await customValueService.save(found.ref.channel);
            const back: [string, number][] = [];
            for (const k of opts?.now ? [...new Set([key, ...readBackKeys(key)])] : readBackKeys(key)) {
                const f = find(k);
                if (!f) continue;
                const v = await customValueService.get(f.ref.channel, f.ref.valueId, customValueService.getByteWidth(f.item));
                customValueService.setCached(k, v);
                back.push([k, v]);
            }
            if (back.length) store(back);
        };
        if (!opts?.now) {
            await queue(`Setting ${key}`, write, { type: "custom_ui", writeKey: `custom:${key}` });
            return true;
        }
        try {
            setError(null);
            await write();
            return true;
        } catch (err) {
            // Show what the board has, not the value that didn't land.
            const f = found;
            try {
                const v = await customValueService.get(f.ref.channel, f.ref.valueId, customValueService.getByteWidth(f.item));
                customValueService.setCached(key, v);
                store([[key, v]]);
            } catch { /* the board isn't answering: keep the shown value */ }
            setError(`The board didn't take ${f.item.label ?? key}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }, [menu, isConnected, queue, keyboard, setKeyboard, applyBoardState]);

    return { values, setValue, loading, error };
}
