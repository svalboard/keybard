// Board settings that aren't layout but come back after an update: the touchpad mode.
// One owner: the pre-update backup records them (withBoardState) and only the update's
// restore puts them back (restoreBoardState), written at once and read back, never a
// pending change. Export, import and shared layouts never carry or change them; the
// import path ignores the field.

import { customValueService } from "@/services/custom-value.service";
import type { KeyboardInfo } from "@/types/keyboard.types";
import { PAD_MODE_KEY } from "@/utils/touchpad-tuning";

/** The .svil field the pre-update backup adds. */
export const BOARD_STATE_FIELD = "board_state";

export interface BoardState {
    touchpad_mode?: number;
}

const valueOf = (data: number[]): number => customValueService.bytesToInt(data, data.length);

/** The board's touchpad mode as loaded (board state), or undefined on a board without one. */
export function touchpadModeOf(keyboard: KeyboardInfo): number | undefined {
    const entry = keyboard.custom_values?.find((e) => e.key === PAD_MODE_KEY);
    return entry ? valueOf(entry.data) : undefined;
}

/** The pre-update backup: the layout's .svil plus the board's own settings. */
export function withBoardState(svil: string, keyboard: KeyboardInfo): string {
    const mode = touchpadModeOf(keyboard);
    if (mode === undefined) return svil;
    const state: BoardState = { touchpad_mode: mode };
    const end = svil.lastIndexOf("}");
    if (end < 0) return svil;
    // Text, not JSON.parse and stringify: that would round the board's UID.
    return `${svil.slice(0, end).replace(/\s*$/, "")},\n  "${BOARD_STATE_FIELD}": ${JSON.stringify(state)}\n}${svil.slice(end + 1)}`;
}

/** What a backup recorded, or null (any other .svil). */
export function boardStateFromSvil(svil: string): BoardState | null {
    try {
        const state = JSON.parse(svil)?.[BOARD_STATE_FIELD];
        if (!state || typeof state !== "object") return null;
        const mode = state.touchpad_mode;
        return Number.isInteger(mode) && mode >= 0 && mode <= 255 ? { touchpad_mode: mode } : null;
    } catch {
        return null;
    }
}

export interface BoardStateTarget {
    keyboard: KeyboardInfo;
    /** Board state into the draft and the loaded copy alike (KeyboardContext.applyBoardState). */
    applyBoardState: (patch: (kb: KeyboardInfo) => KeyboardInfo) => void;
    /** POINTING_HARDWARE read again: its touchpad-mode bit follows the switch. */
    readPointing?: (probe: KeyboardInfo) => Promise<void>;
}

/**
 * Put the recorded touchpad mode back: written at once, saved, read back, and the
 * read-back stored as board state. No confirmation: it is the person's own earlier
 * choice. Nothing to do on a board without the setting, or when it already matches.
 */
export async function restoreBoardState(state: BoardState | null, t: BoardStateTarget): Promise<void> {
    const mode = state?.touchpad_mode;
    if (mode === undefined) return;
    const entry = t.keyboard.custom_values?.find((e) => e.key === PAD_MODE_KEY);
    if (!entry || valueOf(entry.data) === mode) return;
    const width = entry.data.length || 1;
    try {
        await customValueService.set(entry.channel, entry.valueId, mode, width);
        await customValueService.save(entry.channel);
        const back = await customValueService.get(entry.channel, entry.valueId, width);
        customValueService.setCached(PAD_MODE_KEY, back);
        const data = customValueService.intToBytes(back, width);
        t.applyBoardState((kb) => ({
            ...kb,
            custom_values: (kb.custom_values ?? []).map((e) => (e.key === PAD_MODE_KEY ? { ...e, data } : e)),
        }));
        if (back !== mode) throw new Error(`the board reads ${back}`);
    } catch (error) {
        throw new Error(`The layout is back, but Touchpad mode couldn't be put back: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (t.readPointing) {
        const probe: KeyboardInfo = { ...t.keyboard };
        try {
            await t.readPointing(probe);
            const hw = probe.pointing_hardware;
            if (hw) t.applyBoardState((kb) => ({ ...kb, pointing_hardware: hw }));
        } catch {
            // Keeps the report from before; the next read brings it up to date.
        }
    }
}
