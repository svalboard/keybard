// How a backup is named on screen: by when it was saved and why, never by the firmware it
// was saved from. "Layout" is what's stored on the keyboard (keymap, combos, macros,
// settings); "firmware" is the program on the halves, and appears only as a muted detail.

import type { SnapshotMeta } from "./store";

type Snap = Pick<SnapshotMeta, "kind" | "savedAt" | "fromTag" | "boardName">;

/** Why it was saved: "before a firmware update", "by hand", ... */
export function backupReason(snap: Pick<SnapshotMeta, "kind">): string {
    switch (snap.kind) {
        case "pre-update": return "before a firmware update";
        case "manual": return "by hand";
        case "connected": return "when the keyboard connected";
        default: return "after a change";
    }
}

function dayKey(time: number): string {
    const d = new Date(time);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "today 7:25 AM", "yesterday 7:25 AM", or the date and time. */
export function backupWhen(time: number, now = Date.now()): string {
    const d = new Date(time);
    const clock = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (dayKey(time) === dayKey(now)) return `today ${clock}`;
    if (dayKey(time) === dayKey(now - 86_400_000)) return `yesterday ${clock}`;
    return `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}, ${clock}`;
}

/**
 * One line for the backup a dialog offers: "Backup saved before the update, today 7:25 AM".
 * The board's name only when it's needed to tell boards apart (`ofBoard`).
 */
export function backupLine(snap: Snap, o: { now?: number; ofBoard?: boolean; justUpdated?: boolean } = {}): string {
    const why = snap.kind === "pre-update" && o.justUpdated ? "before the update" : backupReason(snap);
    const of = o.ofBoard && snap.boardName ? ` of ${snap.boardName}` : "";
    return `Backup${of} saved ${why}, ${backupWhen(snap.savedAt, o.now)}`;
}

/** The muted detail: "saved from x4test10 firmware", when Keybard knows it. */
export function backupFirmwareNote(snap: Pick<SnapshotMeta, "fromTag">): string | null {
    return snap.fromTag ? `saved from ${snap.fromTag} firmware` : null;
}
