import { useEffect, useMemo, useRef, useState } from "react";

import { Slider } from "@/components/ui/slider";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { pointingMenuIndex, useMenuValues } from "@/hooks/useMenuValues";
import { cn } from "@/lib/utils";
import type { KeyboardInfo } from "@/types/keyboard.types";
import { getPadTouch } from "@/services/pad-touch.service";
import { boardHasTouchpad, PAD_HOLD_KEY, PAD_HOLD_MS, PAD_HOLD_MS_KEY } from "@/utils/touchpad-taps";
import {
    contactRadius, EMPTY_BLOCK, EMPTY_FINGERS, formatMm, formatPalm, hasPadMode, hasPadPalm, hasPadTouch, hasPadTuning, PAD_DEAD_ZONE_DEFAULT, PAD_DEAD_ZONE_KEY, PAD_MODE_AUTO, PAD_MODE_BUILTIN, PAD_MODE_KEY,
    PAD_DEAD_ZONE_MM100, PAD_HEIGHT_MM100, PAD_PALM_CHANNELS, PAD_PALM_KEY, PAD_SCROLL_KEY, PAD_SCROLL_MM100, PAD_TAP_DEFAULT_MS, PAD_TAP_MS,
    PAD_TAP_MS_KEY, PAD_WIDTH_MM100, steps, TouchTracker, type MultiTouch, type PadFingersBlock, type PadTouchBlock, type PadTouchReport,
    type TouchOutcome,
} from "@/utils/touchpad-tuning";
import { PadView, type PadTiming } from "./PadView";
import { TouchpadModeControl, useTouchpadModeChange } from "./TouchpadMode";

/** Finished touches kept per pad, newest first, in the pad's scrolling list. */
const OUTCOMES = 50;

/**
 * A setting only the chip uses. In touchpad mode it isn't there for the user
 * (invisible, out of the tab order and the accessibility tree), but its box
 * keeps its place, so nothing moves when the mode changes.
 */
function ChipOnly({ hidden, children }: { hidden: boolean; children: React.ReactNode }) {
    return (
        <div className={hidden ? "invisible" : undefined} aria-hidden={hidden || undefined} inert={hidden || undefined} data-chip-only={hidden ? "hidden" : "shown"}>
            {children}
        </div>
    );
}

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

interface PadLive {
    block: PadTouchBlock;
    events: number;
    trail: { x: number; y: number }[];
    outcomes: TouchOutcome[];
    count: number;
    fingers: PadFingersBlock;
    touch: MultiTouch | null;
    twoTrail: { x: number; y: number }[];
}

const NO_PAD: PadLive = { block: EMPTY_BLOCK, events: 0, trail: [], outcomes: [], count: 0, fingers: EMPTY_FINGERS, touch: null, twoTrail: [] };

interface LiveState {
    report: PadTouchReport | null;
    /**
     * Every pad that answered was in touchpad mode at the last report where
     * any did: a report with no valid pad (a fresh start, a missed split read)
     * keeps the last answer, so the mode never blinks.
     */
    padsOs: boolean;
    readAt: number;
    left: PadLive;
    right: PadLive;
}

const NO_LIVE: LiveState = {
    report: null, readAt: 0, padsOs: false,
    left: NO_PAD,
    right: NO_PAD,
};

/**
 * Both pads, live, while the view is open. With built-in gestures set, a pad
 * is never taken as in touchpad mode, whatever its report says: the setting
 * owns the mode, and the report only tells Automatic's outcome.
 */
function useLiveTouch(enabled: boolean, keyboard: KeyboardInfo | null | undefined, connected: boolean, builtin: boolean): LiveState {
    const [live, setLive] = useState<LiveState>(NO_LIVE);
    const trackers = useRef({ left: new TouchTracker(), right: new TouchTracker() });
    const builtinRef = useRef(builtin);
    builtinRef.current = builtin;
    useEffect(() => { getPadTouch().setConnection(keyboard ?? null, connected); }, [keyboard, connected]);
    useEffect(() => {
        if (!enabled) return;
        const service = getPadTouch();
        const release = service.acquire();
        const unsubscribe = service.subscribe((raw, at) => {
            const report = builtinRef.current ? effective(raw) : raw;
            setLive((prev) => {
                const valid = [report.left, report.right].filter((b) => b.valid);
                const padsOs = valid.length ? valid.every((b) => b.os) : prev.padsOs;
                const next: LiveState = { report, readAt: at, padsOs, left: prev.left, right: prev.right };
                for (const side of ["left", "right"] as const) {
                    const t = trackers.current[side];
                    const done = t.take(report[side], report, report.fingers?.[side] ?? null, report.fingers?.palm ?? 0);
                    next[side] = {
                        block: report[side],
                        events: t.touchEvents,
                        trail: t.trail,
                        outcomes: done ? [done, ...prev[side].outcomes].slice(0, OUTCOMES) : prev[side].outcomes,
                        count: prev[side].count + (done ? 1 : 0),
                        fingers: t.fingers,
                        touch: t.touch ? { ...t.touch } : null,
                        twoTrail: t.twoTrail,
                    };
                }
                return next;
            });
        });
        return () => { unsubscribe(); release(); };
    }, [enabled]);
    return live;
}

