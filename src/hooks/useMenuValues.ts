import { useCallback, useEffect, useRef, useState } from "react";

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
 * failed write it shows the board's value again and sets `writeError`. For the
 * touchpad tuning dialog, which tunes against the live pads.
 */
export function useMenuValues(menu: CustomUIMenuItem | undefined) {
    const { keyboard, setKeyboard, applyBoardState, isConnected } = useKeyboard();
    const { queue, clear } = useChanges();
    const [values, setValues] = useState<Map<string, number>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Values written at once and not yet read back: shown over the board state, which takes them
    // only from the read-back, so a refresh in between (another write's read-back) can't flick them back.
    const inflight = useRef(new Map<string, number>());

    useEffect(() => {
        if (!menu) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            if (keyboard?.custom_values) customValueService.populateCacheFromEntries(keyboard.custom_values);
            const shown = customValueService.getCache();
            for (const [k, v] of inflight.current) shown.set(k, v);
            setValues(shown);
        } catch (err) {
            console.error("Failed to load custom values:", err);
            setError("Failed to load settings from keyboard");
        } finally {
            setLoading(false);
        }
    }, [menu, isConnected, keyboard?.custom_values]);
    // A write made at once that the board didn't take: kept until the next one, or another
    // menu or connection, not through the values it refreshed (the board's value shown again).
    const [writeError, setWriteError] = useState<string | null>(null);
    useEffect(() => { setWriteError(null); }, [menu, isConnected]);

    const setValue = useCallback(async (key: string, value: number, opts?: { now?: boolean }): Promise<boolean> => {
        if (!menu || !isConnected || !keyboard) {
            // A write meant for the board now (the confirmation outlived the connection): say it didn't happen.
            if (opts?.now && menu) setWriteError("The board isn't connected, so nothing changed.");
            return false;
        }
        const refs = customValueService.extractAllItemsWithRefs([menu]);
        const find = (k: string) => refs.find(({ ref }) => ref.key === k);
        const found = find(key);
        if (!found) { setError(`Unknown setting: ${key}`); return false; }
        const writes = timingWrites(key, value, customValueService.getCache()).filter(([k]) => find(k));
        const show = (pairs: [string, number][]) => setValues(prev => {
            const next = new Map(prev);
            for (const [k, v] of pairs) next.set(k, v);
            return next;
        });
        const patchFor = (pairs: [string, number][]) => (current: KeyboardInfo): KeyboardInfo => {
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
        // An edit: the draft, written by the change queue (Live Updating or Apply).
        const storeDraft = (pairs: [string, number][]) => { show(pairs); setKeyboard(current => current ? patchFor(pairs)(current) : current); };
        // Board state: only what the board said it has (a read-back), in the draft and the loaded copy alike.
        const storeBoard = (pairs: [string, number][]) => { show(pairs); applyBoardState(patchFor(pairs)); };
        const readBack = async (keys: string[]) => {
            const back: [string, number][] = [];
            for (const k of keys) {
                const f = find(k);
                if (!f) continue;
                const v = await customValueService.get(f.ref.channel, f.ref.valueId, customValueService.getByteWidth(f.item));
                customValueService.setCached(k, v);
                back.push([k, v]);
            }
            return back;
        };
        const send = async () => {
            for (const [k, v] of writes) await customValueService.setValue(k, v, [menu]);
            await customValueService.save(found.ref.channel);
        };
        if (!opts?.now) {
            storeDraft(writes);
            await queue(`Setting ${key}`, async () => {
                await send();
                const back = await readBack(readBackKeys(key));
                if (back.length) storeDraft(back);
            }, { type: "custom_ui", writeKey: `custom:${key}` });
            return true;
        }
        // At once. A change for the same setting still waiting in the queue (Manual Updates) would
        // overwrite this one at Apply: it goes, so the board keeps the value chosen last.
        for (const [k] of writes) clear(`custom:${k}`);
        const keys = [...new Set([...writes.map(([k]) => k), ...readBackKeys(key)])];
        const before: [string, number][] = keys.map(k => [k, customValueService.getCache().get(k) ?? 0]);
        setWriteError(null);
        for (const [k, v] of writes) inflight.current.set(k, v);
        show(writes); // shown at once; board state only from the read-back below
        const done = () => { for (const [k, v] of writes) if (inflight.current.get(k) === v) inflight.current.delete(k); };
        try {
            await send();
            const back = await readBack(keys);
            done();
            storeBoard(back);
            return true;
        } catch (err) {
            done();
            // Show what the board has, not the value that didn't land; if the board doesn't
            // answer either, what was shown before (board state never took the new value).
            try {
                storeBoard(await readBack(keys));
            } catch {
                for (const [k, v] of before) customValueService.setCached(k, v);
                show(before);
            }
            setWriteError(`The board didn't take ${found.item.label ?? key}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }, [menu, isConnected, queue, clear, keyboard, setKeyboard, applyBoardState]);

    return { values, setValue, loading, error, writeError };
}
