// B1, the Start screen: one sentence, the layout choice, Update. Checks that pass say
// nothing; one that warns or fails shows as a sentence and what to do about it.

import { Button } from "@/components/ui/button";
import type { CheckRow } from "@/services/updater/checks";
import type { Afterwards } from "@/services/updater/flow";
import { handName, otherHand, type Hand } from "@/services/updater/protocol";
import { LayoutChoice } from "./LayoutChoice";
import { FwTitle, Problem, SectionLabel, Spinner } from "./parts";
import type { UpdateUi } from "./useFirmwareUpdate";

type SheetUi = Extract<UpdateUi, { kind: "sheet" }>;

export interface UpdateSheetProps {
    ui: SheetUi;
    chordLegends?: (hand: Hand) => [string, string];
    onAfterwards: (a: Afterwards) => void;
    onStart: () => void;
    onCancel: () => void;
    onSaveManually?: () => void;
}

function ProblemRow({ row }: { row: CheckRow }) {
    return <Problem id={row.id} title={row.label}>{row.detail}</Problem>;
}

/** What the update does, in one sentence. */
function summary(target: "both" | Hand, usb: Hand): string {
    if (target === "both") return "Keybard updates both halves through the cable to your computer. It takes about 2 minutes.";
    if (target === usb) return `Keybard updates the ${handName(usb)} half. It takes about a minute.`;
    return `Keybard updates the ${handName(otherHand(usb))} half through the split cable. It takes about a minute.`;
}

export function UpdateSheet({ ui, onAfterwards, onStart, onCancel, onSaveManually }: UpdateSheetProps) {
    const { plan, backup, afterwards } = ui;
    if (ui.error) {
        return (
            <div className="flex flex-col gap-4">
                <FwTitle>Keybard can't update the keyboard right now</FwTitle>
                <p role="alert" className="text-sm">{ui.error}</p>
                <div className="flex justify-end"><Button variant="outline" onClick={onCancel}>Close</Button></div>
            </div>
        );
    }
    if (!plan) {
        return (
            <div className="flex flex-col gap-4" aria-busy="true" data-testid="update-sheet">
                <FwTitle>Checking your keyboard</FwTitle>
                <div className="flex items-center gap-3 text-sm"><Spinner />Reading the firmware on both halves</div>
                <div className="flex justify-end"><Button variant="outline" onClick={onCancel}>Cancel</Button></div>
            </div>
        );
    }
    const usb = plan.board.usb.hand as Hand;
    const refusal = plan.refusal;
    const backupFailed = backup.state === "failed";
    const anyWarning = plan.warnings.length > 0 || backupFailed;
    const onlyUsb = plan.otherSilent && plan.target === usb;
    const primary = onlyUsb ? `Update the ${handName(usb)} half` : anyWarning ? "Update anyway" : "Update";
    // A blank keyboard needs no backup: Update doesn't wait for it.
    const ready = !refusal && (backup.state !== "pending" || afterwards === "blank");
    return (
        <div className="flex flex-col gap-5" data-testid="update-sheet">
            <FwTitle sub={refusal ? undefined : summary(plan.target, usb)}>{plan.title}</FwTitle>

            {refusal && <div role="alert"><ProblemRow row={refusal} /></div>}
            {!refusal && anyWarning && (
                <div className="flex flex-col gap-2" data-testid="update-warnings">
                    {plan.warnings.map((w) => <ProblemRow key={w.id} row={w} />)}
                    {backupFailed && (
                        <Problem id="backup-failed" title="Keybard couldn't save your layout.">
                            Afterward the keyboard starts from the default layout.
                            {onSaveManually && <> <button type="button" className="text-kb-primary underline" onClick={onSaveManually}>Save it yourself first</button>.</>}
                        </Problem>
                    )}
                </div>
            )}

            {!refusal && (
                <section className="flex flex-col gap-2" aria-label="Your layout">
                    <SectionLabel>Your layout</SectionLabel>
                    <p className="text-sm">
                        {backup.state === "ok" ? <>Saved to Downloads just now, before the update, as <span className="break-all font-mono text-xs">{backup.fileName}</span>. Afterward:</>
                            : backupFailed ? "Afterward:" : "Keybard saves it to Downloads before it starts. Afterward:"}
                    </p>
                    <LayoutChoice value={afterwards} onChange={onAfterwards} keepDisabled={backup.state !== "ok"} />
                </section>
            )}

            <footer className="flex flex-wrap justify-end gap-2 border-t border-kb-gray-border pt-4">
                {refusal?.id === "integrity" ? (
                    <>
                        <Button variant="outline" onClick={onCancel}>Close</Button>
                        <Button variant="kb-primary" onClick={() => window.location.reload()}>Reload</Button>
                    </>
                ) : (
                    <>
                        <Button variant="outline" onClick={onCancel}>{refusal ? "Close" : "Cancel"}</Button>
                        {!refusal && <Button variant="kb-primary" data-primary disabled={!ready} onClick={onStart}>{primary}</Button>}
                    </>
                )}
            </footer>
        </div>
    );
}