/** The report as built-in gestures make it: no pad in touchpad mode. */
function effective(r: PadTouchReport): PadTouchReport {
    const f = r.fingers;
    return {
        ...r,
        left: { ...r.left, os: false },
        right: { ...r.right, os: false },
        fingers: f ? { ...f, left: { ...f.left, os: false }, right: { ...f.right, os: false } } : f,
    };
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
    // The touchpad mode setting, read before the live pads so it can own their mode.
    const modeKnown = !!keyboard && hasPadMode(keyboard.feature_flags4);
    const builtin = modeKnown && (values.get(PAD_MODE_KEY) ?? PAD_MODE_AUTO) === PAD_MODE_BUILTIN;
    const live = useLiveTouch(liveOn, keyboard, isConnected, builtin);
    // The dialog tunes against the live pads, so its writes go to the board at once, Live Updating or not.
    const setNow = (key: string, v: number) => { void setValue(key, v, { now: true }); };
    const modeChange = useTouchpadModeChange((m) => setNow(PAD_MODE_KEY, m));

    if (!supported) return <p className="px-3 py-2 text-sm text-muted-foreground">Connect a board with a touchpad to tune it.</p>;

    const deadZone = values.get(PAD_DEAD_ZONE_KEY) || PAD_DEAD_ZONE_DEFAULT;
    const tapMs = values.get(PAD_TAP_MS_KEY) || PAD_TAP_DEFAULT_MS;
    const holdMs = values.get(PAD_HOLD_MS_KEY) || PAD_HOLD_MS[0];
    const holdOn = (values.get(PAD_HOLD_KEY) ?? 1) !== 0;
    const scroll = values.get(PAD_SCROLL_KEY) ?? 0;
    const palmOn = hasPadPalm(keyboard.feature_flags4);
    const modeOn = hasPadMode(keyboard.feature_flags4);
    const modeValue = values.get(PAD_MODE_KEY) ?? PAD_MODE_AUTO;
    const palmValue = values.get(PAD_PALM_KEY) ?? 0;
    const palmTable = PAD_PALM_CHANNELS.includes(palmValue as never) ? PAD_PALM_CHANNELS : [...PAD_PALM_CHANNELS, palmValue];
    // The build's own scroll distance reads back as its millimeters; show it on the scale.
    const scrollTable = PAD_SCROLL_MM100.includes(scroll as never) ? PAD_SCROLL_MM100.slice(1) : [...PAD_SCROLL_MM100.slice(1), scroll];
    const r = live.report;
    const timing: PadTiming = {
        deadZone: r?.deadZone ?? deadZone, tapMs: r?.tapMs ?? tapMs, holdMs: r?.holdMs ?? holdMs, holdOn: r?.holdOn ?? holdOn,
        width: r?.width ?? PAD_WIDTH_MM100, height: r?.height ?? PAD_HEIGHT_MM100, scrollStart: r?.scrollStart || scroll || 105,
    };
    const palm = r?.fingers?.palm ?? palmValue;
    // Touchpad mode (Input Mode 3): the computer makes the taps and scrolls from the contacts, with its own
    // settings, so the chip's gesture settings change nothing there. One owner: with built-in gestures set
    // (useLiveTouch clears the pads' flags) they always apply; in Automatic, the pads' reports decide.
    const osMode = !builtin && live.padsOs;
    const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

    const controls = (
        <div className="flex flex-col gap-1.5">
            {modeOn && <TouchpadModeControl value={modeValue} onChange={(m) => modeChange.change(m, modeValue)} />}
            {modeChange.confirm}
            {/* Always laid out, shown only in touchpad mode: the controls never move when the mode is learned. */}
            <p className={cn("min-h-5 text-sm text-muted-foreground", osMode ? "" : "invisible")} aria-hidden={!osMode} data-os-mode-note>
                Windows or Linux decides taps and scrolling in this mode, so use the system touchpad settings{windows ? " (Settings > Bluetooth & devices > Touchpad)" : ""}.
            </p>
            <div className={cn("grid gap-2 @lg:grid-cols-2", palmOn ? "@5xl:grid-cols-5" : "@5xl:grid-cols-4")} data-tuning-controls data-os-mode={osMode || undefined}>
                {/* The chip's gesture settings do nothing in touchpad mode: hidden then, their space kept empty. */}
                <ChipOnly hidden={osMode}>
                    <StepControl label="Dead zone" value={deadZone} table={PAD_DEAD_ZONE_MM100} format={formatMm} onChange={(v) => setNow(PAD_DEAD_ZONE_KEY, v)}
                        note="How far a finger can move before a tap or a hold is canceled." />
                </ChipOnly>
                <ChipOnly hidden={osMode}>
                    <StepControl label="Tap time" value={tapMs} table={PAD_TAP_MS} format={(v) => `${v} ms`} onChange={(v) => setNow(PAD_TAP_MS_KEY, v)}
                        note="A tap must lift within this." />
                </ChipOnly>
                <ChipOnly hidden={osMode}>
                    <StepControl label="Hold time" value={holdMs} table={PAD_HOLD_MS} format={(v) => `${v} ms`} onChange={(v) => setNow(PAD_HOLD_MS_KEY, v)} disabled={!holdOn}
                        note={holdOn ? `Press and hold clicks after the tap time plus this: ${tapMs + holdMs} ms.` : "Press and Hold to Drag is off in Pointing Devices."} />
                </ChipOnly>
                <ChipOnly hidden={osMode}>
                    <StepControl label="Scroll start" value={scroll} table={scrollTable} format={formatMm} onChange={(v) => setNow(PAD_SCROLL_KEY, v)}
                        note="How far two fingers move, on average, before they scroll." />
                </ChipOnly>
                {palmOn && (
                    <StepControl label="Palm rejection" value={palmValue} table={palmTable} format={formatPalm} onChange={(v) => setNow(PAD_PALM_KEY, v)}
                        note="A contact larger than this, in the pad's channels, is a palm and is ignored." />
                )}
            </div>
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
                        outcomes={live[side].outcomes} fingers={live[side].fingers} touch={live[side].touch} twoTrail={live[side].twoTrail}
                        radiusOf={(area) => (r ? contactRadius(area, r) : 0)} palm={palm} />
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
