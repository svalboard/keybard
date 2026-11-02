// Put a .svil back on the connected board through the import path: the preflight, then
// syncWithKeyboard, with no review dialog. Returns what the preflight trimmed. A backup taken
// before an update also puts the board's touchpad mode back (board-state.ts), written at once.

import { fileService } from "@/services/file.service";
import { prepareImport } from "@/services/import-preflight";
import type { KeyboardInfo } from "@/types/keyboard.types";
import type { PendingChange } from "@/services/changes.service";
import type { RestoreReport } from "@/services/updater/flow";
import { boardStateFromSvil, restoreBoardState, TouchpadModeNotRestored, type BoardStateTarget } from "./board-state";

export interface RestoreTarget {
    keyboard: KeyboardInfo;
    setKeyboard: (kb: KeyboardInfo) => void;
    queue: (desc: string, cb: () => Promise<void>, metadata?: Partial<PendingChange>) => Promise<void>;
    commit: () => Promise<boolean>;
    /**
     * The board now holds this layout: no pending edits are left, so a later reconnect
     * asks nothing and leaving the page doesn't warn. (A commit with nothing to write,
     * or with differences only Keybard keeps, would otherwise leave the editor dirty.)
     */
    markSaved?: (kb: KeyboardInfo) => void;
    /** Board state into the draft and the loaded copy: the touchpad mode the backup recorded. */
    applyBoardState?: BoardStateTarget["applyBoardState"];
    readPointing?: BoardStateTarget["readPointing"];
}

export async function restoreLayoutToBoard(svil: string, t: RestoreTarget): Promise<RestoreReport> {
    const imported = await fileService.loadFile(new File([svil], "backup.svil", { type: "application/json" }));
    const plan = prepareImport(imported, t.keyboard);
    if (plan.errors.length) throw new Error(plan.errors.join(" "));
    t.setKeyboard(plan.keyboard);
    const { importService } = await import("@/services/import.service");
    const { keyboardService } = await import("@/services/keyboard.service");
    await importService.syncWithKeyboard(plan.keyboard, t.keyboard, (desc, cb, metadata) => t.queue(desc, cb, { ...metadata, deferCommit: true }), { keyboardService });
    if (!(await t.commit())) throw new Error("Some of the layout couldn't be written.");
    t.markSaved?.(plan.keyboard);
    const report: RestoreReport = { trimmed: plan.warnings, replaced: plan.replaced, unavailable: plan.unavailable };
    // The layout is back either way: a mode that didn't go back carries the layout's notes.
    if (t.applyBoardState) {
        try {
            await restoreBoardState(boardStateFromSvil(svil), { keyboard: t.keyboard, applyBoardState: t.applyBoardState, readPointing: t.readPointing ?? ((probe) => keyboardService.getPointingHardware(probe)) });
        } catch (error) {
            if (error instanceof TouchpadModeNotRestored) error.report = report;
            throw error;
        }
    }
    return report;
}
