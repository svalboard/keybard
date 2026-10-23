// The app's flow host across the editor's remount on a reconnect: Keybard shows the
// connect screen while the keyboard reloads, so the editor (and this hook) unmounts and
// mounts again mid-update. The host the update holds must see the new mount's keyboard.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const kb = vi.hoisted(() => ({
    current: { isConnected: true, connectionSessionId: 1, keyboard: { kbid: "abc", keymap: [[4, 5]] } as Record<string, unknown> | null, setKeyboard: vi.fn(), connectDevice: vi.fn() },
}));
vi.mock("@/contexts/KeyboardContext", () => ({ useKeyboard: () => kb.current, listPermittedDevices: async () => [{}] }));
vi.mock("@/contexts/ChangesContext", () => ({ useChanges: () => ({ queue: vi.fn(), commit: vi.fn() }) }));
vi.mock("@/contexts/BackupContext", () => ({ useBackups: () => ({ board: null, snapshots: [] }), serializeForBackup: () => "{}" }));
const usb = vi.hoisted(() => ({ open: true, sent: [] as number[], known: true }));
vi.mock("@/services/usb.service", () => ({
    SvilUSB: { CMD_SVIL_GET_INFO: 0x00, CMD_SVIL_STORAGE_RESET_CLEAR: 0x2a },
    usbInstance: { isOpen: () => usb.open, hasDevice: () => usb.known, sendSvil: async (cmd: number) => { usb.sent.push(cmd); return new Uint8Array(32); } },
}));
vi.mock("@/services/updater/webhid-transport", () => ({ WebHidUpdaterTransport: class { connected() { return usb.open; } } }));

import { useAppFirmwareHost } from "@/features/firmware/useAppFirmwareHost";
import type { FirmwareUiHost } from "@/features/firmware/useFirmwareUpdate";
import { resetNoticeClearedOn } from "@/services/updater/flow";

function Editor({ onHost }: { onHost: (h: FirmwareUiHost) => void }) {
    onHost(useAppFirmwareHost());
    return null;
}

describe("the app's flow host when the editor remounts on a reconnect", () => {
    beforeEach(() => {
        usb.open = true;
        usb.sent = [];
        usb.known = true;
        kb.current = { ...kb.current, isConnected: true, connectionSessionId: 1, keyboard: { kbid: "abc", keymap: [[4, 5]] } };
    });

    it("sees the keyboard the new editor loaded: the reconnect, the blank check and 0x2A", async () => {
        let held: FirmwareUiHost | null = null;
        const first = render(<Editor onHost={(h) => { held ??= h; }} />);
        // The keyboard restarts: the connection drops, then the editor is swapped out.
        usb.open = false;
        kb.current = { ...kb.current, isConnected: false };
        first.rerender(<Editor onHost={() => undefined} />);
        first.unmount();
        const back = held!.waitForDevice(3000);
        // It comes back wiped, and the editor mounts again on the loaded layout.
        usb.open = true;
        kb.current = { ...kb.current, isConnected: true, connectionSessionId: 2, keyboard: { kbid: "abc", keymap: [[0, 0], [0, 0]], storage_build_reset: true } };
        render(<Editor onHost={() => undefined} />);
        expect(await back).not.toBeNull();
        expect(await held!.keymapBlank!()).toBe(true);
        await held!.clearStorageReset();
        expect(usb.sent).toEqual([0x2a]);
        // The loaded layout keeps its flag; the reset dialog learns that 0x2A went out on this connection.
        expect(resetNoticeClearedOn(2)).toBe(true);
        expect(kb.current.setKeyboard).not.toHaveBeenCalled();
    }, 10_000);

    it("reopens the keyboard after the restart without asking to discard edits", async () => {
        let held: FirmwareUiHost | null = null;
        render(<Editor onHost={(h) => { held ??= h; }} />);
        usb.open = false;
        usb.known = false; // a new device after the restart
        const connectDevice = vi.fn(async () => { usb.open = true; usb.known = true; return true; });
        kb.current = { ...kb.current, isConnected: false, connectDevice };
        render(<Editor onHost={() => undefined} />);
        const back = held!.waitForDevice(3000);
        await vi.waitFor(() => expect(connectDevice).toHaveBeenCalled());
        kb.current = { ...kb.current, isConnected: true, connectionSessionId: 3 };
        render(<Editor onHost={() => undefined} />);
        expect(await back).not.toBeNull();
        expect(connectDevice).toHaveBeenCalledWith(expect.anything(), { discardEdits: true });
    }, 10_000);
});
