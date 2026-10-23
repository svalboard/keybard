// The manual install's state (M): the backup taken when it opened, the layout choice,
// what Keybard read from each half when the keyboard came back, and what happened then.
// Nothing here records what the person says they did: the only check is the firmware
// each half runs when it is connected again.
//
// It lives in sessionStorage, like the flow's, because the editor unmounts while the
// keyboard reconnects (it shows the connect screen until the layout loads): the dialog
// that comes back must still hold the backup, and put it back. Closing the dialog, or
// the tab, forgets it; the pre-update snapshot and the downloaded file still hold the layout.

import type { FlowHost } from "./flow";
import { sidesNeedAnswer, type SideAssessment } from "../side-decision";
import type { Hand } from "./protocol";

/** The manual install can't wipe to a blank board: that needs the in-app updater's SETTINGS_RESET. */
export type ManualAfterwards = "restore" | "defaults";

export type ManualBackup =
    | { state: "pending" }
    | { state: "ok"; fileName: string; snapshotId?: string; svil: string }
    | { state: "failed"; error: string };

/** What one half runs, as read on Connect. */
export type ManualHalfState =
    | { state: "new" }
    /** tag: what it runs, when Keybard can name it. */
    | { state: "old"; tag?: string }
    /** It didn't answer over the split cable (firmware without the updater doesn't). */
    | { state: "silent" }
    /** The half with USB runs firmware Keybard can't ask about the other half. */
    | { state: "unknown" };

export interface ManualCheck {
    halves: Partial<Record<Hand, ManualHalfState>>;
    /** One-image firmware: a half has no side, or both claim one. Asked before the layout goes back. */
    sides?: SideAssessment | null;
}

export interface ManualSession {
    version: 2;
    id: string;
    /** The release offered for download (null: the firmware release page). */
    releaseTag: string | null;
    only?: Hand;
    /** The half the user usually plugs in; the other goes first (U-Q5). */
    usualHand: Hand;
    /** Null: no keyboard was connected when it opened, so there's no backup. */
    backup: ManualBackup | null;
    afterwards: ManualAfterwards;
    /** The release's firmware version, to tell a half that has it (null: no release carried). */
    releaseFw: number | null;
    /** What the board ran when it opened, to name a half that still runs it. */
    fromTag: string;
    fromFw: number | null;
    /** The board had no updater Keybard installs through: this install is the once-only move onto one. */
    once: boolean;
    /** The connection when it opened: the keyboard coming back is any other one. */
    openKey: string | null;
    /** The connection the last check read, so each connection is checked once. */
    checkedKey: string | null;
    /** The last check, null until the first Connect. */
    check: ManualCheck | null;
    phase: "steps" | "restoring" | "done" | "failed";
    /**
     * Closed before the keyboard came back (the person reconnects with the app's own
     * Connect). Kept out of sight with its backup: the next connection carries on if the
     * install happened, and forgets it if not.
     */
    dismissed?: boolean;
    /** kept: the default layout chosen, but the install reset nothing (a reinstall of the same build). */
    result: { layout: "restored" | "defaults" | "kept"; trimmed: string[] } | null;
    error: string | null;
}

export interface ManualStore {
    load(): ManualSession | null;
    save(session: ManualSession): void;
    clear(): void;
}

export const MANUAL_KEY = "keybard:firmware-manual-install";

/** sessionStorage: per tab, survives the editor's remount and a reload, gone with the tab. */
export function sessionManualStore(storage: Storage | null = typeof sessionStorage === "undefined" ? null : sessionStorage, onChange: () => void = () => undefined): ManualStore {
    return {
        load() {
            try {
                const raw = storage?.getItem(MANUAL_KEY);
                const s = raw ? (JSON.parse(raw) as ManualSession) : null;
                return s?.version === 2 ? s : null;
            } catch { return null; }
        },
        save(session) {
            const had = (() => { try { return !!storage?.getItem(MANUAL_KEY); } catch { return false; } })();
            try { storage?.setItem(MANUAL_KEY, JSON.stringify(session)); } catch (e) { console.warn("[firmware] couldn't save the manual install state", e); }
            if (!had) onChange();
        },
        clear() {
            try { storage?.removeItem(MANUAL_KEY); } catch { /* nothing to do */ }
            onChange();
        },
    };
}

export function memoryManualStore(): ManualStore {
    let saved: string | null = null;
    return {
        load: () => (saved ? (JSON.parse(saved) as ManualSession) : null),
        save: (s) => { saved = JSON.stringify(s); },
        clear: () => { saved = null; },
    };
}

/** A manual install open in this tab owns the board's reset notice: it acts on it once the keyboard is back. */
export function manualOwnsResetNotice(storage: Storage | null = typeof sessionStorage === "undefined" ? null : sessionStorage): boolean {
    try { return !!storage?.getItem(MANUAL_KEY); } catch { return false; }
}

export function newManualSession(o: {
    releaseTag: string | null; releaseFw?: number | null; fromTag?: string; fromFw?: number | null;
    only?: Hand; usualHand?: Hand; openKey: string | null; connected: boolean; once?: boolean;
}): ManualSession {
    return {
        version: 2, id: Math.random().toString(36).slice(2, 10), releaseTag: o.releaseTag, releaseFw: o.releaseFw ?? null,
        fromTag: o.fromTag ?? "", fromFw: o.fromFw ?? null, once: !!o.once, only: o.only, usualHand: o.usualHand ?? 1,
        backup: o.connected ? { state: "pending" } : null,
        // Restore my layout once the backup is saved; with no keyboard there is nothing to keep.
        afterwards: o.connected ? "restore" : "defaults",
        openKey: o.openKey, checkedKey: null, check: null, phase: "steps", result: null, error: null,
    };
}

