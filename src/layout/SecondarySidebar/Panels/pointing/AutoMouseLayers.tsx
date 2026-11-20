import { useCallback, useEffect, useRef, useState } from "react";

import { LayerPill } from "@/components/LayerPill";
import { svalService } from "@/services/sval.service";
import type { KeyboardInfo } from "@/types/keyboard.types";
import {
    AUTOMOUSE_EVERYWHERE, AUTOMOUSE_LAYER_MASK_KEY, AUTOMOUSE_LAYERS_ONLY_KEY, AUTOMOUSE_MODE_CHOICES, AUTOMOUSE_SELECTED,
    pickableLayers, toggleMaskLayer,
} from "@/utils/automouse-layers";
import { ChoiceRow } from "./PointingControls";

/** How long a burst of pill clicks waits before the mask is written once. */
export const AUTOMOUSE_MASK_WRITE_DELAY_MS = 400;

/** A layer's name as the layer bar at the top of the screen shows it. */
const layerName = (keyboard: KeyboardInfo, layer: number) => svalService.getLayerNameNoLabel(keyboard, layer);

/**
 * The layer pills: one per layer (the mouse layer left out). Each click turns Auto Mouse
 * off or back on for that layer. A pill pressed is a layer where Auto Mouse is off:
 * filled, struck through, with a "no" mark, so it reads without color too.
 */
export function AutoMouseLayerPills({ keyboard, mask, onToggle }: { keyboard: KeyboardInfo; mask: number; onToggle: (layer: number) => void }) {
    return (
        <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="Layers where Auto Mouse works" data-automouse-pills>
            {pickableLayers(keyboard.layers).map((i) => {
                const off = ((mask >> i) & 1) === 1;
                const name = layerName(keyboard, i);
                return (
                    <LayerPill
                        key={i}
                        name={name}
                        state={off ? "off" : "neutral"}
                        aria-pressed={off}
                        aria-label={`Layer ${i}: Auto Mouse ${off ? "off" : "on"}`}
                        title={off ? `${name}: Auto Mouse is off. Click to turn it on` : `${name}: Auto Mouse works. Click to turn it off`}
                        onClick={() => onToggle(i)}
                        data-layer={i}
                        data-off={off ? 1 : 0}
                    />
                );
            })}
        </div>
    );
}

/**
 * The Auto Mouse Layer setting, under Enable Auto Mouse: Everywhere (the default) or Only on
 * Selected Layers, and for Only on Selected Layers the layer pills under it, each toggled by a
 * click. The pills show the click at once; a burst of clicks writes the final mask once.
 * Everywhere hides the pills and keeps the mask. Drawn only when the firmware has the setting.
 */
export function AutoMouseLayersSetting({ keyboard, values, set }: {
    keyboard: KeyboardInfo; values: Map<string, number>; set: (key: string, value: number) => void;
}) {
    const mode = values.get(AUTOMOUSE_LAYERS_ONLY_KEY);
    const boardMask = values.get(AUTOMOUSE_LAYER_MASK_KEY) ?? 0;
    const selected = mode === AUTOMOUSE_SELECTED;

    // The mask on screen: the board's, or the clicked one until it is written.
    const [pending, setPending] = useState<number | null>(null);
    const pendingRef = useRef<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const setRef = useRef(set);
    setRef.current = set;
    const boardRef = useRef(boardMask);
    boardRef.current = boardMask;

    const flush = useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const m = pendingRef.current;
        pendingRef.current = null;
        setPending(null);
        if (m !== null && m !== boardRef.current) setRef.current(AUTOMOUSE_LAYER_MASK_KEY, m);
    }, []);
    // Leaving the panel never loses the last click.
    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
        const m = pendingRef.current;
        if (m !== null && m !== boardRef.current) setRef.current(AUTOMOUSE_LAYER_MASK_KEY, m);
    }, []);

    const toggle = (layer: number) => {
        const next = toggleMaskLayer(pendingRef.current ?? boardMask, layer);
        pendingRef.current = next;
        setPending(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, AUTOMOUSE_MASK_WRITE_DELAY_MS);
    };

    return (
        <ChoiceRow label="Auto Mouse Layer" hint="Where pointer motion switches to the mouse layer" value={mode}
            choices={AUTOMOUSE_MODE_CHOICES}
            onChange={(v) => { flush(); set(AUTOMOUSE_LAYERS_ONLY_KEY, v === AUTOMOUSE_SELECTED ? AUTOMOUSE_SELECTED : AUTOMOUSE_EVERYWHERE); }}>
            {selected && <AutoMouseLayerPills keyboard={keyboard} mask={pending ?? boardMask} onToggle={toggle} />}
        </ChoiceRow>
    );
}
