// Settings > About > Debug console: shown only when the firmware has the
// command; reads the board when it appears; every change goes to the board at
// once and the row shows what the board reads back.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DebugConsoleRow, { DEBUG_CONSOLE_DESCRIPTION } from "../../src/layout/SecondarySidebar/Panels/settings/DebugConsoleRow";

const mocks = vi.hoisted(() => ({
    keyboard: { feature_flags4: 0x04 } as { feature_flags4: number },
    connected: true,
    board: false,
    ignoreWrites: false,
    calls: [] as number[],
}));

vi.mock("@/contexts/KeyboardContext", () => ({ useKeyboard: () => ({ keyboard: mocks.keyboard, isConnected: mocks.connected }) }));
vi.mock("@/services/keyboard.service", () => ({
    keyboardService: {
        hasDebugConsole: (kb: { feature_flags4?: number } | null) => ((kb?.feature_flags4 ?? 0) & 0x04) !== 0,
        debugConsole: async (op: number) => {
            mocks.calls.push(op);
            if ((op === 0 || op === 1) && !mocks.ignoreWrites) mocks.board = op === 1;
            return { ok: true, on: mocks.board };
        },
    },
}));

const state = () => document.querySelector("[data-debug-console-state]")?.getAttribute("data-debug-console-state");

beforeEach(() => {
    mocks.keyboard = { feature_flags4: 0x04 };
    mocks.connected = true;
    mocks.board = false;
    mocks.ignoreWrites = false;
    mocks.calls = [];
});

describe("DebugConsoleRow", () => {
    it("is not shown on firmware without the command, or with no board", () => {
        mocks.keyboard = { feature_flags4: 0x03 };
        const { container, rerender } = render(<DebugConsoleRow />);
        expect(container.innerHTML).toBe("");
        mocks.keyboard = { feature_flags4: 0x04 };
        mocks.connected = false;
        rerender(<DebugConsoleRow />);
        expect(container.innerHTML).toBe("");
        expect(mocks.calls).toEqual([]);
    });

    it("reads the board, then writes each change at once and reads it back", async () => {
        mocks.board = true; // on since an earlier change
        render(<DebugConsoleRow />);
        expect(screen.getByText("Debug console")).toBeTruthy();
        expect(screen.getByText(DEBUG_CONSOLE_DESCRIPTION)).toBeTruthy();
        await waitFor(() => expect(state()).toBe("on"));
        expect(mocks.calls).toEqual([2]);

        fireEvent.click(screen.getByRole("button", { name: "OFF" }));
        await waitFor(() => expect(state()).toBe("off"));
        expect(mocks.calls).toEqual([2, 0, 2]);

        fireEvent.click(screen.getByRole("button", { name: "ON" }));
        await waitFor(() => expect(state()).toBe("on"));
        expect(mocks.calls).toEqual([2, 0, 2, 1, 2]);
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows what the board read back when the board kept its old state", async () => {
        mocks.ignoreWrites = true;
        render(<DebugConsoleRow />);
        await waitFor(() => expect(state()).toBe("off"));
        fireEvent.click(screen.getByRole("button", { name: "ON" }));
        await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
        expect(state()).toBe("off");
    });
});
