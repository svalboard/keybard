// D2: the Firmware card. What each half runs, the newest release with a link to its notes
// and one button, and the rest (older versions, a firmware file, one half) under
// "Other versions and files". Every button opens a dialog; nothing installs from here.
// One-image firmware: a half without a side, or two on one side, shows the side question
// in place of the update (neither half types until it's answered).
// Check again, beside the halves, reads the board again. A board that didn't answer reads
// as "Keybard couldn't read the firmware", never as one to install by hand.

import { ChevronRight, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { FirmwareReleasePin } from "@/constants/firmware-releases";
import { PARANOID } from "@/lib/paranoid";
import { SvupError, type SvupFile } from "@/services/updater/svup";
import { loadFirmwareFile } from "@/services/updater/uf2";
import type { Hand } from "@/services/updater/protocol";
import type { BoardSummary } from "./board-summary";
import type { SideFixControl } from "./FirmwareUpdateProvider";
import { SideFix, sideProblem } from "./SideFix";

export type FirmwarePick = { kind: "release"; release: FirmwareReleasePin } | { kind: "files"; files: SvupFile[] };

export interface FirmwareSectionProps {
    /** Null: no keyboard connected (D2e). */
    board: BoardSummary | null;
    releases: FirmwareReleasePin[];
    onInstall: (pick: FirmwarePick, onlyHand?: Hand) => void;
    onManual: (release: FirmwareReleasePin | null) => void;
    onConnect?: () => void;
    paranoid?: boolean;
    /** Its own "Firmware" title; off inside Settings, whose section is titled already. */
    heading?: boolean;
    /** One-image firmware: set which half is which. */
    sides?: SideFixControl;
    /** Read the board again (Check again). */
    onRecheck?: () => void;
    /** A read from onRecheck is running. */
    checking?: boolean;
}

/** A chosen file's bytes (FileReader where Blob.arrayBuffer is missing). */
function readBytes(file: File): Promise<Uint8Array> {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer().then((b) => new Uint8Array(b));
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(file);
    });
}

const HALF = (h: Hand) => (h === 0 ? "Left half" : "Right half");
const link = "font-medium text-kb-primary underline-offset-2 hover:underline";
const linkButton = `${link} cursor-pointer text-left`;

/** Check again: low-key, beside the halves; spins while the read runs. */
function RecheckButton({ onRecheck, checking }: { onRecheck: () => void; checking: boolean }) {
    return (
        <button
            type="button"
            className="flex shrink-0 cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-kb-ink disabled:cursor-default disabled:hover:text-muted-foreground"
            title="Read the keyboard's firmware again"
            disabled={checking}
            onClick={onRecheck}
            data-testid="firmware-recheck"
        >
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
            {checking ? "Checking…" : "Check again"}
        </button>
    );
}

function NotesLink({ release, label }: { release: FirmwareReleasePin; label: string }) {
    if (!release.notesUrl || PARANOID) return null;
    return <a className={link} href={release.notesUrl} target="_blank" rel="noreferrer">{label} ↗</a>;
}

