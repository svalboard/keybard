import { useEffect, useMemo, useRef, useState } from "react";

import { Slider } from "@/components/ui/slider";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { pointingMenuIndex, useMenuValues } from "@/hooks/useMenuValues";
import { cn } from "@/lib/utils";
import type { KeyboardInfo } from "@/types/keyboard.types";
import { getPadTouch } from "@/services/pad-touch.service";
import { boardHasTouchpad, PAD_HOLD_KEY, PAD_HOLD_MS, PAD_HOLD_MS_KEY } from "@/utils/touchpad-taps";
import {
    contactRadius, EMPTY_BLOCK, formatMm, hasPadTouch, hasPadTuning, PAD_DEAD_ZONE_DEFAULT, PAD_DEAD_ZONE_KEY, PAD_DEAD_ZONE_MM100,
    PAD_HEIGHT_MM100, PAD_SCROLL_KEY, PAD_SCROLL_MM100, PAD_TAP_DEFAULT_MS, PAD_TAP_MS, PAD_TAP_MS_KEY, PAD_WIDTH_MM100,
    steps, TouchTracker, type PadTouchBlock, type PadTouchReport, type TouchOutcome,
} from "@/utils/touchpad-tuning";
import { PadView, type PadTiming } from "./PadView";

/** Finished touches kept per pad, newest first, in the pad's scrolling list. */
const OUTCOMES = 50;

interface StepProps {
    label: string;
    value: number;
    table: readonly number[];
    format: (v: number) => string;
    onChange: (v: number) => void;
    disabled?: boolean;
    note?: string;
}

