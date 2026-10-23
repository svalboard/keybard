// Which half is which, on the one-image firmware: the question, the confirmation and the
// result to confirm. Shown on the Firmware page, in the editor's banner, before an update
// (the sheet), and in the update. Keybard never sets a side by itself: every SET follows
// the customer's answer, and the answer is the confirmation (no second click). The likely
// answer is the main button.

import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { oppositeSide, type Side } from "@/services/side";
import type { HalfRole, SideAssessment, SideWrite } from "@/services/side-decision";
import { likelyUsbSide, writesForAnswer } from "@/services/side-decision";
import type { SideAsk } from "@/services/updater/flow";

const cap = (s: Side) => (s === "left" ? "Left" : "Right");
const isSide = (s: unknown): s is Side => s === "left" || s === "right";

/** The flow's question as an assessment, for SideFix. */
export function assessmentFromAsk(ask: SideAsk): SideAssessment {
    if (isSide(ask.usb) && isSide(ask.other) && ask.usb !== ask.other) return { kind: "ok", usb: ask.usb, other: ask.other, migrated: ask.from === "migrated" };
    if (ask.reason === "same" && isSide(ask.usb)) return { kind: "same", side: ask.usb };
    const halves: HalfRole[] = [];
    if (ask.usb === "unknown" || ask.usb === null) halves.push("usb");
    if (ask.other === "unknown") halves.push("other");
    if (ask.other === null && (ask.usb === "unknown" || ask.usb === null)) return { kind: "alone", usb: "unknown" };
    return { kind: "unknown", halves, usb: ask.usb ?? "unknown", other: ask.other, guess: ask.suggested ? { usb: ask.suggested } : {} };
}

/** The line that says what's wrong, or null when nothing is. */
export function sideProblem(a: SideAssessment): string | null {
    if (a.kind === "same") return `Both halves are set up as the ${a.side} half, so neither half types.`;
    if (a.kind === "alone" && a.usb === "unknown") return "This half doesn't know which side it is, so it doesn't type.";
    if (a.kind !== "unknown") return null;
    const usb = a.halves.includes("usb");
    const other = a.halves.includes("other");
    if (usb && other) return "Neither half knows which side it is yet, so neither half types.";
    if (usb) return "The half plugged into your computer doesn't know which side it is, so neither half types.";
    if (other) return "The half on the split cable doesn't know which side it is, so neither half types.";
    return "Keybard can't tell which half is which, so neither half types.";
}

export interface SideFixProps {
    sides: SideAssessment;
    /** Send these SETs (the other half first). An empty list: the sides are right as they are. */
    onApply: (writes: SideWrite[]) => void;
    /** "fix": ask which half is plugged in. "confirm": show sides the firmware chose, "That's right" or "Swap". */
    mode?: "fix" | "confirm";
    /** confirm: where the sides came from. */
    from?: "migrated" | "strap" | null;
    /** The likely side of the plugged-in half: the main button. Null: no guess. */
    suggested?: Side | null;
    /** Keybard knew the plugged-in half's side before: "Keep the plugged-in half as the left half?". */
    restore?: boolean;
    busy?: boolean;
    /** Why the last write didn't take, in plain words. */
    note?: string | null;
    /** No heading: the dialog or the banner has its own. */
    bare?: boolean;
}

export function SideFix({ sides, onApply, mode = "fix", from, suggested, restore, busy, note, bare }: SideFixProps) {
    const changed = mode === "fix" && sides.kind === "ok" ? "The halves came back with other sides than before." : null;
    const problem = mode === "confirm" ? null : sideProblem(sides) ?? changed;
    if (mode === "fix" && !problem) return null;
    if (mode === "confirm" && sides.kind !== "ok") return null;
    const pick = suggested !== undefined ? suggested : likelyUsbSide(sides);
    // The customer's answer is the confirmation: it sends the SETs it takes (none when the sides already match).
    const answer = (usb: Side) => onApply(writesForAnswer(sides, usb));
    return (
        <div className="flex flex-col gap-3" data-testid="side-fix" data-sides={sides.kind} data-mode={mode} aria-busy={busy || undefined}>
            {!bare && (
                <p className="flex items-center gap-2 text-sm font-semibold text-kb-orange">
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                    Set which half is which
                </p>
            )}
            {mode === "confirm" && sides.kind === "ok" ? (
                <div className="flex flex-col gap-2">
                    <p className="text-sm text-kb-ink">
                        The half plugged into your computer is the {sides.usb} half, and the half on the split cable is the {sides.other} half.
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {from === "strap" ? "The thumb PCBA set this." : "Each half kept the side of the firmware it ran before."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="kb-primary" disabled={busy} data-side-action="confirm" onClick={() => onApply([])}>That's right</Button>
                        <Button variant="outline" disabled={busy} data-side-action="swap" onClick={() => answer(oppositeSide(sides.usb))}>Swap</Button>
                    </div>
                </div>
            ) : (
                <>
                    <p className="text-sm text-kb-ink">{problem}</p>
                    {restore && pick ? (
                        <div className="flex flex-col gap-2">
                            <p className="text-sm font-medium text-kb-ink">Keep the plugged-in half as the {pick} half?</p>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="kb-primary" disabled={busy} data-side-answer={pick} onClick={() => answer(pick)}>Yes, the {pick} half</Button>
                                <Button variant="outline" disabled={busy} data-side-answer={oppositeSide(pick)} onClick={() => answer(oppositeSide(pick))}>No, it's the {oppositeSide(pick)} half</Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <p className="text-sm font-medium text-kb-ink">Which half is plugged into your computer?</p>
                            <div className="flex flex-wrap gap-2">
                                {(["left", "right"] as Side[]).map((s) => (
                                    <Button key={s} variant={pick === s ? "kb-primary" : "outline"} disabled={busy} data-side-answer={s} onClick={() => answer(s)}>
                                        {cap(s)} half
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
            {busy && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />Setting the sides. The halves restart.
                </p>
            )}
            {note && <p role="alert" className="text-sm text-kb-red" data-testid="side-note">{note}</p>}
        </div>
    );
}
