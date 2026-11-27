// Settings > About > Status report: a dialog that reads the board when it
// opens, reads it again on Read again, and copies the report as plain text.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatusReportDialog, {
    COPIED_MS, STATUS_REPORT_COPY_FAILED, STATUS_REPORT_DISCONNECTED, STATUS_REPORT_READ_FAILED, STATUS_REPORT_READING, breakable,
} from "../../src/layout/SecondarySidebar/Panels/settings/StatusReportDialog";
import { statusText, type BoardStatus } from "../../src/services/status-report";

const sample = (cpi: number): BoardStatus => ({
    build: "svalboard/either:sval @ x4.6.7-3-gdeadbeef", hostOs: 2, macMode: false,
    left: { scroll: false, cpi, autoMouse: true }, right: { scroll: true, cpi: 800, autoMouse: false },
    axisLock: false, naturalScroll: true, autoMouse: true, autoMouseTimeoutMs: 500,
    boostHeld: [0, 0, 0], boostToggled: [false, false, false], boostMult: 1,
    hwRevB: false, opticalDebounce: true, storageReset: false, writeFailed: false,
    prewaitUs: 90, postwaitUs: 90, periodUs: 0, idlePeriodMs: 0, idleAfterMs: 0, deepPeriodMs: 0, deepAfterS: 0,
    frameUs: 412, ledUs: 120, stage: 0, idleFlags: 0, deepMhz: 48, clockMhz: 125,
});

const mocks = vi.hoisted(() => ({
    keyboard: { feature_flags5: 0x02, kbid: "a" } as { feature_flags5: number; kbid?: string },
    connected: true,
    reads: 0,
    fail: false,
}));

vi.mock("@/contexts/KeyboardContext", () => ({ useKeyboard: () => ({ keyboard: mocks.keyboard, isConnected: mocks.connected }) }));
vi.mock("@/services/keyboard.service", () => ({
    keyboardService: {
        hasStatusReport: (kb: { feature_flags5?: number } | null) => ((kb?.feature_flags5 ?? 0) & 0x02) !== 0,
        readStatusReport: async () => {
            mocks.reads++;
            return mocks.fail ? null : sample(mocks.reads === 1 ? 1200 : 1600);
        },
    },
}));

beforeEach(() => {
    mocks.keyboard = { feature_flags5: 0x02, kbid: "a" };
    mocks.connected = true;
    mocks.reads = 0;
    mocks.fail = false;
});
afterEach(() => vi.useRealTimers());

const dialog = (open = true) => <StatusReportDialog open={open} onOpenChange={() => {}} />;

describe("StatusReportDialog", () => {
    it("reads nothing while closed", () => {
        render(dialog(false));
        expect(mocks.reads).toBe(0);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("reads the board when it opens: a loading line, then grouped rows", async () => {
        render(dialog());
        expect(screen.getByRole("dialog", { name: "Status report" })).toBeTruthy();
        expect(screen.getByText(STATUS_REPORT_READING)).toBeTruthy();
        expect((screen.getByTestId("status-report-copy") as HTMLButtonElement).disabled).toBe(true);
        expect(await screen.findByText("1200")).toBeTruthy();
        expect(screen.queryByText(STATUS_REPORT_READING)).toBeNull();
        expect(screen.getByRole("region", { name: "Pointing" })).toBeTruthy();
        expect(screen.getAllByText("90 µs").length).toBe(2);
        expect(mocks.reads).toBe(1);
    });

    it("Read again reads the board again, keeping the rows meanwhile", async () => {
        render(dialog());
        await screen.findByText("1200");
        fireEvent.click(screen.getByTestId("status-report-read"));
        expect(screen.getByText("1200")).toBeTruthy();
        expect(await screen.findByText("1600")).toBeTruthy();
        expect(mocks.reads).toBe(2);
    });

    it("Copy writes the report and says Copied for a moment", async () => {
        const writeText = vi.fn(async () => {});
        Object.assign(navigator, { clipboard: { writeText } });
        render(dialog());
        await screen.findByText("1200");
        vi.useFakeTimers();
        await act(async () => { fireEvent.click(screen.getByTestId("status-report-copy")); });
        expect(writeText).toHaveBeenCalledWith(statusText(sample(1200)));
        expect(statusText(sample(1200)).split("\n")[0]).toBe("Svalboard status report");
        expect(screen.getByTestId("status-report-copy").textContent).toBe("Copied");
        act(() => { vi.advanceTimersByTime(COPIED_MS); });
        expect(screen.getByTestId("status-report-copy").textContent).toBe("Copy");
    });

    it("says when the copy fails", async () => {
        Object.assign(navigator, { clipboard: { writeText: async () => { throw new Error("denied"); } } });
        render(dialog());
        await screen.findByText("1200");
        fireEvent.click(screen.getByTestId("status-report-copy"));
        expect(await screen.findByText(STATUS_REPORT_COPY_FAILED)).toBeTruthy();
    });

    it("a failed read is one line with Try again", async () => {
        mocks.fail = true;
        render(dialog());
        expect(await screen.findByText(STATUS_REPORT_READ_FAILED)).toBeTruthy();
        mocks.fail = false;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("1600")).toBeTruthy();
        expect(screen.queryByText(STATUS_REPORT_READ_FAILED)).toBeNull();
    });

    it("a disconnected board drops the report and says so; reconnecting reads again", async () => {
        const { rerender } = render(dialog());
        await screen.findByText("1200");
        mocks.connected = false;
        rerender(dialog());
        expect(screen.getByText(STATUS_REPORT_DISCONNECTED)).toBeTruthy();
        expect(screen.queryByText("1200")).toBeNull();
        expect((screen.getByTestId("status-report-read") as HTMLButtonElement).disabled).toBe(true);
        mocks.connected = true;
        rerender(dialog());
        expect(await screen.findByText("1600")).toBeTruthy();
    });

    it("drops the old report for another board, and on close", async () => {
        const { rerender } = render(dialog());
        await screen.findByText("1200");
        mocks.keyboard = { feature_flags5: 0x02, kbid: "b" };
        rerender(dialog());
        expect(screen.queryByText("1200")).toBeNull();
        expect(await screen.findByText("1600")).toBeTruthy();
        rerender(dialog(false));
        rerender(dialog());
        expect(screen.getByText(STATUS_REPORT_READING)).toBeTruthy();
        await waitFor(() => expect(mocks.reads).toBe(3));
    });

    it("breaks the build text after slashes and colons and before dashes", () => {
        const { container } = render(<span>{breakable("svalboard/either:sval @ x4.6.7-3-gabc")}</span>);
        expect(container.querySelectorAll("wbr").length).toBe(4);
        expect(container.textContent).toBe("svalboard/either:sval @ x4.6.7-3-gabc");
    });
});
