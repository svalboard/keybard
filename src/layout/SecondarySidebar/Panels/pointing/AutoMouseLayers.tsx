import { useEffect, useState } from "react";
import { Ban } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { svalService } from "@/services/sval.service";
import type { KeyboardInfo } from "@/types/keyboard.types";
import {
    AUTOMOUSE_EVERYWHERE, AUTOMOUSE_LAYER_MASK_KEY, AUTOMOUSE_LAYERS_ONLY_KEY, AUTOMOUSE_MODE_CHOICES, AUTOMOUSE_SELECTED,
    maskToLayers, pickableLayers, toggleMaskLayer,
} from "@/utils/automouse-layers";
import { ChoiceRow, RowLabel } from "./PointingControls";

/** A layer's name as the layer bar at the top of the screen shows it. */
const layerName = (keyboard: KeyboardInfo, layer: number) => svalService.getLayerNameNoLabel(keyboard, layer);

/**
 * The layer pills, styled as the layer bar at the top of the screen: one per layer
 * (the mouse layer left out). A pill pressed is a layer where Auto Mouse is off:
 * filled, struck through, with a "no" mark, so it reads without color too.
 */
export function AutoMouseLayerPills({ keyboard, mask, onToggle }: { keyboard: KeyboardInfo; mask: number; onToggle: (layer: number) => void }) {
    return (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Layers" data-automouse-pills>
            {pickableLayers(keyboard.layers).map((i) => {
                const off = ((mask >> i) & 1) === 1;
                const name = layerName(keyboard, i);
                return (
                    <button
                        key={i}
                        type="button"
                        aria-pressed={off}
                        aria-label={`Layer ${i}: ${name}${off ? ", Auto Mouse off" : ""}`}
                        title={off ? "Auto Mouse is off on this layer" : "Auto Mouse works on this layer"}
                        onClick={() => onToggle(i)}
                        data-layer={i}
                        data-off={off ? 1 : 0}
                        className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 whitespace-nowrap",
                            off
                                ? "border-kb-warn-ink bg-kb-warn-bg text-kb-warn-ink"
                                : "border-kb-gray-border bg-transparent text-kb-ink hover:bg-kb-gray-border/30",
                        )}
                    >
                        {off && <Ban className="h-3.5 w-3.5" aria-hidden />}
                        <span className={cn("select-none", off && "line-through")}>{name}</span>
                    </button>
                );
            })}
        </div>
    );
}

/** The picker: the layer pills in a dialog, with Done (saves) and Cancel. */
export function AutoMouseLayersDialog({ open, keyboard, mask, onDone, onCancel }: {
    open: boolean; keyboard: KeyboardInfo; mask: number; onDone: (mask: number) => void; onCancel: () => void;
}) {
    const [draft, setDraft] = useState(mask);
    useEffect(() => { if (open) setDraft(mask); }, [open, mask]);
    const count = maskToLayers(draft, keyboard.layers).length;
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
            <DialogContent className="sm:max-w-[520px]" data-automouse-dialog>
                <DialogHeader>
                    <DialogTitle>Turn Off Auto Mouse on Layers</DialogTitle>
                    <DialogDescription>
                        Click a layer to turn Auto Mouse off on it. While you're on that layer, moving the pointer won't switch to the mouse layer.
                    </DialogDescription>
                </DialogHeader>
                <AutoMouseLayerPills keyboard={keyboard} mask={draft} onToggle={(l) => setDraft((m) => toggleMaskLayer(m, l))} />
                <p className="text-xs text-muted-foreground" aria-live="polite" data-automouse-count>
                    {count === 0 ? "Auto Mouse works on every layer." : `Auto Mouse is off on ${count} ${count === 1 ? "layer" : "layers"}.`}
                </p>
                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={onCancel}>Cancel</Button>
                    <Button onClick={() => onDone(draft)} data-automouse-done>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The Auto Mouse Layer setting, under Enable Auto Mouse: Everywhere (the default) or Only on
 * Selected Layers, and then the layers where it is off with a button that opens the picker.
 * Drawn only when the firmware has the setting (the values are in the menu).
 */
export function AutoMouseLayersSetting({ keyboard, values, set }: {
    keyboard: KeyboardInfo; values: Map<string, number>; set: (key: string, value: number) => void;
}) {
    const [open, setOpen] = useState(false);
    const mode = values.get(AUTOMOUSE_LAYERS_ONLY_KEY);
    const mask = values.get(AUTOMOUSE_LAYER_MASK_KEY) ?? 0;
    const off = maskToLayers(mask, keyboard.layers).filter((l) => pickableLayers(keyboard.layers).includes(l));
    return (
        <>
            <ChoiceRow label="Auto Mouse Layer" hint="Where pointer motion switches to the mouse layer" value={mode}
                choices={AUTOMOUSE_MODE_CHOICES} onChange={(v) => set(AUTOMOUSE_LAYERS_ONLY_KEY, v === AUTOMOUSE_SELECTED ? AUTOMOUSE_SELECTED : AUTOMOUSE_EVERYWHERE)} />
            {mode === AUTOMOUSE_SELECTED && (
                <div className="flex flex-row flex-wrap items-center justify-between gap-3 rounded-md px-3 py-2 panel-layer-item" data-automouse-layers-row>
                    <RowLabel label="Off on Layers"
                        hint={off.length ? off.map((l) => layerName(keyboard, l)).join(", ") : "None yet: Auto Mouse works on every layer"} />
                    <Button size="sm" variant="outline" className="rounded-full" onClick={() => setOpen(true)} data-automouse-choose>
                        Choose Layers
                    </Button>
                </div>
            )}
            <AutoMouseLayersDialog open={open} keyboard={keyboard} mask={mask}
                onCancel={() => setOpen(false)}
                onDone={(m) => { setOpen(false); if (m !== mask) set(AUTOMOUSE_LAYER_MASK_KEY, m); }} />
        </>
    );
}
