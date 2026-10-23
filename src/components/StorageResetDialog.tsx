import { useEffect, useMemo, useState, type FC } from "react";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { serializeForBackup, useBackups } from "@/contexts/BackupContext";
import { useChanges } from "@/contexts/ChangesContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { restoreLayoutToBoard } from "@/features/firmware/restore";
import { fingerprintSvil } from "@/services/backup/codec";
import { getBackupService, type SnapshotMeta } from "@/services/backup/backup.service";
import { backupLine } from "@/services/backup/describe";
import { keyboardService } from "@/services/keyboard.service";
import { describeFirmware } from "@/constants/firmware";
import { useFirmwareUpdates } from "@/features/firmware/FirmwareUpdateProvider";
import type { BoardSummary } from "@/features/firmware/board-summary";
import { FLOW_STATE_EVENT, resetNoticeClearedOn, updateOwnsResetNotice } from "@/services/updater/flow";
import { handName, otherHand } from "@/services/updater/protocol";
import type { KeyboardInfo } from "@/types/keyboard.types";

/** Ask the app to show Backups (FirmwareUpdateProvider listens). */
export { OPEN_BACKUPS_EVENT } from "@/features/firmware/useHalvesDiffer";
import { OPEN_BACKUPS_EVENT } from "@/features/firmware/useHalvesDiffer";


/** How long a backup taken before an update counts as the one for the install that just reset the board. */
export const INSTALL_BACKUP_MS = 24 * 60 * 60 * 1000;

/**
 * The backup "Restore my layout" puts back: the newest of this board's, leaving out the
 * snapshot of what the board holds now (the defaults). After new firmware reset the board,
 * a backup taken before an update in the last day wins over anything older: the board can
 * come back under another key (the USB cable moved to the other half, which has its own
 * serial, or the serial couldn't be read on that connection), and then this board's newest
 * would be an old one. Its own fresh pre-update backup always comes first.
 * Undefined while the current layout's fingerprint is still being worked out.
 */
export function pickResetBackup(snapshots: SnapshotMeta[], boardKey: string, currentFingerprint: string | null | undefined, o: { firmware: boolean; now: number }): SnapshotMeta | null | undefined {
    if (currentFingerprint === undefined) return undefined;
    const usable = snapshots.filter((s) => s.fingerprint !== currentFingerprint).sort((a, b) => b.savedAt - a.savedAt);
    const own = usable.find((s) => s.boardKey === boardKey) ?? null;
    if (!o.firmware) return own;
    const recentPre = (s: SnapshotMeta) => s.kind === "pre-update" && o.now - s.savedAt < INSTALL_BACKUP_MS;
    if (usable.some((s) => s.boardKey === boardKey && recentPre(s))) return own;
    const install = usable.find(recentPre) ?? null;
    return install && (!own || install.savedAt > own.savedAt) ? install : own;
}

/**
 * The firmware the board runs now, for the reset notice's Firmware line: "x4 on both halves",
 * each half's when they differ, or what the half with USB says when that's all Keybard can read.
 */
export function firmwareLine(board: BoardSummary | null | undefined, fallback: string | null): string | null {
    if (board?.updater && board.halves.length) {
        const answered = board.halves.filter((h) => h.answered);
        const usb = board.halves.find((h) => h.usb) ?? answered[0];
        if (answered.length === 2) {
            if (answered[0].fwVersion === answered[1].fwVersion) return `${usb?.tag || board.tag} on both halves`;
            const [left, right] = [0, 1].map((h) => answered.find((x) => x.hand === h)!);
            return `${left.tag} on the left half, ${right.tag} on the right half`;
        }
        if (answered.length === 1) {
            const h = answered[0];
            return `${h.tag} on the ${handName(h.hand)} half (the ${handName(otherHand(h.hand))} half didn't answer)`;
        }
    }
    return board?.tag || board?.legacyLabel || fallback || null;
}

/** The reset notice's width: its three answers fit one row on a desktop. */
export const RESET_DIALOG_CLASS = "sm:max-w-[580px]";

export interface ResetNoticeViewProps {
    /** A new firmware build reset the layout (bit 2), rather than unreadable storage (bit 0). */
    firmware: boolean;
    /** The firmware the halves run now, e.g. "x4 on both halves"; null when Keybard can't tell. */
    firmwareNow?: string | null;
    /** The backup to put back, e.g. "Backup saved before the update, today 7:25 AM"; null when there's none. */
    backupLine: string | null;
    busy?: boolean;
    error?: string | null;
    onDefaults: () => void;
    onOtherBackups: () => void;
    onPutBack: () => void;
}

