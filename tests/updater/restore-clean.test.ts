// An update's layout restore leaves no pending edits: the next update's reconnect must not
// raise "discard your edits?" (a native confirm froze the page mid-install on hardware),
// and leaving the page afterwards must not warn.
import { describe, expect, it, vi } from "vitest";

const restored = { name: "restored", keymap: [[4]] };
vi.mock("@/services/file.service", () => ({ fileService: { loadFile: vi.fn(async () => ({ name: "file" })) } }));
vi.mock("@/services/import-preflight", () => ({ prepareImport: vi.fn(() => ({ keyboard: restored, errors: [], warnings: [] })) }));
// Nothing differs from the board: no writes are queued, so the commit acknowledges nothing by itself.
vi.mock("@/services/import.service", () => ({ importService: { syncWithKeyboard: vi.fn(async () => undefined) } }));
vi.mock("@/services/keyboard.service", () => ({ keyboardService: {} }));

import { restoreLayoutToBoard } from "@/features/firmware/restore";
import type { KeyboardInfo } from "@/types/keyboard.types";

describe("the update's layout restore", () => {
    it("marks the restored layout saved, even when nothing needed writing", async () => {
        const markSaved = vi.fn();
        const setKeyboard = vi.fn();
        await restoreLayoutToBoard("{}", { keyboard: { name: "board" } as KeyboardInfo, setKeyboard, queue: vi.fn(), commit: async () => true, markSaved });
        expect(setKeyboard).toHaveBeenCalledWith(restored);
        expect(markSaved).toHaveBeenCalledWith(restored);
    });

    it("leaves it unsaved when the commit fails", async () => {
        const markSaved = vi.fn();
        await expect(restoreLayoutToBoard("{}", { keyboard: { name: "board" } as KeyboardInfo, setKeyboard: vi.fn(), queue: vi.fn(), commit: async () => false, markSaved })).rejects.toThrow(/couldn't be written/);
        expect(markSaved).not.toHaveBeenCalled();
    });
});
