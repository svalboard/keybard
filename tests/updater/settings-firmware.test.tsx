// M3: Settings > Firmware is the entry to the update flow; the chord legends come from the board.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardSummary } from "@/features/firmware/board-summary";
import type { FirmwareUpdates } from "@/features/firmware/FirmwareUpdateProvider";
import { chordLegendsFor } from "@/features/firmware/useAppFirmwareHost";
import { KEYMAP } from "@/constants/keygen";
import type { KeyboardInfo } from "@/types/keyboard.types";

const ctx = vi.hoisted(() => ({ updates: null as FirmwareUpdates | null, connected: true }));
vi.mock("@/features/firmware/FirmwareUpdateProvider", () => ({ useFirmwareUpdates: () => ctx.updates }));
vi.mock("@/contexts/KeyboardContext", () => ({ useKeyboard: () => ({ keyboard: null, isConnected: ctx.connected }) }));

import FirmwareRow from "@/layout/SecondarySidebar/Panels/settings/FirmwareRow";

const board: BoardSummary = {
    updater: true, legacyLabel: null, usbHand: 1, differ: false, noChord: false, fwVersion: 3000, tag: "v3",
    halves: [
        { hand: 0, usb: false, tag: "v3", fwVersion: 3000, answered: true },
        { hand: 1, usb: true, tag: "v3", fwVersion: 3000, answered: true },
    ],
};

function updates(o: Partial<FirmwareUpdates> = {}): FirmwareUpdates {
    return {
        board, reading: false, recheck: vi.fn(), checking: false, releases: [], install: vi.fn(), openManual: vi.fn(), connect: vi.fn(),
        status: { newest: null, updateAvailable: false, dot: false, markSeen: vi.fn() },
        ...o,
    };
}

beforeEach(() => { ctx.updates = updates(); ctx.connected = true; });

describe("Settings > Firmware", () => {
    it("shows the board's halves under the section's own title, the rest under Other versions and files", () => {
        render(<FirmwareRow />);
        expect(screen.getByTestId("firmware-section")).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "Firmware" })).toBeNull(); // Settings titles the section
        expect(screen.getByTestId("firmware-halves").textContent).toBe("Left halfv3Right halfv3 · plugged in");
        expect(screen.getByRole("button", { name: "Other versions and files" })).toBeTruthy();
    });

    it("shows each half's firmware, not its pointing module (that's detected at run time)", () => {
        render(<FirmwareRow />);
        for (const row of document.querySelectorAll("[data-half]")) {
            expect(row.textContent).not.toMatch(/Any module|pointing|Trackball|Touchpad|Trackpoint/i);
        }
        expect(document.querySelectorAll("[data-half]").length).toBe(2);
    });

    it("says it's reading while the board's firmware is read", () => {
        ctx.updates = updates({ board: null, reading: true });
        render(<FirmwareRow />);
        expect(screen.getByText("Reading the keyboard's firmware…")).toBeTruthy();
    });

    it("opening it clears the update dot for this release", () => {
        const markSeen = vi.fn();
        ctx.updates = updates({ status: { newest: null, updateAvailable: true, dot: true, markSeen } });
        render(<FirmwareRow />);
        expect(markSeen).toHaveBeenCalledTimes(1);
    });
});

describe("chord legends", () => {
    const kb = (layer0: number[]) => ({ rows: 10, cols: 6, keymap: [layer0] }) as unknown as KeyboardInfo;
    const at = (row: number, col: number) => row * 6 + col;

    it("come from the board's layer 0 at Index South and Middle South", () => {
        const layer0 = new Array(60).fill(KEYMAP.KC_A.code);
        layer0[at(6, 0)] = KEYMAP.KC_J.code;
        layer0[at(7, 0)] = KEYMAP.KC_K.code;
        layer0[at(1, 0)] = KEYMAP.KC_F.code;
        layer0[at(2, 0)] = KEYMAP.KC_D.code;
        expect(chordLegendsFor(kb(layer0), 1)).toEqual(["J", "K"]);
        expect(chordLegendsFor(kb(layer0), 0)).toEqual(["F", "D"]);
    });

    it("name the place on a blank board, and fall back to the default letters with no keymap", () => {
        expect(chordLegendsFor(kb(new Array(60).fill(0)), 1)).toEqual(["Index South", "Middle South"]);
        expect(chordLegendsFor(null, 1)).toEqual(["M", ","]);
        expect(chordLegendsFor(null, 0)).toEqual(["V", "C"]);
    });
});

describe("Settings > Firmware: Check again", () => {
    it("opening the card reads the board again, once", () => {
        const recheck = vi.fn();
        ctx.updates = updates({ recheck });
        const { rerender } = render(<FirmwareRow />);
        rerender(<FirmwareRow />);
        expect(recheck).toHaveBeenCalledTimes(1);
    });

    it("a first read still running needs no second one", () => {
        const recheck = vi.fn();
        ctx.updates = updates({ board: null, reading: true, recheck });
        render(<FirmwareRow />);
        expect(recheck).not.toHaveBeenCalled();
    });

    it("Check again sits beside the halves and reads the board; busy while it runs", () => {
        const recheck = vi.fn();
        ctx.updates = updates({ recheck });
        const { rerender } = render(<FirmwareRow />);
        recheck.mockClear();
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        expect(recheck).toHaveBeenCalledTimes(1);
        ctx.updates = updates({ recheck, checking: true });
        rerender(<FirmwareRow />);
        const busy = screen.getByTestId("firmware-recheck");
        expect(busy.textContent).toBe("Checking…");
        expect((busy as HTMLButtonElement).disabled).toBe(true);
    });

    it("a board Keybard couldn't read: says so, with Check again, never Install by hand", () => {
        const recheck = vi.fn();
        ctx.updates = updates({ recheck, board: { updater: false, unread: true, legacyLabel: null, usbHand: 1, halves: [], differ: false, noChord: false, fwVersion: 0, tag: "" } });
        render(<FirmwareRow />);
        expect(screen.getByText("Keybard couldn't read the firmware.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Install by hand" })).toBeNull();
        expect(screen.queryByTestId("firmware-halves")).toBeNull();
        recheck.mockClear();
        fireEvent.click(screen.getByTestId("firmware-unread-recheck"));
        expect(recheck).toHaveBeenCalledTimes(1);
    });

    it("a board on firmware without the updater still gets Install by hand", () => {
        ctx.updates = updates({ board: { updater: false, legacyLabel: "x3.1.3", usbHand: 1, halves: [], differ: false, noChord: false, fwVersion: 2301, tag: "x3.1.3" } });
        render(<FirmwareRow />);
        expect(screen.getByRole("button", { name: "Install by hand" })).toBeTruthy();
    });
});
