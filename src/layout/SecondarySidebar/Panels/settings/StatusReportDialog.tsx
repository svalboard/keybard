import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { keyboardService } from "@/services/keyboard.service";
import { STATUS_REPORT_NAME, hasStatusReport, statusGroups, statusText, type BoardStatus } from "@/services/status-report";
import type { SettingDefinition } from "@/types/settings.types";

export const STATUS_REPORT_ROW: SettingDefinition = {
    name: "status-report",
    label: STATUS_REPORT_NAME,
    description: "Firmware and settings, to share with support",
    type: "action",
    action: "open-status-report",
};
export const STATUS_REPORT_DESCRIPTION = "What your keyboard runs now.";
export const STATUS_REPORT_READING = "Reading your keyboard…";
export const STATUS_REPORT_READ_FAILED = "Couldn't read your keyboard.";
export const STATUS_REPORT_DISCONNECTED = "Your keyboard isn't connected.";
export const STATUS_REPORT_COPY_FAILED = "Couldn't copy. Select the rows and copy them instead.";
/** How long Copy says Copied, as Copy Layer does. */
export const COPIED_MS = 2000;

/** Break points in a build text ("svalboard/either:sval @ x4.6.7-3-gabc"): after a slash or colon, before a dash. */
export function breakable(text: string): React.ReactNode {
    return text.split(/(?<=[/:])|(?=-)/).map((part, i) => (
        <React.Fragment key={i}>{i > 0 && <wbr />}{part}</React.Fragment>
    ));
}

/**
 * The status report: what the Output Status key types (Sval STATUS_REPORT,
 * 0x3F), read from the board and shown as rows, so it reads right on any
 * keyboard layout. Read when the dialog opens, and on Read again after
 * something changes on the board; Copy writes it as plain text.
 */
const StatusReportDialog: React.FC<{ open: boolean; onOpenChange: (open: boolean) => void }> = ({ open, onOpenChange }) => {
    const { keyboard, isConnected } = useKeyboard();
    const supported = isConnected && hasStatusReport(keyboard?.feature_flags5);
    const board = supported ? keyboard?.kbid ?? "" : null;
    const [status, setStatus] = useState<BoardStatus | null>(null);
    const [reading, setReading] = useState(false);
    const [failed, setFailed] = useState(false);
    const [copied, setCopied] = useState<"done" | "failed" | null>(null);
    // Bumped for every read, board and close: a reply for an earlier one is dropped.
    const generation = useRef(0);
    const copiedTimer = useRef<number | undefined>(undefined);
    const contentRef = useRef<HTMLDivElement>(null);
    // The row that opened it: there's no DialogTrigger, so focus goes back here by hand.
    const opener = useRef<HTMLElement | null>(null);

    const read = useCallback(async () => {
        const mine = ++generation.current;
        setReading(true);
        setFailed(false);
        const next = await keyboardService.readStatusReport().catch(() => null);
        if (generation.current !== mine) return;
        setReading(false);
        if (next) setStatus(next);
        setFailed(next === null);
    }, []);

    // Opening reads the board; so does another board while open. Closing drops
    // the report, so the next open never shows an old one.
    useEffect(() => {
        setStatus(null);
        setFailed(false);
        setCopied(null);
        setReading(false);
        if (open && board !== null) read();
        return () => { generation.current++; };
    }, [open, board, read]);

    useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

    const copy = async () => {
        if (!status) return;
        window.clearTimeout(copiedTimer.current);
        try {
            await navigator.clipboard.writeText(statusText(status));
            setCopied("done");
            copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
        } catch {
            setCopied("failed");
        }
    };

    const problem = board === null ? STATUS_REPORT_DISCONNECTED : failed ? STATUS_REPORT_READ_FAILED : null;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                ref={contentRef}
                className="flex flex-col gap-4 overflow-hidden sm:max-w-md"
                data-status-report
                // A report to read: focus the dialog itself, not the first button.
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    contentRef.current?.focus();
                }}
                onCloseAutoFocus={(e) => {
                    if (!opener.current?.isConnected) return;
                    e.preventDefault();
                    opener.current.focus();
                }}
            >
                <DialogHeader className="shrink-0 pr-6">
                    <DialogTitle>{STATUS_REPORT_NAME}</DialogTitle>
                    <DialogDescription>{STATUS_REPORT_DESCRIPTION}</DialogDescription>
                </DialogHeader>
                <div className="-mx-6 min-h-0 flex-1 overflow-y-auto border-y border-kb-gray-border px-6 py-3" data-testid="status-report-body">
                    {!status && !problem && (
                        <p role="status" className="py-6 text-center text-sm text-muted-foreground" data-testid="status-report-reading">{STATUS_REPORT_READING}</p>
                    )}
                    {problem && (
                        <p role="alert" className="flex flex-row flex-wrap items-baseline gap-x-2 pb-2 text-sm text-kb-warn-ink" data-testid="status-report-error">
                            <span>{problem}</span>
                        </p>
                    )}
                    {status && (
                        <div className="flex flex-col gap-4 text-sm" data-testid="status-report-rows">
                            {statusGroups(status).map((group) => (
                                <section key={group.title} aria-label={group.title} className="flex flex-col gap-1">
                                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.title}</h3>
                                    <dl className="grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
                                        {group.rows.map((row) => (
                                            <React.Fragment key={row.label}>
                                                <dt className="text-muted-foreground">{row.label}</dt>
                                                {row.label === "Build"
                                                    ? <dd className="font-mono text-xs leading-5 text-kb-ink [overflow-wrap:anywhere]">{breakable(row.value)}</dd>
                                                    : <dd className="text-kb-ink">{row.value}</dd>}
                                            </React.Fragment>
                                        ))}
                                    </dl>
                                </section>
                            ))}
                        </div>
                    )}
                </div>
                {copied === "failed" && <p role="alert" className="-mt-2 text-sm text-kb-warn-ink">{STATUS_REPORT_COPY_FAILED}</p>}
                <DialogFooter className="shrink-0">
                    <Button variant="outline" disabled={reading || board === null} onClick={read} data-testid="status-report-read">
                        {reading ? "Reading…" : problem ? "Try again" : "Read again"}
                    </Button>
                    <Button disabled={!status} onClick={copy} data-testid="status-report-copy" aria-live="polite">
                        {copied === "done" ? <><Check aria-hidden="true" />Copied</> : <><Copy aria-hidden="true" />Copy</>}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default StatusReportDialog;
