// The update dialog: Start, then "Confirm on your keyboard" while the board waits for the
// key press, then Updating, then Done or a failure. One title per screen names the dialog.
// Clicking outside never closes it; beforeunload warns while an update runs; a toast asks to
// keep the tab open when it's hidden (F7).

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { Afterwards, FlowState } from "@/services/updater/flow";
import { handName, type Hand } from "@/services/updater/protocol";
import { FailureView, type FailureAction } from "./failures";
import { FwTitle, InFirmwareDialog, Problem } from "./parts";
import { awaitingConfirm, ConfirmView, ProgressView, useTicker } from "./ProgressDialog";
import { UpdateSheet } from "./UpdateSheet";
import type { UpdateUi } from "./useFirmwareUpdate";
import type { SideWrite } from "@/services/side-decision";
import { SideFix, assessmentFromAsk } from "./SideFix";

/** The Done screen's title: what is on the keyboard now. */
export function resultTitle(s: FlowState): string {
    const what = s.title.startsWith("Install custom") ? "The custom firmware" : s.toTag;
    if (s.target !== "both") return `${what} is installed on the ${handName(s.target)} half`;
    return `${what} is installed`;
}

export function resultLine(s: FlowState): string {
    const layout = s.result?.layout;
    const line = layout === "restored" ? "Your layout is back on the keyboard." : layout === "blank" ? "Every key is blank, ready for your layout." : "Your keyboard has the default layout.";
    // One-image firmware: Keybard set a side the customer gave it.
    return s.result?.sides?.wrote.length ? `${line} Each half knows its side now.` : line;
}

/** A1: done. */
export function ResultView({ state, onDone }: { state: FlowState; onDone: () => void }) {
    const r = state.result!;
    return (
        <div className="flex flex-col gap-4" data-testid="update-result">
            <FwTitle sub={resultLine(state)}>{resultTitle(state)}</FwTitle>
            {r.trimmed.length > 0 && (
                <Problem title="Some of your layout didn't fit this firmware.">
                    {r.trimmed.map((line) => <p key={line}>{line}</p>)}
                </Problem>
            )}
            <div className="flex justify-end"><Button variant="kb-primary" onClick={onDone}>Done</Button></div>
        </div>
    );
}

export interface UpdateDialogProps {
    ui: UpdateUi;
    now: () => number;
    chordLegends: (hand: Hand) => [string, string];
    cancellable: boolean;
    udevCommand?: string;
    onAfterwards: (a: Afterwards) => void;
    onStart: () => void;
    onCancel: () => void;
    onClose: () => void;
    onFailureAction: (a: FailureAction) => void;
    onSaveManually?: () => void;
    /** Before an update: send the side fixes the board needs. */
    onFixSides?: (writes: SideWrite[]) => void;
    /** During an update: the customer's answer about which half is which. */
    onAnswerSide?: (writes: SideWrite[]) => void;
}

function useHiddenToast(active: boolean) {
    const [hidden, setHidden] = useState(false);
    useEffect(() => {
        if (!active) return;
        const onChange = () => { if (document.visibilityState === "hidden") setHidden(true); };
        document.addEventListener("visibilitychange", onChange);
        return () => document.removeEventListener("visibilitychange", onChange);
    }, [active]);
    return [hidden && active, () => setHidden(false)] as const;
}

export function UpdateDialog(p: UpdateDialogProps) {
    const { ui } = p;
    const running = ui.kind === "flow" && ui.state.phase === "running";
    const now = useTicker(p.now);
    const [toast, dismissToast] = useHiddenToast(running);

    useEffect(() => {
        if (!running) return;
        const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [running]);

    const onOpenChange = useCallback((open: boolean) => {
        if (open || running) return;
        if (ui.kind === "sheet") p.onCancel();
        else p.onClose();
    }, [running, ui.kind, p]);

    if (ui.kind === "idle" || (ui.kind === "flow" && ui.state.phase === "cancelled")) return null;
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="sm:max-w-[520px]"
                onInteractOutside={(e) => e.preventDefault()}
                onEscapeKeyDown={(e) => { if (running) e.preventDefault(); }}
                aria-describedby={undefined}
            >
                <InFirmwareDialog.Provider value>
                {ui.kind === "sheet" && (
                    ui.preFailure?.id === "sides" ? (
                        <div className="flex flex-col gap-4" data-testid="sheet-sides">
                            <FwTitle sub="Then Keybard checks the keyboard again and offers the update.">Set which half is which first</FwTitle>
                            <SideFix bare sides={ui.preFailure.sides} busy={ui.sideBusy} note={ui.sideNote} onApply={(w) => p.onFixSides?.(w)} />
                            <div className="flex justify-end"><Button variant="outline" onClick={p.onCancel}>Cancel</Button></div>
                        </div>
                    ) : ui.preFailure ? (
                        <FailureView failure={{ id: ui.preFailure.id === "unsupported" ? "F18" : ui.preFailure.id }} onAction={p.onFailureAction} />
                    ) : (
                        <UpdateSheet ui={ui} onAfterwards={p.onAfterwards} onStart={p.onStart} onCancel={p.onCancel} onSaveManually={p.onSaveManually} />
                    )
                )}
                {ui.kind === "flow" && ui.state.phase === "running" && ui.state.sideAsk && (
                    <div className="flex flex-col gap-4" data-testid="flow-sides">
                        <FwTitle sub={`${ui.state.toTag} is installed on both halves.`}>{ui.state.sideAsk.reason === "confirm" ? "Check which half is which" : "Set which half is which"}</FwTitle>
                        <SideFix
                            bare
                            mode={ui.state.sideAsk.reason === "confirm" ? "confirm" : "fix"}
                            from={ui.state.sideAsk.from}
                            restore={ui.state.sideAsk.restore}
                            sides={assessmentFromAsk(ui.state.sideAsk)}
                            suggested={ui.state.sideAsk.suggested}
                            note={ui.state.sideAsk.note}
                            onApply={(w) => p.onAnswerSide?.(w)}
                        />
                    </div>
                )}
                {ui.kind === "flow" && ui.state.phase === "running" && !ui.state.sideAsk && (
                    <>
                        {awaitingConfirm(ui.state)
                            ? <ConfirmView state={ui.state} legends={p.chordLegends(ui.state.usbHand as Hand)} now={now} />
                            : <ProgressView state={ui.state} now={now} />}
                        {p.cancellable && <div className="flex justify-end"><Button variant="outline" onClick={p.onCancel}>Cancel</Button></div>}
                    </>
                )}
                {ui.kind === "flow" && ui.state.phase === "result" && <ResultView state={ui.state} onDone={p.onClose} />}
                {ui.kind === "flow" && ui.state.phase === "failed" && ui.state.failure && (
                    <FailureView failure={ui.state.failure} fromTag={ui.state.fromTag} udevCommand={p.udevCommand} onAction={p.onFailureAction} />
                )}
                {toast && (
                    <div role="status" className="rounded-md border border-kb-gray-border bg-kb-surface p-2 text-sm">
                        Keep this tab open until the update finishes
                        <button type="button" className="ml-2 text-kb-primary underline" onClick={dismissToast}>OK</button>
                    </div>
                )}
                </InFirmwareDialog.Provider>
            </DialogContent>
        </Dialog>
    );
}
