import { useCallback, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PAD_MODE_AUTO, PAD_MODE_BUILTIN, PAD_MODE_LABELS } from "@/utils/touchpad-tuning";

/**
 * The check before the pads leave touchpad mode for their built-in gestures:
 * what changes on Windows and Linux. Cancel is the default (focused first, and
 * Escape or a click outside cancels); nothing is written until the user agrees.
 */
export function BuiltinGesturesConfirm({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
            <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg" data-builtin-confirm
                onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>("[data-cancel]")?.focus(); }}>
                <DialogHeader>
                    <DialogTitle>Use built-in gestures?</DialogTitle>
                    <DialogDescription>On Windows and Linux, the pads stop being a touchpad:</DialogDescription>
                </DialogHeader>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-kb-ink">
                    <li>The system's touchpad settings and gestures no longer apply: three- and four-finger swipes and taps, pinch to zoom, and the Windows tap, scroll and palm settings.</li>
                    <li>Taps, two-finger scroll, right click and press-and-hold drag come from the pad itself, tuned in this dialog.</li>
                    <li>On a Mac and in a BIOS nothing changes: they use built-in gestures either way.</li>
                    <li>Automatic is what we ship and recommend.</li>
                </ul>
                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={onCancel} data-cancel>Cancel</Button>
                    <Button variant="kb-primary" onClick={onConfirm} data-confirm>Use built-in gestures</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * A touchpad mode change, with the check above on the way to built-in
 * gestures. Back to Automatic writes at once.
 */
export function useTouchpadModeChange(write: (mode: number) => void): { change: (mode: number, from: number) => void; confirm: ReactNode } {
    const [asking, setAsking] = useState(false);
    const change = useCallback((mode: number, from: number) => {
        if (mode === from) return;
        if (mode === PAD_MODE_BUILTIN) setAsking(true);
        else write(mode);
    }, [write]);
    const confirm = (
        <BuiltinGesturesConfirm open={asking} onCancel={() => setAsking(false)}
            onConfirm={() => { setAsking(false); write(PAD_MODE_BUILTIN); }} />
    );
    return { change, confirm };
}

/** The two modes side by side, for the top of the tuning dialog. */
export function TouchpadModeControl({ value, onChange }: { value: number; onChange: (mode: number) => void }) {
    return (
        <div className="flex flex-col gap-1.5 rounded-md px-3 py-2 panel-layer-item" data-touchpad-mode>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-kb-ink" id="touchpad-mode-label">Touchpad mode</span>
                <div role="radiogroup" aria-labelledby="touchpad-mode-label" className="flex rounded-full border border-kb-gray-border p-0.5">
                    {[PAD_MODE_AUTO, PAD_MODE_BUILTIN].map((mode) => (
                        <button key={mode} type="button" role="radio" aria-checked={value === mode} onClick={() => onChange(mode)}
                            className={cn("rounded-full px-3 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                                value === mode ? "bg-kb-active text-kb-active-fg" : "text-muted-foreground hover:text-kb-ink")}
                            data-mode={mode}>
                            {PAD_MODE_LABELS[mode]}
                        </button>
                    ))}
                </div>
            </div>
            <span className="text-xs text-muted-foreground">
                Automatic: a touchpad in Windows and Linux. Built-in gestures: the pad makes its own taps and scrolling, as it does on a Mac or in a BIOS.
            </span>
        </div>
    );
}