export function FirmwareSection({ board, releases, onInstall, onManual, onConnect, paranoid = PARANOID, heading = true, sides, onRecheck, checking = false }: FirmwareSectionProps) {
    const offered = paranoid ? [] : releases;
    const newest = offered[0] ?? null;
    const [more, setMore] = useState(false);
    const [oneHalf, setOneHalf] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const [pendingHand, setPendingHand] = useState<Hand | undefined>(undefined);
    const fileInput = useRef<HTMLInputElement>(null);

    const updater = !!board?.updater;
    const installed = updater ? offered.find((r) => r.tag === board!.tag && r.fwVersion === board!.fwVersion) ?? null : null;
    const unread = !!board?.unread;
    const behind = !!(board && !unread && newest && (!updater || board.halves.some((h) => !h.answered || h.fwVersion < newest.fwVersion)));
    const boardNewer = !!(updater && newest && board!.fwVersion > newest.fwVersion);

    const chooseFiles = (onlyHand?: Hand) => {
        setPendingHand(onlyHand);
        setFileError(null);
        fileInput.current?.click();
    };
    const onFiles = async (list: FileList | null) => {
        if (!list?.length) return;
        try {
            // One file installs both halves (a pair UF2, x4 on).
            const file = await loadFirmwareFile(await readBytes(list[0]));
            setFileError(null);
            onInstall({ kind: "files", files: [file] }, pendingHand);
        } catch (error) {
            setFileError(error instanceof SvupError ? error.message : "Keybard couldn't read that file.");
        } finally {
            if (fileInput.current) fileInput.current.value = "";
        }
    };
    const install = (r: FirmwareReleasePin, onlyHand?: Hand) => {
        if (!updater) return onManual(r);
        if (onlyHand === undefined) onInstall({ kind: "release", release: r });
        else onInstall({ kind: "release", release: r }, onlyHand);
    };

    // What the card offers first: connect, finish, the newest release, or a file.
    let lead: React.ReactNode = null;
    const sideTrouble = board?.sides ? sideProblem(board.sides) : null;
    if (board?.sides && sideTrouble) {
        lead = (
            <div className="flex flex-col gap-2" data-testid="firmware-sides">
                <p className="text-sm font-semibold text-kb-warn-ink">Set which half is which</p>
                <SideFix bare sides={board.sides} busy={sides?.busy} note={sides?.note} onApply={(w) => sides?.apply(w)} />
            </div>
        );
    } else if (!board) {
        lead = (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">Connect a keyboard to see its firmware.</p>
                {onConnect && <Button variant="kb-primary" onClick={onConnect}>Connect</Button>}
            </div>
        );
    } else if (unread) {
        // The board didn't answer: say so, never "install by hand" on a guess.
        lead = (
            <div className="flex flex-wrap items-center justify-between gap-3" data-testid="firmware-unread">
                <div className="flex flex-col">
                    <p className="text-sm font-semibold">Keybard couldn't read the firmware.</p>
                    <p className="text-sm text-muted-foreground">The keyboard didn't answer. If this keeps happening, unplug it and plug it back in.</p>
                </div>
                {onRecheck && <Button variant="outline" disabled={checking} onClick={onRecheck} data-testid="firmware-unread-recheck">{checking ? "Checking…" : "Check again"}</Button>}
            </div>
        );
    } else if (updater && board.differ) {
        const target = offered.find((r) => r.tag === board.tag) ?? newest;
        lead = (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-semibold text-kb-warn-ink">The halves run different firmware.</p>
                <Button variant="kb-primary" onClick={() => (target ? install(target) : chooseFiles())}>Finish update</Button>
            </div>
        );
    } else if (behind && newest) {
        lead = (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col">
                    <span className="text-sm font-semibold">{newest.tag} is available</span>
                    <span className="text-sm"><NotesLink release={newest} label={`What's new in ${newest.tag}`} /></span>
                </div>
                <Button variant="kb-primary" onClick={() => install(newest)}>Update to {newest.tag}</Button>
            </div>
        );
    } else if (!updater) {
        lead = (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">Keybard installs firmware on this keyboard after one install by hand.</p>
                <Button variant="kb-primary" onClick={() => onManual(null)}>Install by hand</Button>
            </div>
        );
    } else if (boardNewer) {
        lead = (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">Your keyboard runs newer firmware than this Keybard knows.</p>
                {!paranoid && <Button variant="outline" onClick={() => window.location.reload()}>Reload Keybard</Button>}
            </div>
        );
    } else if (newest) {
        lead = (
            <p className="text-sm">
                Your keyboard has the newest firmware. {installed && <NotesLink release={installed} label={`What's new in ${installed.tag}`} />}
            </p>
        );
    } else if (paranoid) {
        lead = (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">Install firmware from a file.</p>
                <Button variant="kb-primary" onClick={() => chooseFiles()}>Install a firmware file…</Button>
            </div>
        );
    }

    const others = offered.filter((r) => !(behind && r === newest));
    const oneHalfRelease = installed ?? newest;

    return (
        <section aria-labelledby={heading ? "fw-title" : undefined} aria-label={heading ? undefined : "Firmware"} className="flex flex-col gap-4" data-testid="firmware-section">
            {heading && <h2 id="fw-title" className="text-lg font-semibold text-kb-ink">Firmware</h2>}

            {/* A half without a side answers as neither half: the side question names the halves instead. */}
            {board && !unread && !(updater && board.halves.length === 0) && (
                // Check again beside the halves; below them when the row is too narrow for both.
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm tabular-nums" aria-label="This keyboard" data-testid="firmware-halves">
                        {updater ? board.halves.map((h) => {
                            const stale = board.differ && h.fwVersion !== Math.max(...board.halves.map((x) => x.fwVersion));
                            return [
                                <dt key={`t${h.hand}`}>{HALF(h.hand)}</dt>,
                                <dd key={`d${h.hand}`} data-half={h.hand} className={stale || !h.answered ? "text-kb-warn-ink" : ""}>
                                    {h.answered ? <span className="font-mono">{h.tag}</span> : "didn't answer"}
                                    {h.usb && <span className="text-muted-foreground"> · plugged in</span>}
                                </dd>,
                            ];
                        }) : [
                            <dt key="t">{HALF(board.usbHand)}</dt>,
                            <dd key="d" data-half={board.usbHand}>
                                <span className="font-mono">{board.legacyLabel ?? "older firmware"}</span>
                                <span className="text-muted-foreground"> · plugged in</span>
                            </dd>,
                        ]}
                    </dl>
                    {onRecheck && <RecheckButton onRecheck={onRecheck} checking={checking} />}
                </div>
            )}

            {lead}

            {updater && (
                <div>
                    <button type="button" className="flex items-center gap-1 text-sm text-muted-foreground" aria-expanded={more} onClick={() => setMore((m) => !m)}>
                        <ChevronRight className={`h-4 w-4 transition-transform motion-reduce:transition-none ${more ? "rotate-90" : ""}`} aria-hidden />
                        Other versions and files
                    </button>
                    {more && (
                        <ul className="mt-2 flex flex-col gap-2 pl-5 text-sm" data-testid="firmware-more">
                            {others.map((r) => (
                                <li key={r.tag} className="flex flex-wrap items-baseline gap-x-2">
                                    <button type="button" className={linkButton} onClick={() => install(r)}>{r === installed ? `Reinstall ${r.tag}` : `Install ${r.tag}`}</button>
                                    {r === installed && <span className="text-muted-foreground">· installed</span>}
                                    {r.notesUrl && !paranoid && <span className="text-muted-foreground">· <NotesLink release={r} label="What's new" /></span>}
                                </li>
                            ))}
                            <li><button type="button" className={linkButton} onClick={() => chooseFiles()}>Install a firmware file…</button></li>
                            <li className="flex flex-col gap-1.5">
                                <button type="button" className={linkButton} aria-expanded={oneHalf} onClick={() => setOneHalf((o) => !o)}>Update one half only…</button>
                                {oneHalf && (
                                    <div className="flex flex-wrap gap-2">
                                        {([0, 1] as Hand[]).map((h) => (
                                            <Button key={h} size="sm" variant="outline" onClick={() => (oneHalfRelease ? install(oneHalfRelease, h) : chooseFiles(h))}>
                                                {HALF(h)}
                                            </Button>
                                        ))}
                                    </div>
                                )}
                            </li>
                        </ul>
                    )}
                </div>
            )}
            <input ref={fileInput} type="file" accept=".uf2" hidden data-testid="firmware-file-input" onChange={(e) => void onFiles(e.target.files)} />
            {fileError && <p role="alert" className="text-sm text-kb-red" data-testid="firmware-file-error">{fileError}</p>}
            {board?.sides && !sideTrouble && sides?.note && <p role="alert" className="text-sm text-kb-red">{sides.note}</p>}
        </section>
    );
}