/** A slider over exactly the values the board stores. */
function StepControl({ label, value, table, format, onChange, disabled, note }: StepProps) {
    const list = useMemo(() => steps(table), [table]);
    const index = Math.max(0, list.findIndex((v) => v === value));
    const [draft, setDraft] = useState(index);
    useEffect(() => setDraft(index), [index]);
    return (
        <div className="flex flex-col gap-1.5 rounded-md px-3 py-2 panel-layer-item" data-step={label} data-disabled={disabled || undefined}>
            <div className="flex items-baseline justify-between gap-3">
                <span className={cn("text-sm", disabled ? "text-muted-foreground" : "text-kb-ink")}>{label}</span>
                <span className="text-sm font-medium tabular-nums text-kb-ink" data-step-value>{format(list[draft])}</span>
            </div>
            <Slider
                aria-label={label}
                aria-valuetext={format(list[draft])}
                min={0}
                max={list.length - 1}
                step={1}
                value={[draft]}
                disabled={disabled}
                onValueChange={([i]) => setDraft(i)}
                onValueCommit={([i]) => { if (list[i] !== value) onChange(list[i]); }}
            />
            {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
    );
}

interface PadLive { block: PadTouchBlock; events: number; trail: { x: number; y: number }[]; outcomes: TouchOutcome[]; count: number }

interface LiveState {
    report: PadTouchReport | null;
    readAt: number;
    left: PadLive;
    right: PadLive;
}

const NO_LIVE: LiveState = {
    report: null, readAt: 0,
    left: { block: EMPTY_BLOCK, events: 0, trail: [], outcomes: [], count: 0 },
    right: { block: EMPTY_BLOCK, events: 0, trail: [], outcomes: [], count: 0 },
};

/** Both pads, live, while the view is open. */
function useLiveTouch(enabled: boolean, keyboard: KeyboardInfo | null | undefined, connected: boolean): LiveState {
    const [live, setLive] = useState<LiveState>(NO_LIVE);
    const trackers = useRef({ left: new TouchTracker(), right: new TouchTracker() });
    useEffect(() => { getPadTouch().setConnection(keyboard ?? null, connected); }, [keyboard, connected]);
    useEffect(() => {
        if (!enabled) return;
        const service = getPadTouch();
        const release = service.acquire();
        const unsubscribe = service.subscribe((report, at) => {
            setLive((prev) => {
                const next: LiveState = { report, readAt: at, left: prev.left, right: prev.right };
                for (const side of ["left", "right"] as const) {
                    const t = trackers.current[side];
                    const done = t.take(report[side], report);
                    next[side] = {
                        block: report[side],
                        events: t.touchEvents,
                        trail: t.trail,
                        outcomes: done ? [done, ...prev[side].outcomes].slice(0, OUTCOMES) : prev[side].outcomes,
                        count: prev[side].count + (done ? 1 : 0),
                    };
                }
                return next;
            });
        });
        return () => { unsubscribe(); release(); };
    }, [enabled]);
    return live;
}

interface TouchpadTuningProps {
    /** Where it shows: the Settings card, or the dialog from Pointing Devices. */
    place: "settings" | "dialog";
}

/**
 * Touchpad tuning: the dead zone, the tap and hold times and the scroll
 * distance, with each pad drawn live so a touch shows why it clicked or not.
 * Shown only on firmware that has the setting and a board with a touchpad;
 * the live pads need the touch page as well.
 */
export function TouchpadTuning({ place }: TouchpadTuningProps) {
    const { keyboard, isConnected } = useKeyboard();
    const menuIndex = pointingMenuIndex(keyboard?.menus);
    const menu = menuIndex >= 0 ? keyboard?.menus?.[menuIndex] : undefined;
    const { values, setValue } = useMenuValues(menu);
    const supported = !!keyboard && hasPadTuning(keyboard.feature_flags3) && boardHasTouchpad(keyboard);
    const liveOn = supported && isConnected && hasPadTouch(keyboard?.feature_flags3);
    const live = useLiveTouch(liveOn, keyboard, isConnected);

    if (!supported) return <p className="px-3 py-2 text-sm text-muted-foreground">Connect a board with a touchpad to tune it.</p>;

    const deadZone = values.get(PAD_DEAD_ZONE_KEY) || PAD_DEAD_ZONE_DEFAULT;
    const tapMs = values.get(PAD_TAP_MS_KEY) || PAD_TAP_DEFAULT_MS;
    const holdMs = values.get(PAD_HOLD_MS_KEY) || PAD_HOLD_MS[0];
    const holdOn = (values.get(PAD_HOLD_KEY) ?? 1) !== 0;
    const scroll = values.get(PAD_SCROLL_KEY) ?? 0;
    // The build's own scroll distance reads back as its millimeters; show it on the scale.
    const scrollTable = PAD_SCROLL_MM100.includes(scroll as never) ? PAD_SCROLL_MM100.slice(1) : [...PAD_SCROLL_MM100.slice(1), scroll];
    const r = live.report;
    const timing: PadTiming = {
        deadZone: r?.deadZone ?? deadZone, tapMs: r?.tapMs ?? tapMs, holdMs: r?.holdMs ?? holdMs, holdOn: r?.holdOn ?? holdOn,
        width: r?.width ?? PAD_WIDTH_MM100, height: r?.height ?? PAD_HEIGHT_MM100,
    };

    const controls = (
        <div className="grid gap-2 @lg:grid-cols-2 @5xl:grid-cols-4" data-tuning-controls>
            <StepControl label="Dead zone" value={deadZone} table={PAD_DEAD_ZONE_MM100} format={formatMm} onChange={(v) => setValue(PAD_DEAD_ZONE_KEY, v)}
                note="How far a finger can move before a tap or a hold is canceled." />
            <StepControl label="Tap time" value={tapMs} table={PAD_TAP_MS} format={(v) => `${v} ms`} onChange={(v) => setValue(PAD_TAP_MS_KEY, v)}
                note="A tap must lift within this." />
            <StepControl label="Hold time" value={holdMs} table={PAD_HOLD_MS} format={(v) => `${v} ms`} onChange={(v) => setValue(PAD_HOLD_MS_KEY, v)} disabled={!holdOn}
                note={holdOn ? `Press and hold clicks after the tap time plus this: ${tapMs + holdMs} ms.` : "Press and Hold to Drag is off in Pointing Devices."} />
            <StepControl label="Scroll start" value={scroll} table={scrollTable} format={formatMm} onChange={(v) => setValue(PAD_SCROLL_KEY, v)}
                note="How far two fingers move before they scroll." />
        </div>
    );

    const pads = !liveOn ? (
        <p className="text-sm text-muted-foreground" data-live-absent>{isConnected ? "This firmware can't show the pads live. Update it to see each touch." : "Connect the board to see each touch."}</p>
    ) : (
        <div className="flex flex-col gap-6 @3xl:flex-row sm:min-h-0 sm:flex-1" data-pads>
            {(["left", "right"] as const).map((side) => (
                <div key={side} className="flex min-w-0 flex-1 flex-col sm:min-h-0">
                    <PadView side={side} block={live[side].block} readAt={live.readAt} touchEvents={live[side].events} trail={live[side].trail} count={live[side].count} timing={timing}
                        contactR={r ? contactRadius(live[side].block.area, r) : 0}
                        outcomes={live[side].outcomes} />
                </div>
            ))}
        </div>
    );

    return (
        <div className={cn("@container flex flex-col gap-4", place === "settings" ? "px-3 pt-3 pb-1" : "sm:h-full")} data-touchpad-tuning>
            {controls}
            {pads}
        </div>
    );
}
