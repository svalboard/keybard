// The Firmware card's board summary is re-read on each reconnect and on Check again, and
// the summary from before stays on screen while a re-read runs.
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BoardSummary } from "@/features/firmware/board-summary";

vi.mock("@/lib/paranoid", () => ({ PARANOID: false, userIsLooking: () => true }));
vi.mock("@/contexts/KeyboardContext", () => ({ useKeyboard: () => ({ keyboard: null, isConnected: false, connectionSessionId: 0, connect: vi.fn() }), listPermittedDevices: async () => [] }));
vi.mock("@/contexts/ChangesContext", () => ({ useChanges: () => ({ queue: vi.fn(), commit: vi.fn() }) }));
vi.mock("@/contexts/BackupContext", () => ({ useBackups: () => ({ board: null, snapshots: [] }), serializeForBackup: () => "{}" }));
vi.mock("@/contexts/PanelsContext", () => ({ usePanels: () => ({ setActivePanel: vi.fn(), openDetails: vi.fn(), setPanelToGoBack: vi.fn(), setItemToEdit: vi.fn() }) }));

import { FirmwareUpdateProvider, useFirmwareUpdates } from "@/features/firmware/FirmwareUpdateProvider";

const summary = (tag: string): BoardSummary => ({
    updater: true, legacyLabel: null, usbHand: 1, differ: false, noChord: false, fwVersion: 4, tag,
    halves: [{ hand: 0, usb: false, tag, fwVersion: 4, answered: true }, { hand: 1, usb: true, tag, fwVersion: 4, answered: true }],
});

let api: ReturnType<typeof useFirmwareUpdates> = null;
function Probe() {
    api = useFirmwareUpdates();
    return <p data-testid="probe">{api?.board?.tag ?? "none"} {api?.checking ? "checking" : "idle"}</p>;
}

function setup() {
    const reads: Array<(b: BoardSummary) => void> = [];
    const readBoard = vi.fn(() => new Promise<BoardSummary>((r) => reads.push(r)));
    const connect = vi.fn();
    const view = (key: string) => (
        <FirmwareUpdateProvider host={null} readBoard={readBoard} releases={[]} connection={{ key, connect }}>
            <Probe />
        </FirmwareUpdateProvider>
    );
    const r = render(view("fake:0"));
    const answerAll = (tag: string) => act(() => { while (reads.length) reads.shift()!(summary(tag)); });
    return { readBoard, rerender: (key: string) => r.rerender(view(key)), answerAll };
}

describe("the board summary is re-read", () => {
    it("on a reconnect", async () => {
        const { readBoard, rerender, answerAll } = setup();
        answerAll("x4test10");
        await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("x4test10 idle"));
        const before = readBoard.mock.calls.length;
        rerender("fake:1");
        await waitFor(() => expect(readBoard.mock.calls.length).toBe(before + 1));
        answerAll("x4test11");
        await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("x4test11 idle"));
    });

    it("on Check again, keeping the summary from before while it runs", async () => {
        const { readBoard, answerAll } = setup();
        answerAll("x4test10");
        await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("x4test10 idle"));
        const before = readBoard.mock.calls.length;
        act(() => api!.recheck());
        await waitFor(() => expect(readBoard.mock.calls.length).toBe(before + 1));
        expect(screen.getByTestId("probe").textContent).toBe("x4test10 checking");
        answerAll("x4test11");
        await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("x4test11 idle"));
    });
});
