// The editor unmounts on every reconnect (Keybard shows the connect screen while the
// keyboard reloads), so the update's controller remounts twice during a wipe: after the
// install and after SETTINGS_RESET. The update must carry on as one flow and end on its
// result, with one SETTINGS_RESET and one 0x2A.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";

import { UpdateDialog } from "@/features/firmware/UpdateDialog";
import { useFirmwareUpdate, type FirmwareUiHost } from "@/features/firmware/useFirmwareUpdate";
import { FakeHost, fakeSetup, fixtureRelease } from "@/services/updater/fake-host";
import { memoryFlowStore, UpdateFlow, type FlowStore } from "@/services/updater/flow";
import { Op } from "@/services/updater/protocol";
import type { UpdaterTransport } from "@/services/updater/transport";
import { VirtualClock } from "@/services/updater/transport";

vi.mock("@/lib/paranoid", () => ({ PARANOID: false, userIsLooking: () => true }));

class RemountingHost extends FakeHost implements FirmwareUiHost {
    /** Called when the keyboard comes back: the app swaps the editor out and back in then. */
    onReconnect: (() => void) | null = null;
    /** Resolved by the next editor mount: the app's host waits for the reloaded layout. */
    private nextMount: (() => void) | null = null;
    mounted() { this.nextMount?.(); this.nextMount = null; }
    async waitForDevice(timeoutMs: number): Promise<UpdaterTransport | null> {
        const t = await super.waitForDevice(timeoutMs);
        if (t && this.onReconnect) {
            // Like the app: the flow carries on once the new editor has mounted.
            const remounted = new Promise<void>((r) => { this.nextMount = r; });
            this.onReconnect();
            await remounted;
        }
        return t;
    }
    async makeBackup() { return { fileName: "Kip-v3-2026-10-15.svil", svil: "{}" }; }
    boardName() { return "Kip"; }
    chordLegends(): [string, string] { return ["M", ","]; }
}

function Editor({ host, store, source, clock }: { host: RemountingHost; store: FlowStore; source: Parameters<ReturnType<typeof useFirmwareUpdate>["openSheet"]>[0]; clock: VirtualClock }) {
    const fw = useFirmwareUpdate(host, { store, releases: [] });
    useEffect(() => { host.mounted(); }, [host]);
    return (
        <>
            {fw.ui.kind === "idle" && <button onClick={() => void fw.openSheet(source)}>Open</button>}
            <UpdateDialog ui={fw.ui} now={() => clock.now()} chordLegends={() => ["M", ","]} cancellable={!!fw.flow?.cancellable} onAfterwards={fw.setAfterwards} onStart={fw.start} onCancel={fw.close} onClose={fw.close} onFailureAction={() => fw.close()} />
        </>
    );
}

describe("an update while the editor remounts on each reconnect", () => {
    async function wipeWithRemounts(o: { strict?: boolean; hidden?: boolean } = {}) {
        const clock = new VirtualClock();
        const v3 = await fixtureRelease("v3", 3000);
        const x32 = await fixtureRelease("x3.2", 4000, { noChord: true });
        const { board } = fakeSetup({ clock, running: v3, noChord: true });
        const host = new RemountingHost(board, clock);
        const store = memoryFlowStore();
        const source = { kind: "file" as const, files: [x32.files[0], x32.files[1]] };
        let remounts = 0;
        function App() {
            const [gen, setGen] = useState(0);
            host.onReconnect = () => { remounts++; setGen((g) => g + 1); };
            return <Editor key={gen} host={host} store={store} source={source} clock={clock} />;
        }
        const runs = vi.spyOn(UpdateFlow.prototype, "run");
        const visibility = o.hidden ? vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden") : null;
        render(o.strict ? <StrictMode><App /></StrictMode> : <App />);
        try {
            fireEvent.click(screen.getByRole("button", { name: "Open" }));
            await screen.findByTestId("update-sheet");
            fireEvent.click(await screen.findByRole("radio", { name: "Start from a blank keyboard" }));
            const start = await screen.findByRole("button", { name: /^(Update anyway|Update)$/ });
            await waitFor(() => expect(start).not.toBeDisabled());
            await act(async () => { fireEvent.click(start); });
            if (o.hidden) await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
            await waitFor(() => expect(store.load()?.state.phase).toBe("result"), { timeout: 10_000 });
            // The dialog follows the flow to its result, after every remount.
            await screen.findByTestId("update-result", {}, { timeout: 2_000 });
            // Let any second copy of the flow finish what it started.
            await act(async () => { for (let i = 0; i < 50; i++) await clock.sleep(1000); });
            expect(remounts).toBeGreaterThanOrEqual(2);
            // The remounted editor shows the running flow; it never starts a second copy from the saved state.
            expect(runs).toHaveBeenCalledTimes(1);
            expect(board.requests.filter((r) => r.op === Op.SETTINGS_RESET)).toHaveLength(1);
            expect(host.events.filter((e) => e === "0x2A")).toHaveLength(1);
            expect(store.load()?.state.phase).toBe("result");
            expect(screen.getByTestId("update-result")).toBeTruthy();
            expect(board.storageFlags & 4).toBe(0);
        } finally {
            runs.mockRestore();
            visibility?.mockRestore();
        }
    }

    it("Wipe to a blank board runs as one flow to its result: one SETTINGS_RESET, one 0x2A, no second run", async () => {
        await wipeWithRemounts();
    });

    // Development runs under StrictMode, which mounts every effect twice. The remounted
    // controller attached in an effect, and StrictMode's extra cleanup dropped its
    // subscription: the flow reached its result and the dialog stayed on "Restarting".
    it("under StrictMode, with the tab in the background, the remounted dialog still reaches the result", async () => {
        await wipeWithRemounts({ strict: true, hidden: true });
    });
});
