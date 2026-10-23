// The quiet "an update is available" signal: a dot on the Settings rail item and the
// Firmware row (U-Q1), seen once per release, remembered in this browser.

import { useCallback, useMemo, useState } from "react";

import { releasesForSite, currentSite, type FirmwareReleasePin, type Site } from "@/constants/firmware-releases";
import { appStorage } from "@/utils/app-storage";
import type { BoardSummary } from "./board-summary";

const seenKey = (tag: string) => `firmware-update-seen:${tag}`;

function seen(tag: string): boolean {
    try { return appStorage.getItem(seenKey(tag)) === "1"; } catch { return false; }
}

export interface FirmwareStatus {
    /** The newest release this site carries. */
    newest: FirmwareReleasePin | null;
    /** The board runs older firmware than `newest`, or has no updater at all. */
    updateAvailable: boolean;
    /** Show the dot: an update the user hasn't opened Firmware for yet. */
    dot: boolean;
    /** The user opened Firmware: clear the dot for this release. */
    markSeen: () => void;
}

export function firmwareStatusFor(board: BoardSummary | null, releases: FirmwareReleasePin[]): { newest: FirmwareReleasePin | null; updateAvailable: boolean } {
    const newest = releases[0] ?? null;
    // A board Keybard couldn't read: no dot until it's read (Check again, or the next connection).
    if (!board || !newest || board.unread) return { newest, updateAvailable: false };
    if (!board.updater) return { newest, updateAvailable: true };
    const behind = board.halves.some((h) => h.answered && h.fwVersion < newest.fwVersion);
    return { newest, updateAvailable: behind || board.differ };
}

export function useFirmwareStatus(board: BoardSummary | null, o: { site?: Site; releases?: FirmwareReleasePin[] } = {}): FirmwareStatus {
    const releases = useMemo(() => releasesForSite(o.site ?? currentSite(), o.releases), [o.site, o.releases]);
    const { newest, updateAvailable } = firmwareStatusFor(board, releases);
    const [, bump] = useState(0);
    const markSeen = useCallback(() => {
        if (!newest) return;
        try { appStorage.setItem(seenKey(newest.tag), "1"); } catch { /* the dot shows again next time */ }
        bump((n) => n + 1);
    }, [newest]);
    return { newest, updateAvailable, dot: updateAvailable && !!newest && !seen(newest.tag), markSeen };
}
