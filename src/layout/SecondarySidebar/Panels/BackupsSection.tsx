import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, Pin, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBackups } from "@/contexts/BackupContext";
import { dayKey } from "@/services/backup/retention";
import type { SnapshotMeta } from "@/services/backup/backup.service";
import { PINNED_SNAPSHOT_KINDS } from "@/services/backup/store";
import { backupFirmwareNote, backupReason } from "@/services/backup/describe";
import { fileService } from "@/services/file.service";
import { cn } from "@/lib/utils";

const VISIBLE_PER_BOARD = 8;

const isPinned = (snap: SnapshotMeta) => PINNED_SNAPSHOT_KINDS.includes(snap.kind);

/**
 * Why a backup was saved: "Saved before a firmware update", "Saved by hand"... Never named
 * by a firmware version; that's the muted detail (backupFirmwareNote). Pinned ones (before a
 * firmware update, by hand) are kept until deleted.
 */
export function snapshotKindLabel(snap: SnapshotMeta): string {
    const why = backupReason(snap);
    return `Saved ${why}`;
}

function formatTime(time: number, now = Date.now()): string {
    const d = new Date(time);
    const clock = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (dayKey(time) === dayKey(now)) return `Today ${clock}`;
    if (dayKey(time) === dayKey(now - 86_400_000)) return `Yesterday ${clock}`;
    return `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} ${clock}`;
}

