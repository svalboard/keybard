import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";

import { currentSite, matchPin, parseReleaseTag, releasesForSite, type FirmwareReleasePin } from "@/constants/firmware-releases";
import { FirmwareSection } from "@/features/firmware/FirmwareSection";
import { lightFor } from "@/features/firmware/lights";
import { ConfirmView, ProgressView, overallProgress, stageLine, timeLeft } from "@/features/firmware/ProgressDialog";
import { UpdateDialog, resultTitle } from "@/features/firmware/UpdateDialog";
import { UpdateSheet } from "@/features/firmware/UpdateSheet";
import { useFirmwareUpdate, type FirmwareUiHost } from "@/features/firmware/useFirmwareUpdate";
import { firmwareStatusFor } from "@/features/firmware/useFirmwareStatus";
import { failureCopy } from "@/features/firmware/failures";
import { FakeHost, fakeSetup, fixtureOneImage, fixturePairUf2, fixturePerSideUf2 } from "@/services/updater/fake-host";
import { memoryFlowStore, type FlowState, type Step } from "@/services/updater/flow";
import type { Plan } from "@/services/updater/checks";
import { VirtualClock } from "@/services/updater/transport";
import type { BoardSummary } from "@/features/firmware/board-summary";

vi.mock("@/lib/paranoid", () => ({ PARANOID: false, userIsLooking: () => true }));

const rel = (tag: string, fwVersion: number, protocol = 4): FirmwareReleasePin => ({
    tag, kind: tag[0] as "v" | "x", fwVersion, updaterProtocol: protocol,
    file: { uf2: `svalboard_sval_${tag}.uf2`, sha256: `${tag}-sha`, size: 1 },
    notesUrl: `https://example.com/${tag}`,
});

describe("carried releases per site", () => {
    const all = [rel("v2", 2000), rel("v3", 3000), rel("v4", 4000), rel("x5", 5000), rel("x3.2.1", 4100), rel("v1", 1000, 3)];

    it("production offers the newest v and the one before it", () => {
        expect(releasesForSite("production", all).map((r) => r.tag)).toEqual(["v4", "v3"]);
    });

    it("next offers the newest x and the same v releases, newest first", () => {
        expect(releasesForSite("next", all).map((r) => r.tag)).toEqual(["x5", "v4", "v3"]);
    });

    it("dev builds offer every protocol-4 release; protocol-3 ones are never listed", () => {
        expect(releasesForSite("dev", all).map((r) => r.tag)).toEqual(["x5", "x3.2.1", "v4", "v3", "v2"]);
    });

    it("is empty until a protocol-4 release is pinned", () => {
        expect(releasesForSite("production")).toEqual([]);
        expect(releasesForSite("next")).toEqual([]);
    });

    it("reads the site from the build mode", () => {
        expect(currentSite({ MODE: "svalboard" })).toBe("production");
        expect(currentSite({ MODE: "paranoid" })).toBe("production");
        expect(currentSite({ MODE: "next", VITE_CHANNEL: "next" })).toBe("next");
        expect(currentSite({ MODE: "production", BASE_URL: "/keybard-test/" })).toBe("next");
        expect(currentSite({ MODE: "development" })).toBe("dev");
    });

    it("parses v and x tags only, and matches pins by SHA-256", () => {
        expect(parseReleaseTag("v3.1")).toEqual({ kind: "v", parts: [3, 1] });
        expect(parseReleaseTag("vLaunch2")).toBeNull();
        expect(parseReleaseTag("x3-rc1")).toBeNull();
        expect(matchPin("v3-sha", all)?.release.tag).toBe("v3");
        expect(matchPin("nope", all)).toBeNull();
    });
});

function fs(step: Step, o: Partial<FlowState> = {}): FlowState {
    return {
        version: 1, id: "t", phase: "running", target: "both", usbHand: 1, title: "Update to x4", toTag: "x4", fromTag: "v3", files: {},
        afterwards: "restore", backup: null, noChord: false, step, stepAt: 0, approveAt: 0, committed: [], halvesDone: [], approvalsAsked: 1,
        rows: [{ hand: 0, usb: false, stage: "waiting", progress: 0, fromTag: "v3", toTag: "x4" }, { hand: 1, usb: true, stage: "waiting", progress: 0, fromTag: "v3", toTag: "x4" }],
        settingsResetSent: false, sent2A: false, startedAt: 0, finishedAt: null, result: null, failure: null, measurements: {}, ...o,
    };
}