/** The halves the install covers, the other half first (U-Q5). */
export function manualHalves(only: Hand | undefined, usualHand: Hand = 1): Hand[] {
    return only !== undefined ? [only] : [(usualHand === 0 ? 1 : 0) as Hand, usualHand];
}

/** Whether a connection is one to check: a new one since the dialog opened, not checked yet. */
export function manualShouldCheck(s: ManualSession, key: string | null): boolean {
    return s.phase === "steps" && !!key && key !== s.openKey && key !== s.checkedKey;
}

/** What the board answered on Connect, as far as the check needs it (BoardSummary fits). */
export interface ManualBoardRead {
    updater: boolean;
    /** The board didn't answer: what it runs is unknown. */
    unread?: boolean;
    legacyLabel: string | null;
    usbHand: Hand;
    tag: string;
    fwVersion: number;
    halves: Array<{ hand: Hand; answered: boolean; fwVersion: number; tag: string }>;
    sides?: SideAssessment | null;
}

/**
 * Read each half's firmware against the release. The half with USB on firmware without a
 * protocol-4 updater can't be asked about the other half, so that one is unknown.
 */
export function checkManual(s: Pick<ManualSession, "releaseFw" | "fromTag" | "fromFw">, board: ManualBoardRead | null): ManualCheck {
    const halves: Partial<Record<Hand, ManualHalfState>> = {};
    const name = (fw: number, tag: string) => (s.fromFw !== null && fw === s.fromFw && s.fromTag ? s.fromTag : tag && !tag.startsWith("build ") && !tag.startsWith("fw version") ? tag : undefined);
    if (!board || board.unread) return { halves: { 0: { state: "unknown" }, 1: { state: "unknown" } } };
    // One-image firmware that needs its sides set: ask that first (a half without a side
    // answers as neither half, so its version waits until it has one).
    if (board.updater && board.sides && sidesNeedAnswer(board.sides)) {
        for (const h of board.halves) if (h.answered && (s.releaseFw === null || h.fwVersion === s.releaseFw)) halves[h.hand] = { state: "new" };
        return { halves, sides: board.sides };
    }
    if (!board.updater) {
        halves[board.usbHand] = { state: "old", tag: name(board.fwVersion, board.legacyLabel ?? board.tag) };
        halves[(board.usbHand === 0 ? 1 : 0) as Hand] = { state: "unknown" };
        return { halves };
    }
    for (const h of board.halves) {
        if (!h.answered) halves[h.hand] = { state: "silent" };
        else if (s.releaseFw === null || h.fwVersion === s.releaseFw) halves[h.hand] = { state: "new" };
        else halves[h.hand] = { state: "old", tag: name(h.fwVersion, h.tag) };
    }
    return { halves };
}

/** Closing now keeps the install, out of sight: it's still waiting for the keyboard to come back with a layout to restore. */
export function manualKeepsOnClose(s: ManualSession): boolean {
    return s.phase === "steps" && !s.dismissed && s.backup !== null;
}

/**
 * For an install closed before the keyboard came back: whether this connection shows it
 * happened. New firmware reset the settings, or a half runs other firmware than the board
 * ran when the install opened (or the release, when that's what Keybard knows).
 */
export function manualInstalledSince(s: Pick<ManualSession, "fromFw" | "fromTag" | "releaseFw">, board: ManualBoardRead | null, buildReset: boolean): boolean {
    if (buildReset) return true;
    if (!board || board.unread) return false;
    if (!board.updater) return s.fromFw !== null ? board.fwVersion !== s.fromFw : !!s.fromTag && (board.legacyLabel ?? board.tag) !== s.fromTag;
    return board.halves.some((h) => h.answered && (s.fromFw !== null ? h.fwVersion !== s.fromFw : s.releaseFw !== null && h.fwVersion === s.releaseFw));
}

/** The halves of the install that don't run the release yet, in the install's order. */
export function manualPending(s: Pick<ManualSession, "only" | "usualHand">, check: ManualCheck): Hand[] {
    return manualHalves(s.only, s.usualHand).filter((h) => check.halves[h]?.state !== "new");
}

/**
 * The layout choice, once the keyboard is back on the new firmware: Keep my layout puts
 * the backup back through the import path; the default layout keeps what the firmware
 * started with. Then the reset notice is cleared (0x2A), last, as the in-app update does.
 */
export async function runManualAfterwards(host: Pick<FlowHost, "restoreLayout" | "readStorageFlags" | "clearStorageReset">, s: ManualSession, o: { reportedReset?: () => boolean } = {}): Promise<{ layout: "restored" | "defaults" | "kept"; trimmed: string[] }> {
    let trimmed: string[] = [];
    const restore = s.afterwards === "restore" && s.backup?.state === "ok";
    if (restore) trimmed = (await host.restoreLayout((s.backup as Extract<ManualBackup, { state: "ok" }>).svil)).trimmed;
    // Firmware without the reset notice (or GET_INFO) has nothing to clear.
    // Cleared when the board reports the notice now, or reported it on this connection (a read
    // that fails or comes too early must not leave it for the generic reset dialog).
    const flags = await host.readStorageFlags().catch(() => null);
    const reset = ((flags ?? 0) & 0x04) !== 0 || !!o.reportedReset?.();
    if (reset) await host.clearStorageReset().catch((e) => console.warn("[firmware] couldn't clear the reset notice", e));
    // The same build installed again resets nothing: say the layout is as it was, not "the default layout".
    const kept = !restore && flags !== null && !reset;
    return { layout: restore ? "restored" : kept ? "kept" : "defaults", trimmed };
}