const fileNameFor = (snap: SnapshotMeta) => {
    const d = new Date(snap.savedAt);
    const stamp = `${dayKey(snap.savedAt)} ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    return `${snap.boardName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")} ${stamp}.svil`;
};

interface BackupsSectionProps {
    /** Opens the import review for a file, the same path as Import. */
    onRestore?: (file: File) => Promise<void> | void;
    /** Open the list while true (a search matched it); it collapses again after. */
    forceOpen?: boolean;
    /** Marks search matches in the header label. */
    highlight?: (text: string) => ReactNode;
}

/** The collapsed header's summary: how many backups, and the newest. */
export function backupsSummary(snapshots: SnapshotMeta[], now = Date.now()): string {
    if (snapshots.length === 0) return "No backups yet";
    const newest = Math.max(...snapshots.map((s) => s.savedAt));
    return `${snapshots.length} backup${snapshots.length === 1 ? "" : "s"}, latest ${formatTime(newest, now)}`;
}

export default function BackupsSection({ onRestore, forceOpen = false, highlight = (t) => t }: BackupsSectionProps) {
    const { available, snapshots, folder, folderSupported, board, getSvil, deleteSnapshot, chooseFolder, resumeFolder, stopFolder, backUpNow } = useBackups();
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    // The list starts collapsed every time Settings opens.
    const [open, setOpen] = useState(forceOpen);
    useEffect(() => setOpen(forceOpen), [forceOpen]);

    const groups = useMemo(() => {
        const byBoard = new Map<string, SnapshotMeta[]>();
        for (const snap of snapshots) {
            const list = byBoard.get(snap.boardKey) ?? [];
            list.push(snap);
            byBoard.set(snap.boardKey, list);
        }
        // Pinned snapshots at the top of each board, newest first; then the rest, newest first.
        const order = (a: SnapshotMeta, b: SnapshotMeta) => Number(isPinned(b)) - Number(isPinned(a)) || b.savedAt - a.savedAt;
        const list = [...byBoard.entries()].map(([key, items]) => ({ key, items: items.sort(order) }));
        const newest = (items: SnapshotMeta[]) => Math.max(...items.map((s) => s.savedAt));
        return list.sort((a, b) => (a.key === board?.key ? -1 : b.key === board?.key ? 1 : newest(b.items) - newest(a.items)));
    }, [snapshots, board?.key]);

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const restore = (snap: SnapshotMeta) => run(async () => {
        const svil = await getSvil(snap.id);
        await onRestore?.(new File([svil], fileNameFor(snap), { type: "application/json" }));
    });
    const download = (snap: SnapshotMeta) => run(async () => fileService.downloadSvilText(await getSvil(snap.id), fileNameFor(snap)));
    const remove = (snap: SnapshotMeta) => run(async () => {
        if (window.confirm(`Delete backup from ${formatTime(snap.savedAt)}?`)) await deleteSnapshot(snap.id);
    });

    if (!available) {
        return <div className="p-3 panel-layer-item text-sm text-muted-foreground" data-testid="backups">Backups unavailable in this browser.</div>;
    }

    const now = () => run(async () => {
        await backUpNow();
        setSavedAt(Date.now());
    });

    const summary = backupsSummary(snapshots);
    return (
        <div className="flex flex-col gap-2" data-testid="backups">
            <div className="flex flex-row items-center gap-2 px-3 py-2.5 panel-layer-item">
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls="settings-backups-list"
                    aria-label={`Backups, ${summary}`}
                    onClick={() => setOpen((o) => !o)}
                    className="flex min-w-0 flex-1 flex-row items-center gap-2 text-left"
                >
                    <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm text-kb-ink">{highlight("Backups")}</span>
                        {savedAt !== null
                            ? <span role="status" className="truncate text-xs text-muted-foreground">Saved {formatTime(savedAt)}</span>
                            : <span className="truncate text-xs text-muted-foreground">{summary}</span>}
                    </span>
                </button>
                {board && (
                    <Button size="sm" className="shrink-0" onClick={now}>Back up now</Button>
                )}
            </div>
            {open && (
            <div id="settings-backups-list" className="flex flex-col gap-2">
            <div className="flex flex-col p-3 gap-2 panel-layer-item">
                <span className="text-md text-left">Backup folder</span>
                {folder.state === "none" || folder.state === "lost" ? (
                    <div className="flex flex-row flex-wrap items-center gap-2">
                        <Button size="sm" disabled={!folderSupported} onClick={() => run(chooseFolder)}>Choose backup folder</Button>
                        {folder.state === "lost" && <span role="status" className="text-xs text-muted-foreground">Folder not found</span>}
                    </div>
                ) : (
                    <div className="flex flex-row flex-wrap items-center gap-2">
                        <span className="text-sm font-mono truncate max-w-full" title={folder.name ?? undefined}>{folder.name}</span>
                        {folder.state === "paused" && <Button size="sm" onClick={() => run(resumeFolder)}>Resume backups</Button>}
                        <Button size="sm" variant="outline" onClick={() => run(chooseFolder)}>Change folder</Button>
                        <Button size="sm" variant="outline" onClick={() => run(stopFolder)}>Stop using folder</Button>
                    </div>
                )}
                {folder.state === "paused" && <span role="status" className="text-xs text-muted-foreground">Paused</span>}
                {folder.error && <span role="alert" className="text-xs text-destructive">{folder.error}</span>}
            </div>

            {error && <p role="alert" className="px-3 text-xs text-destructive">{error}</p>}


            {groups.map(({ key, items }) => {
                // Pinned rows always show; the limit is for the rest.
                const pinned = items.filter(isPinned);
                const rest = items.filter((s) => !isPinned(s));
                const shown = [...pinned, ...(expanded[key] ? rest : rest.slice(0, VISIBLE_PER_BOARD))];
                return (
                    <section key={key} className="flex flex-col p-3 gap-1 panel-layer-item" aria-label={`Backups of ${items[0].boardName}`}>
                        <div className="flex flex-row flex-wrap items-baseline justify-between gap-2">
                            <span className="text-md text-left">
                                {items[0].boardName}
                                {key === board?.key && <span className="ml-2 text-xs text-muted-foreground">Connected</span>}
                            </span>
                            <span className="text-xs font-mono text-muted-foreground">{key}</span>
                        </div>
                        <ul className="flex flex-col">
                            {shown.map((snap) => (
                                <li key={snap.id} className="flex flex-row flex-wrap items-center gap-x-2 gap-y-1 py-1 border-t border-border first:border-t-0" data-testid="backup-row" data-pinned={isPinned(snap) || undefined}>
                                    <div className="flex flex-col flex-1 min-w-36">
                                        <span className="text-sm">
                                            {formatTime(snap.savedAt)}
                                            <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                                                {isPinned(snap) && <Pin className="h-3 w-3" aria-label="Kept until you delete it" />}
                                                {snapshotKindLabel(snap)}
                                            </span>
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {snap.summary || (snap.kind === "connected" ? "As loaded" : "")}
                                            {backupFirmwareNote(snap) && <span className="ml-2">{(snap.summary || snap.kind === "connected") ? "· " : ""}{backupFirmwareNote(snap)}</span>}
                                            {snap.includesPending && (
                                                <span className="ml-2 font-medium text-kb-orange" title={`${snap.pendingCount} change${snap.pendingCount === 1 ? "" : "s"} not yet applied to the board`}>
                                                    Unsent ({snap.pendingCount})
                                                </span>
                                            )}
                                        </span>
                                    </div>
                                    <div className="flex flex-row gap-1">
                                        <Button size="sm" variant="outline" onClick={() => restore(snap)} disabled={!onRestore} aria-label={`Restore backup from ${formatTime(snap.savedAt)}`}>
                                            <RotateCcw /> Restore
                                        </Button>
                                        <Button size="icon" variant="ghost" className="size-8" onClick={() => download(snap)} aria-label={`Download backup from ${formatTime(snap.savedAt)}`} title="Download .svil">
                                            <Download />
                                        </Button>
                                        <Button size="icon" variant="ghost" className="size-8" onClick={() => remove(snap)} aria-label={`Delete backup from ${formatTime(snap.savedAt)}`} title="Delete">
                                            <Trash2 />
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                        {rest.length > VISIBLE_PER_BOARD && (
                            <button type="button" className="self-start text-xs underline text-muted-foreground cursor-pointer" onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}>
                                {expanded[key] ? "Show fewer" : `Show all (${rest.length})`}
                            </button>
                        )}
                    </section>
                );
            })}
            </div>
            )}
        </div>
    );
}
