// On every connect: do the halves run different firmware? From STATUS presence and INFO
// flags bit5 on the half with USB (F9 / Q17). Quiet when the board has no updater.

import { useEffect, useState } from "react";

import { useKeyboard } from "@/contexts/KeyboardContext";
import { updateInFlight } from "@/services/updater/flow";
import { usbInstance } from "@/services/usb.service";
import { WebHidUpdaterTransport } from "@/services/updater/webhid-transport";
import { usbSideHost } from "@/services/side-host";
import { readBoardSummary, type BoardSummary } from "./board-summary";

/** Ask the app to open Settings > Firmware (FirmwareUpdateProvider listens). */
export const OPEN_FIRMWARE_EVENT = "keybard:open-firmware";

/** Ask the app to show Backups (FirmwareUpdateProvider listens). */
export const OPEN_BACKUPS_EVENT = "keybard:open-backups";

/** What the connected board runs, read once per connection, and again when `refresh` changes. */
export function useBoardSummary(refresh = 0): BoardSummary | null {
    return useBoardRead(refresh).board;
}

/**
 * The board summary, and whether a read asked for by `refresh` is still running (the
 * summary from the read before stays meanwhile, so the card doesn't flash empty).
 */
export function useBoardRead(refresh = 0): { board: BoardSummary | null; checking: boolean } {
    const { isConnected, keyboard, connectionSessionId } = useKeyboard();
    const [summary, setSummary] = useState<{ session: number; refresh: number; board: BoardSummary } | null>(null);
    const loaded = isConnected && !!keyboard;
    useEffect(() => {
        if (!loaded || updateInFlight()) return;
        let cancelled = false;
        const session = connectionSessionId;
        void readBoardSummary(new WebHidUpdaterTransport(usbInstance), keyboard, usbSideHost(usbInstance))
            .then((board) => { if (!cancelled) setSummary({ session, refresh, board }); })
            // A read that throws keeps what was read before, and stops checking.
            .catch(() => { if (!cancelled) setSummary((prev) => (prev?.session === session ? { ...prev, refresh } : prev)); });
        return () => { cancelled = true; };
        // Once per connection (and per refresh), after the load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, connectionSessionId, refresh]);
    const board = loaded && summary?.session === connectionSessionId ? summary.board : null;
    return { board, checking: !!board && summary!.refresh !== refresh && !updateInFlight() };
}