describe("the lights, from the firmware's table (update-flow 5.3)", () => {
    const at = (step: Step, hand: 0 | 1, o?: Partial<FlowState>) => lightFor(fs(step, o), hand, 1000);
    it("blue blinks on the half with USB only while it waits for the chord", () => {
        expect(at("approve", 1)).toBe("blue-blink");
        expect(at("approve", 0)).toBe("layer");
        for (const step of ["other-send", "relay", "self-send", "self-arm"] as Step[]) expect(at(step, 1)).not.toBe("blue-blink");
    });
    it("rainbow while busy; both halves while copying", () => {
        expect(at("other-send", 1)).toBe("rainbow");
        expect(at("relay", 0)).toBe("rainbow");
        expect(at("relay", 1)).toBe("rainbow");
    });
    it("magenta on both halves while the other half installs; red between the halves", () => {
        expect(at("other-install", 0)).toBe("magenta");
        expect(at("other-install", 1)).toBe("magenta");
        expect(at("other-restart", 1)).toBe("red-slow");
        expect(at("self-install", 1)).toBe("magenta");
    });
});

describe("the running screens (5.1)", () => {
    it("asks for the keys only while the board waits for them, naming the half and why", () => {
        render(<ConfirmView state={fs("approve", { approveAt: 0 })} legends={["M", ","]} now={2_000} />);
        expect(screen.getByRole("heading", { name: "Confirm on your keyboard" })).toBeTruthy();
        expect(screen.getByText("Firmware only changes when someone at the keyboard says so.")).toBeTruthy();
        expect(screen.getByTestId("update-confirm").textContent).toContain("On the right half, press M and , together and hold them for a second.");
        expect(screen.getByText("28 seconds left")).toBeTruthy();
        expect(screen.getByRole("img", { name: "right half: press M and ," })).toBeTruthy();
    });

    it("Updating shows one bar, the stage now, and the time left", () => {
        render(<ProgressView state={fs("relay", { rows: [{ hand: 1, usb: true, stage: "waiting", progress: 0, fromTag: "v3", toTag: "x4" }, { hand: 0, usb: false, stage: "copying", progress: 0.5, fromTag: "v3", toTag: "x4" }] })} now={0} />);
        expect(screen.getAllByRole("progressbar")).toHaveLength(1);
        expect(screen.getByRole("heading", { name: "Updating your keyboard" })).toBeTruthy();
        expect(screen.getByText("Keep the keyboard plugged in, and keep the cable between the halves connected.")).toBeTruthy();
        expect(screen.getByTestId("update-stage").textContent).toBe("Copying it to the left half. Don't type on that half until it's done.");
        expect(screen.getByText("About a minute left")).toBeTruthy();
    });

    it("the bar only moves forward through an update of both halves", () => {
        const steps: Step[] = ["start", "other-erase", "other-send", "other-verify", "relay", "other-install", "other-restart", "self-arm", "self-erase", "self-send", "self-verify", "self-install", "reconnect", "check-halves", "restore", "done"];
        const values = steps.map((step) => overallProgress(fs(step)));
        for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
        expect(values[values.length - 1]).toBe(1);
        expect(stageLine(fs("other-restart"))).toMatch(/stays red until it's updated too/);
        expect(timeLeft(fs("start"), 0)).toBe("About 2 minutes left");
    });

    it("titles Done by what's installed", () => {
        expect(resultTitle(fs("done", { title: "Update to x4" }))).toBe("x4 is installed");
        expect(resultTitle(fs("done", { title: "Update to x4", target: 0 }))).toBe("x4 is installed on the left half");
        expect(resultTitle(fs("done", { title: "Install custom firmware" }))).toBe("The custom firmware is installed");
    });

    it("words the failures with their exact next step, and never asks to approve", () => {
        expect(failureCopy({ id: "F9", tags: { 0: "x4", 1: "v3" } })).toMatchObject({ title: "Halves differ", body: "Left half x4 · Right half v3" });
        render(<>{failureCopy({ id: "F5", detail: "The keyboard's copy doesn't match the file." }, { fromTag: "v3" }).body}</>);
        expect(screen.getByText("The keyboard's copy doesn't match the file.")).toBeTruthy();
        expect(screen.getByText("Nothing was changed: your keyboard still runs v3.")).toBeTruthy();
        expect(failureCopy({ id: "F11", hand: 0 }).title).toBe("Left half needs its firmware installed by hand");
        expect(failureCopy({ id: "F4" }).title).toBe("The keys weren't pressed in time");
    });
});

const board = (o: Partial<BoardSummary> = {}): BoardSummary => ({
    updater: true, legacyLabel: null, usbHand: 1, differ: false, noChord: false, fwVersion: 3000, tag: "v3",
    halves: [{ hand: 0, usb: false, tag: "v3", fwVersion: 3000, answered: true }, { hand: 1, usb: true, tag: "v3", fwVersion: 3000, answered: true }], ...o,
});

describe("the Firmware card (D2)", () => {
    const releases = [rel("x4", 4000), rel("v3", 3000)];
    it("shows each half and the newest release with one button; the rest is under Other versions and files", () => {
        const onInstall = vi.fn();
        render(<FirmwareSection board={board()} releases={releases} onInstall={onInstall} onManual={vi.fn()} paranoid={false} />);
        expect(screen.getByTestId("firmware-halves").textContent).toBe("Left halfv3Right halfv3 · plugged in");
        expect(screen.getByText("x4 is available")).toBeTruthy();
        expect(screen.getByRole("link", { name: "What's new in x4 ↗" })).toHaveAttribute("href", "https://example.com/x4");
        expect(screen.queryByRole("button", { name: "Install a firmware file…" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Update to x4" }));
        expect(onInstall).toHaveBeenCalledWith({ kind: "release", release: releases[0] });
        fireEvent.click(screen.getByRole("button", { name: "Other versions and files" }));
        fireEvent.click(screen.getByRole("button", { name: "Reinstall v3" }));
        expect(onInstall).toHaveBeenLastCalledWith({ kind: "release", release: releases[1] });
        expect(screen.getByRole("button", { name: "Install a firmware file…" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Update one half only…" }));
        fireEvent.click(screen.getByRole("button", { name: "Left half" }));
        expect(onInstall).toHaveBeenLastCalledWith({ kind: "release", release: releases[1] }, 0);
    });

    it("up to date, a board that installs by hand, halves that differ, no keyboard", () => {
        const { rerender } = render(<FirmwareSection board={board({ fwVersion: 4000, tag: "x4", halves: board().halves.map((h) => ({ ...h, fwVersion: 4000, tag: "x4" })) })} releases={releases} onInstall={vi.fn()} onManual={vi.fn()} paranoid={false} />);
        expect(screen.getByText(/Your keyboard has the newest firmware/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
        const onManual = vi.fn();
        rerender(<FirmwareSection board={board({ updater: false, legacyLabel: "x3.1.3", halves: [] })} releases={releases} onInstall={vi.fn()} onManual={onManual} paranoid={false} />);
        expect(screen.getByTestId("firmware-halves").textContent).toBe("Right halfx3.1.3 · plugged in");
        fireEvent.click(screen.getByRole("button", { name: "Update to x4" }));
        expect(onManual).toHaveBeenCalledWith(releases[0]);
        rerender(<FirmwareSection board={board({ differ: true })} releases={releases} onInstall={vi.fn()} onManual={vi.fn()} paranoid={false} />);
        expect(screen.getByText("The halves run different firmware.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Finish update" })).toBeTruthy();
        rerender(<FirmwareSection board={null} releases={releases} onInstall={vi.fn()} onManual={vi.fn()} onConnect={vi.fn()} paranoid={false} />);
        expect(screen.getByText("Connect a keyboard to see its firmware.")).toBeTruthy();
    });

    it("Install a firmware file… takes one .uf2 for both halves; an older per-side file is refused with the steps by hand", async () => {
        const onInstall = vi.fn();
        render(<FirmwareSection board={board()} releases={releases} onInstall={onInstall} onManual={vi.fn()} paranoid={false} />);
        fireEvent.click(screen.getByRole("button", { name: "Other versions and files" }));
        expect(screen.getByRole("button", { name: "Install a firmware file…" })).toBeTruthy();
        const input = screen.getByTestId("firmware-file-input") as HTMLInputElement;
        expect(input.accept).toBe(".uf2");
        expect(input.multiple).toBe(false);
        const file = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name);
        fireEvent.change(input, { target: { files: [file(await fixturePerSideUf2("x3.1.3", 2301, 0), "svalboard_left_sval_x3.1.3.uf2")] } });
        await waitFor(() => expect(screen.getByTestId("firmware-file-error")).toBeTruthy());
        expect(screen.getByTestId("firmware-file-error").textContent).toBe("Keybard installs only firmware files that update both halves, from x4 on. To install this file by hand, plug in the half it's for, press its RESET button twice, then drag the file onto the RPI-RP2 drive.");
        expect(onInstall).not.toHaveBeenCalled();
        fireEvent.change(input, { target: { files: [file(await fixturePairUf2("x4", 4000), "svalboard_sval_x4.uf2")] } });
        await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1));
        const pick = onInstall.mock.calls[0][0];
        expect(pick.kind).toBe("files");
        expect(pick.files).toHaveLength(1);
        expect(pick.files[0].manifest).toMatchObject({ hand: 2, tag: "x4" });
        expect(screen.queryByTestId("firmware-file-error")).toBeNull();
    });

    it("never shows release highlights", () => {
        const withHighlights = { ...releases[0], highlights: ["One hold approves both halves"] } as FirmwareReleasePin;
        render(<FirmwareSection board={board()} releases={[withHighlights]} onInstall={vi.fn()} onManual={vi.fn()} paranoid={false} />);
        expect(screen.queryByText("One hold approves both halves")).toBeNull();
    });

    it("Paranoid offers only a firmware file", () => {
        render(<FirmwareSection board={board()} releases={releases} onInstall={vi.fn()} onManual={vi.fn()} paranoid />);
        expect(screen.getAllByRole("button", { name: "Install a firmware file…" }).length).toBeGreaterThan(0);
        expect(screen.queryByText(/is available/)).toBeNull();
    });

    it("the rail dot: an update when a half is behind the newest carried release", () => {
        expect(firmwareStatusFor(board(), releases).updateAvailable).toBe(true);
        expect(firmwareStatusFor(board({ halves: board().halves.map((h) => ({ ...h, fwVersion: 4000 })) }), releases).updateAvailable).toBe(false);
        expect(firmwareStatusFor(board(), []).updateAvailable).toBe(false);
    });
});

describe("the sheet (B1) and the dialog against the mock board", () => {
    let clock: VirtualClock;
    beforeEach(() => { clock = new VirtualClock(); });

    class UiHost extends FakeHost implements FirmwareUiHost {
        backups = 0;
        failBackup = false;
        async makeBackup() { this.backups++; if (this.failBackup) throw new Error("disk full"); return { fileName: "Kip-v3-2026-10-15.svil", svil: "{}" }; }
        boardName() { return "Kip"; }
        chordLegends(): [string, string] { return ["M", ","]; }
    }

    function Harness({ host, source }: { host: UiHost; source: Parameters<ReturnType<typeof useFirmwareUpdate>["openSheet"]>[0] }) {
        const fw = useFirmwareUpdate(host, { store: memoryFlowStore(), releases: [] });
        const [opened, setOpened] = useState(false);
        return (
            <>
                {!opened && <button onClick={() => { setOpened(true); void fw.openSheet(source); }}>Open</button>}
                <UpdateDialog ui={fw.ui} now={() => clock.now()} chordLegends={() => ["M", ","]} cancellable={!!fw.flow?.cancellable} onAfterwards={fw.setAfterwards} onStart={fw.start} onCancel={fw.close} onClose={fw.close} onFailureAction={() => fw.close()} />
            </>
        );
    }

    async function setup(o: { noChord?: boolean; failBackup?: boolean; devFile?: boolean; releaseBoard?: boolean } = {}) {
        const v3 = await fixtureOneImage("v3", 3000);
        const x32 = await fixtureOneImage("x4", 4000, { noChord: o.devFile });
        const { board: fake } = fakeSetup({ clock, running: v3, noChord: o.noChord, release: o.releaseBoard });
        const host = new UiHost(fake, clock);
        host.failBackup = !!o.failBackup;
        render(<Harness host={host} source={{ kind: "file", files: [x32.files[0]] }} />);
        fireEvent.click(screen.getByRole("button", { name: "Open" }));
        await screen.findByTestId("update-sheet");
        return { host, fake };
    }

    it("passed checks say nothing; a warning is a sentence with what to do, and the button reads Update anyway", async () => {
        const { host } = await setup();
        await waitFor(() => expect(screen.getByText(/Saved to Downloads/)).toBeTruthy());
        expect(host.backups).toBe(1);
        expect(screen.queryByText(/Both halves connected|Firmware files verified|Layout saved/)).toBeNull();
        expect(screen.getByText("Keybard can't check where this file came from.")).toBeTruthy();
        expect(screen.getByText("Install it only if you trust where you got it.")).toBeTruthy();
        expect(screen.getByText("Keybard updates both halves through the cable to your computer. It takes about 2 minutes.")).toBeTruthy();
        expect(screen.queryByText(/\bhold\b|approv/i)).toBeNull();
        expect(screen.getByRole("button", { name: "Update anyway" })).not.toBeDisabled();
    });

    it("a refused install downloads no backup and offers no Update", async () => {
        const { host } = await setup({ devFile: true, releaseBoard: true });
        expect(screen.getByText(/won't accept this file/)).toBeTruthy();
        await act(async () => { await clock.sleep(1000); });
        expect(host.backups).toBe(0);
        expect(screen.queryByText(/Saved to Downloads/)).toBeNull();
        expect(screen.queryByRole("button", { name: /^Update/ })).toBeNull();
    });

    it("a failed backup says so and switches to the default layout", async () => {
        await setup({ failBackup: true });
        await waitFor(() => expect(screen.getByText("Keybard couldn't save your layout.")).toBeTruthy());
        expect(screen.getByRole("radio", { name: "Restore my layout" })).toBeDisabled();
        expect(screen.getByRole("radio", { name: "Start from the default layout" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Start from a blank keyboard" })).not.toBeDisabled();
    });

    it("P4-31 the layout choice: three options, Restore my layout first and chosen", async () => {
        await setup();
        await waitFor(() => expect(screen.getByRole("radio", { name: "Restore my layout" })).not.toBeDisabled());
        const radios = within(screen.getByRole("radiogroup", { name: "After the update" })).getAllByRole("radio");
        expect(radios.map((r) => r.getAttribute("value"))).toEqual(["restore", "defaults", "blank"]);
        expect(screen.getByRole("radio", { name: "Restore my layout" })).toBeChecked();
        fireEvent.click(screen.getByRole("radio", { name: "Start from a blank keyboard" }));
        expect(screen.getByRole("radio", { name: "Start from a blank keyboard" })).toBeChecked();
    });

    it("Update runs to Done; Confirm on your keyboard shows only while the board waits for the keys", async () => {
        const { fake } = await setup();
        await waitFor(() => expect(screen.getByRole("button", { name: "Update anyway" })).not.toBeDisabled());
        expect(screen.queryByTestId("update-confirm")).toBeNull();
        const seen: string[] = [];
        const watch = setInterval(() => {
            if (screen.queryByTestId("update-confirm")) seen.push(`${fake.chordRequests}:${fake.chordsMade}`);
        }, 5);
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update anyway" })); });
        await screen.findByTestId("update-result", {}, { timeout: 10_000 });
        clearInterval(watch);
        expect(screen.getByRole("heading", { name: "The custom firmware is installed" })).toBeTruthy();
        expect(screen.getByText("Your layout is back on the keyboard.")).toBeTruthy();
        expect(fake.chordRequests).toBe(1);
        // Whenever the confirm screen showed, the board had asked and the keys weren't pressed yet.
        expect(seen.every((x) => x === "1:0")).toBe(true);
    });

    it("the dialog's accessible name is its one visible title", async () => {
        await setup();
        const dialog = screen.getByRole("dialog");
        await waitFor(() => expect(dialog).toHaveAccessibleName("Install custom firmware"));
        expect(within(dialog).getAllByRole("heading")).toHaveLength(1);
        expect(dialog.textContent).not.toMatch(/Firmware update for the/);
    });

    it("P4-31 a blank keyboard doesn't wait for the backup: Update is on while it saves", () => {
        const plan = { board: { usb: { hand: 1 }, noChord: true }, target: "both", title: "Update to x4", toTag: "x4", checks: [], warnings: [], refusal: null, otherSilent: false } as unknown as Plan;
        const sheet = (afterwards: "restore" | "blank") => <UpdateSheet ui={{ kind: "sheet", source: { kind: "file", files: [] }, plan, preFailure: null, backup: { state: "pending" }, afterwards, error: null }} onAfterwards={vi.fn()} onStart={vi.fn()} onCancel={vi.fn()} />;
        const { rerender } = render(sheet("restore"));
        expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
        rerender(sheet("blank"));
        expect(screen.getByRole("button", { name: "Update" })).not.toBeDisabled();
    });

    it("renders the sheet's integrity refusal with Reload and Close only", () => {
        const plan = { board: { usb: { hand: 1 }, noChord: false }, target: "both", title: "Update to x4", toTag: "x4", checks: [], warnings: [], refusal: { id: "integrity", label: "The firmware file failed its check.", state: "refuse", detail: "Keybard won't install it. Reload Keybard and try again." }, otherSilent: false } as unknown as Plan;
        render(<UpdateSheet ui={{ kind: "sheet", source: { kind: "file", files: [] }, plan, preFailure: null, backup: { state: "pending" }, afterwards: "restore", error: null }} onAfterwards={vi.fn()} onStart={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getAllByText("The firmware file failed its check.")).toHaveLength(1);
        expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^Update|anyway/ })).toBeNull();
    });
});