/**
 * A4 and the bit-0 notice: the title, then two labeled parts, Firmware (what the halves run
 * now) and Layout (the backup to put back), then Restore my layout. Layout and firmware are
 * never mixed: the layout line names a backup by when and why it was saved.
 * Restore my layout leads; Start from the default layout is the other answer; Other backups
 * is a link. One row on a desktop, stacked full width on a phone: never wrapped.
 */
export function ResetNoticeView({ firmware, firmwareNow, backupLine, busy, error, onDefaults, onOtherBackups, onPutBack }: ResetNoticeViewProps) {
    const description = firmware
        ? "The new firmware started your keyboard with the default layout."
        : "Your keyboard couldn't read its saved layout, so it started with the default layout.";
    const layout = backupLine ?? (firmware ? "No backup of this keyboard in this browser." : "Load your layout file to restore it.");
    return (
        <div className="flex flex-col gap-4" data-testid="reset-notice">
            <DialogHeader>
                <DialogTitle>Your layout was reset</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-kb-gray-border px-3 py-2.5 text-sm">
                {firmware && firmwareNow && (
                    <>
                        <dt className="font-medium text-muted-foreground">Firmware</dt>
                        <dd className="text-kb-ink" data-testid="reset-firmware">{firmwareNow}</dd>
                    </>
                )}
                <dt className="font-medium text-muted-foreground">Layout</dt>
                <dd className="text-kb-ink" data-testid="reset-backup">{layout}</dd>
            </dl>
            {error && <p role="alert" className="text-sm text-kb-red">{error}</p>}
            {backupLine ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="reset-actions">
                    <Button variant="kb-primary" className="w-full sm:order-3 sm:w-auto" disabled={busy} onClick={onPutBack} data-primary>{busy ? "Restoring…" : "Restore my layout"}</Button>
                    <Button variant="outline" className="w-full sm:order-2 sm:w-auto" disabled={busy} onClick={onDefaults}>Start from the default layout</Button>
                    <button type="button" className="whitespace-nowrap rounded-md px-1 py-2 text-sm font-medium text-kb-primary underline-offset-4 hover:underline disabled:opacity-50 sm:order-1 sm:mr-auto" disabled={busy} onClick={onOtherBackups}>Other backups</button>
                </div>
            ) : (
                <DialogFooter>
                    <Button onClick={onDefaults}>OK</Button>
                </DialogFooter>
            )}
        </div>
    );
}

/**
 * Shown once per connection when the board reports a storage problem:
 * - it can't save changes right now, so they'll be lost when it restarts;
 * - new firmware reset its layout (bit 2) with no update of this tab on screen (A4): a
 *   .uf2 installed by hand, or a tab closed mid-update. The one place a restore is asked
 *   afterwards. An update's own reset never asks: the update acts on it and clears it;
 * - it reset its layout because its storage could not be read (bit 0).
 * Both resets offer "Restore my layout" from the newest backup of this board.
 * Acknowledging a reset clears the board's flag (0x2A), after the restore when there is one.
 */
/** The update's hold on the reset notice, kept current as the update starts, ends and is closed. */
function readUpdateNotice(session: unknown) {
    return { owned: updateOwnsResetNotice(), cleared: resetNoticeClearedOn(session) };
}

function useUpdateNotice(session: unknown): { owned: boolean; cleared: boolean } {
    const [notice, setNotice] = useState(() => readUpdateNotice(session));
    useEffect(() => {
        const sync = () => setNotice((prev) => {
            const next = readUpdateNotice(session);
            return prev.owned === next.owned && prev.cleared === next.cleared ? prev : next;
        });
        sync();
        window.addEventListener(FLOW_STATE_EVENT, sync);
        return () => window.removeEventListener(FLOW_STATE_EVENT, sync);
    }, [session]);
    return notice;
}

export const StorageResetDialog: FC = () => {
    const { keyboard, isConnected, connectionSessionId } = useKeyboard();
    const [acknowledgedReset, setAcknowledgedReset] = useState<string | null>(null);
    const [acknowledgedWriteFailure, setAcknowledgedWriteFailure] = useState<string | null>(null);
    const update = useUpdateNotice(connectionSessionId);
    const kbid = keyboard?.kbid ?? "";
    // An update in this tab acts on a new build's reset itself, and clears it (0x2A) last.
    const buildReset = !!keyboard?.storage_build_reset && !update.owned && !update.cleared;
    const showWriteFailure = Boolean(isConnected && keyboard?.storage_write_failed && acknowledgedWriteFailure !== kbid);
    const showReset = Boolean(isConnected && ((keyboard?.storage_reset && !update.cleared) || buildReset) && acknowledgedReset !== kbid && !showWriteFailure);

    // The board clears this itself when it restarts, so there's nothing to send.
    const acknowledgeWriteFailure = () => setAcknowledgedWriteFailure(kbid);

    if (showWriteFailure) {
        return (
            <Dialog open onOpenChange={(next) => !next && acknowledgeWriteFailure()}>
                <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                        <DialogTitle>Your keyboard can't save changes</DialogTitle>
                        <DialogDescription>
                            Your keyboard couldn't save its layout since it was plugged in. Changes you make will
                            show up, but they'll be lost when it restarts. Unplug it and plug it back in, then make
                            your changes again.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button onClick={acknowledgeWriteFailure}>OK</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }
    if (!showReset || !keyboard) return null;
    return <ResetDialog keyboard={keyboard} firmware={buildReset && !keyboard.storage_reset} onAcknowledged={() => setAcknowledgedReset(kbid)} />;
};

/** The reset notice, with the newest backup of this board to put back. */
function ResetDialog({ keyboard, firmware, onAcknowledged }: { keyboard: KeyboardInfo; firmware: boolean; onAcknowledged: () => void }) {
    const { setKeyboard, markAsSaved } = useKeyboard();
    const { queue, commit } = useChanges();
    const { snapshots, board } = useBackups();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const updates = useFirmwareUpdates();
    // undefined until known; null when it can't be worked out.
    const [currentFingerprint, setCurrentFingerprint] = useState<string | null | undefined>(undefined);

    // The "connected" snapshot taken just now holds the defaults: leave it out. Wait for it,
    // so the defaults are never offered as the layout for a moment.
    useEffect(() => {
        let cancelled = false;
        void fingerprintSvil(serializeForBackup(keyboard)).then(
            (f) => { if (!cancelled) setCurrentFingerprint(f); },
            () => { if (!cancelled) setCurrentFingerprint(null); },
        );
        return () => { cancelled = true; };
    }, [keyboard]);
    const newest = useMemo(
        () => (board ? pickResetBackup(snapshots, board.key, currentFingerprint, { firmware, now: Date.now() }) ?? null : null),
        [snapshots, board, currentFingerprint, firmware],
    );
    const firmwareNow = firmware ? firmwareLine(updates?.board, describeFirmware(keyboard)) : null;
    // Ask once the backups can be told apart: an OK pressed before then would skip the restore.
    const [waited, setWaited] = useState(false);
    useEffect(() => {
        const t = window.setTimeout(() => setWaited(true), 2000);
        return () => window.clearTimeout(t);
    }, []);
    const ready = currentFingerprint !== undefined && (!!board || waited);

    const acknowledgeReset = async () => {
        onAcknowledged();
        try {
            await keyboardService.clearStorageReset();
        } catch (error) {
            // The board keeps reporting the reset, so the next connection asks again.
            console.warn("Could not clear the storage reset notice", error);
        }
    };

    const putBack = async () => {
        if (!newest) return;
        setBusy(true);
        setError(null);
        try {
            const service = getBackupService();
            if (!service) throw new Error("Backups are unavailable in this browser.");
            const svil = await service.getSvil(newest.id);
            await restoreLayoutToBoard(svil, { keyboard, setKeyboard, queue, commit, markSaved: markAsSaved });
            await acknowledgeReset();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const otherBackups = () => {
        onAcknowledged();
        window.dispatchEvent(new CustomEvent(OPEN_BACKUPS_EVENT));
    };

    if (!ready) return null;
    return (
        <Dialog open onOpenChange={(next) => !next && !busy && acknowledgeReset()}>
            <DialogContent className={RESET_DIALOG_CLASS}>
                <ResetNoticeView firmware={firmware} firmwareNow={firmwareNow} backupLine={newest ? backupLine(newest, { ofBoard: !!board && newest.boardKey !== board.key, justUpdated: firmware }) : null} busy={busy} error={error} onDefaults={acknowledgeReset} onOtherBackups={otherBackups} onPutBack={putBack} />
            </DialogContent>
        </Dialog>
    );
}
