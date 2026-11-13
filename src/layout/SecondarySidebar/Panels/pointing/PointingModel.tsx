import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

import { keyboardService } from "@/services/keyboard.service";
import type { KeyboardInfo } from "@/types/keyboard.types";

import { StepControl } from "@/components/touchpad-tuning/TouchpadTuning";
import { openTouchpadTuning } from "@/components/touchpad-tuning/tuning-open";
import { openTrackballSensor } from "@/components/trackball-sensor/trackball-open";
import { useTouchpadModeChange, useWriteTouchpadMode } from "@/components/touchpad-tuning/TouchpadMode";
import { Button } from "@/components/ui/button";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { pointingMenuIndex, useMenuValues } from "@/hooks/useMenuValues";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import type { Side } from "@/utils/pointing-hardware";
import {
    AUTOMOUSE_DECAY_KEY, AUTOMOUSE_ENABLE_KEY, AUTOMOUSE_NO_TIMEOUT_KEY, AUTOMOUSE_THRESHOLD_KEY, AUTOMOUSE_TIMEOUT_KEY, AXIS_LOCK_KEY,
    dpiChoices, effectiveDpiIndex, findMenuItem, formatScrollSpeed, HAND_KEYS, hasScrollSpeed, hasTrackpointSpeed, maxDpiFor,
    NATURAL_SCROLL_KEY, pointingHands, SCROLL_SPEED_STEPS, scrollSpeedIndex, scrollSpeedPercent, type HandModel,
} from "@/utils/pointing-settings";
import { boardHasTouchpad, PAD_HOLD_KEY, PAD_HOLD_MS, PAD_HOLD_MS_KEY, PAD_TAP_KEY, PAD_TWO_FINGER_KEY, padsInTouchpadMode } from "@/utils/touchpad-taps";
import {
    formatMm, formatPalm, hasPadMode, hasPadPalm, hasPadTouch, hasPadTuning, PAD_DEAD_ZONE_DEFAULT, PAD_DEAD_ZONE_KEY, PAD_DEAD_ZONE_MM100,
    PAD_MODE_AUTO, PAD_MODE_BUILTIN, PAD_MODE_KEY, PAD_MODE_LABELS, PAD_PALM_CHANNELS, PAD_PALM_KEY, PAD_SCROLL_KEY, PAD_SCROLL_MM100,
    PAD_TAP_DEFAULT_MS, PAD_TAP_MS, PAD_TAP_MS_KEY,
} from "@/utils/touchpad-tuning";
import { onPointingAutoMouseRequest, takePointingAutoMouseRequest } from "../settings/anchor";
import { POINTING_AUTOMOUSE_ID } from "../settings/layout";
import { ChoiceRow, RangeRow, SelectRow, SliderRow, ToggleRow } from "./PointingControls";
import { AutoMouseLayersSetting } from "./AutoMouseLayers";
import { AUTOMOUSE_LAYERS_ONLY_KEY, hasAutoMouseLayers } from "@/utils/automouse-layers";

const SIDE_NAME: Record<Side, string> = { left: "Left hand", right: "Right hand" };

const SCROLL_MODE_HINT: Record<string, string> = {
    pmw3360: "Rolling the ball scrolls instead of moving the pointer",
    pmw3389: "Rolling the ball scrolls instead of moving the pointer",
    azoteq: "One finger scrolls instead of moving the pointer",
    trackpoint: "Pushing the stick scrolls instead of moving the pointer",
};

/**
 * The Pointing Devices panel's settings: one card per hand named by the module
 * detected on it (Pointer speed, Scroll speed, Scroll Mode, and for a touchpad
 * Gestures first, with the hand's tuner button), then Natural Scroll and Axis
 * Lock, shared by both hands, and a closed AutoMouse section holding its settings and keys. The
 * panel draws them in the rail and the bottom tray; the touchpad tuner modal
 * draws the touchpad's own settings. They all read one model of the board's
 * pointing menu.
 */
function useModelState() {
    const { keyboard, isConnected } = useKeyboard();
    const menuIndex = pointingMenuIndex(keyboard?.menus);
    const menu = menuIndex >= 0 ? keyboard?.menus?.[menuIndex] : undefined;
    const { values, setValue, writeError } = useMenuValues(menu);

    // A link to AutoMouse (?panel=pointing-automouse) scrolls the panel to the AutoMouse group.
    useEffect(() => {
        const show = () => requestAnimationFrame(() => document.getElementById(POINTING_AUTOMOUSE_ID)?.scrollIntoView({ block: "start" }));
        if (takePointingAutoMouseRequest()) show();
        return onPointingAutoMouseRequest(show);
    }, []);

    const flags3 = keyboard?.feature_flags3;
    const flags4 = keyboard?.feature_flags4;
    const hands = useMemo(() => pointingHands(keyboard), [keyboard]);
    const hasPad = hands.some((h) => h.module === "azoteq") || (!keyboard?.pointing_hardware && boardHasTouchpad(keyboard));
    const padsOs = padsInTouchpadMode(keyboard);
    const modeOn = hasPadMode(flags4) && !!findMenuItem(menu?.content as CustomUIMenuItem[] | undefined, PAD_MODE_KEY);
    const modeValue = values.get(PAD_MODE_KEY);

    const set = useCallback((key: string, value: number) => { void setValue(key, value); }, [setValue]);
    // The pad's values are tuned against the live view: written at once, board state, never a pending change.
    const setNow = useCallback((key: string, value: number) => { void setValue(key, value, { now: true }); }, [setValue]);
    const writeMode = useWriteTouchpadMode(setValue);
    const modeChange = useTouchpadModeChange((m) => { void writeMode(m); });

    useOsTouchpadWatch(isConnected && hasPad && hasPadMode(flags4));

    const item = useCallback((key: string) => findMenuItem((menu?.content ?? []) as CustomUIMenuItem[], key), [menu]);
    return {
        keyboard, isConnected, menu, values, writeError, flags3, flags4, hands, hasPad, padsOs, modeOn, modeValue,
        set, setNow, modeChange, item,
    };
}

/** How often the panel re-reads POINTING_HARDWARE while a touchpad hand is on screen. */
export const OS_TOUCHPAD_POLL_MS = 1500;

/** Each half's "the computer drives the touchpad" bit, as one comparable string. */
const osFlags = (kb: KeyboardInfo | null | undefined) =>
    (kb?.pointing_hardware?.halves ?? []).map((h) => `${h.side}:${h.osTouchpad ? 1 : 0}`).join(",");

/**
 * Keeps the touchpad hand's "the computer drives it" state live: while the panel shows a
 * touchpad, POINTING_HARDWARE (0x2C) is read again every OS_TOUCHPAD_POLL_MS. The computer can
 * ask for touchpad mode a moment after it connects, and the other half's bit drops for a few
 * reports while the split link catches up, so a change is applied only when two reads in a row
 * agree on it (board state, never an unsaved edit).
 */
function useOsTouchpadWatch(active: boolean) {
    const { keyboard, applyBoardState } = useKeyboard();
    // The latest board, read by each tick: the timer keeps running while the board object changes.
    const board = useRef(keyboard);
    board.current = keyboard;
    useEffect(() => {
        if (!active) return;
        let stopped = false;
        let busy = false;
        let pending: string | null = null;
        const tick = async () => {
            const kb = board.current;
            if (busy || stopped || !kb) return;
            busy = true;
            try {
                const probe: KeyboardInfo = { ...kb };
                await keyboardService.getPointingHardware(probe);
                const hw = probe.pointing_hardware;
                if (stopped || !hw) return;
                const read = osFlags(probe);
                if (read === osFlags(board.current)) { pending = null; return; }
                if (pending === read) {
                    applyBoardState((kb) => ({ ...kb, pointing_hardware: hw }));
                    pending = null;
                } else pending = read;
            } finally {
                busy = false;
            }
        };
        const timer = window.setInterval(() => { void tick(); }, OS_TOUCHPAD_POLL_MS);
        return () => { stopped = true; window.clearInterval(timer); };
    }, [active, applyBoardState]);
}

type Model = ReturnType<typeof useModelState>;
const ModelContext = createContext<Model | null>(null);

export function PointingModelProvider({ children }: { children: ReactNode }) {
    const model = useModelState();
    return <ModelContext.Provider value={model}>{children}</ModelContext.Provider>;
}

export function usePointingModel(): Model {
    const model = useContext(ModelContext);
    if (!model) throw new Error("usePointingModel needs a PointingModelProvider");
    return model;
}

/** The hands to draw, or none when the board has no pointing menu to read. */
export function useHandCards(): HandModel[] {
    const { keyboard, menu, isConnected, hands } = usePointingModel();
    return keyboard && menu && isConnected ? hands : [];
}

// ---------------------------------------------------------------- hand cards

/** The one line under Gestures while the computer drives the pad: its id, for aria-describedby. */
const osNoteId = (side: Side) => `pointing-os-note-${side}`;
export const OS_DRIVEN_NOTE = "The computer is driving this touchpad, so these settings apply only with Built-in gestures.";

function PointerSpeedRow({ hand, tray }: { hand: HandModel; tray: boolean }) {
    const { item, values, set, flags4 } = usePointingModel();
    const dpi = item(HAND_KEYS[hand.side].dpi);
    const max = maxDpiFor(hand.module, hasTrackpointSpeed(flags4));
    if (!dpi || max === undefined) return null;
    const choices = dpiChoices(dpi.options, max);
    if (!choices.length) return null;
    const hint = hand.module === "azoteq" ? `${choices[choices.length - 1].dpi} is this pad's full resolution`
        : hand.module === "trackpoint" ? "Software speed. 800 is the standard"
        : max ? `Sensor DPI, up to ${choices[choices.length - 1].dpi} on this sensor` : "Sensor DPI";
    return (
        <SelectRow
            label="Pointer speed"
            hint={tray ? undefined : hint}
            value={effectiveDpiIndex(choices, values.get(HAND_KEYS[hand.side].dpi))}
            options={choices.map((c) => ({ value: c.index, label: String(c.dpi) }))}
            onChange={(index) => set(HAND_KEYS[hand.side].dpi, index)}
            disabled={hand.osDriven}
            describedBy={osNoteId(hand.side)}
        />
    );
}

function ScrollSpeedRow({ hand, tray }: { hand: HandModel; tray: boolean }) {
    const { item, values, set, flags4 } = usePointingModel();
    const key = HAND_KEYS[hand.side].scrollSpeed;
    if (!hasScrollSpeed(flags4) || !item(key)) return null;
    const stored = values.get(key);
    const hint = hand.module === "azoteq" ? "Two-finger scrolling and Scroll Mode. Does not change with pointer speed." : "Does not change with pointer speed";
    return (
        <SliderRow
            label="Scroll speed"
            hint={tray ? undefined : hint}
            index={stored === undefined ? undefined : scrollSpeedIndex(stored)}
            max={SCROLL_SPEED_STEPS.length - 1}
            format={(i) => formatScrollSpeed(SCROLL_SPEED_STEPS[i])}
            onCommit={(i) => set(key, scrollSpeedPercent(i))}
            disabled={hand.osDriven}
            describedBy={osNoteId(hand.side)}
        />
    );
}

/** The hand's own tuner: the touchpad's settings and live pads, or the trackball sensors. A TrackPoint has none. */
function TunerButton({ hand }: { hand: HandModel }) {
    const { flags3, isConnected } = usePointingModel();
    if (hand.module === "azoteq") {
        const live = hasPadTuning(flags3) && hasPadTouch(flags3);
        return (
            <Button variant="outline" size="sm" className="self-start" onClick={openTouchpadTuning} disabled={!live || !isConnected} data-tuner="touchpad"
                title={live ? undefined : "This firmware can't show the pads live. Update it to tune them."}>
                Tune touchpad
            </Button>
        );
    }
    if (hand.module === "pmw3360" || hand.module === "pmw3389") {
        return <Button variant="outline" size="sm" className="self-start" onClick={openTrackballSensor} data-tuner="trackball">Trackball sensors</Button>;
    }
    return null;
}

export function HandCard({ hand, tray = false }: { hand: HandModel; tray?: boolean }) {
    const { item, values, set, modeOn, modeValue, modeChange } = usePointingModel();
    const scrollKey = HAND_KEYS[hand.side].scroll;
    const scrollMode = item(scrollKey)
        ? <ToggleRow label="Scroll Mode" hint={tray ? undefined : (SCROLL_MODE_HINT[hand.module ?? ""] ?? "The pointer scrolls instead of moving")} value={values.get(scrollKey)} onChange={(v) => set(scrollKey, v)}
            disabled={hand.osDriven} describedBy={osNoteId(hand.side)} />
        : null;
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-kb-gray-border p-3" data-hand={hand.side} data-module={hand.module ?? "unknown"}>
            <h5 className="flex flex-col text-sm font-semibold text-kb-ink">
                <span>{SIDE_NAME[hand.side]}</span>
                <span className="text-xs font-normal text-muted-foreground">{hand.moduleName}</span>
            </h5>
            {hand.module === "azoteq" && modeOn && (
                <ChoiceRow
                    label="Gestures"
                    hint={tray ? undefined : "Automatic lets Windows and Linux drive the pad. A Mac always uses Built-in gestures."}
                    value={modeValue}
                    choices={[PAD_MODE_AUTO, PAD_MODE_BUILTIN].map((m) => ({ value: m, label: PAD_MODE_LABELS[m] }))}
                    onChange={(m) => modeChange.change(m, modeValue ?? PAD_MODE_AUTO)}
                />
            )}
            {hand.osDriven && (
                <p id={osNoteId(hand.side)} className="px-3 text-xs text-kb-ink" data-os-driven-note>{OS_DRIVEN_NOTE}</p>
            )}
            <PointerSpeedRow hand={hand} tray={tray} />
            <ScrollSpeedRow hand={hand} tray={tray} />
            {scrollMode}
            <TunerButton hand={hand} />
        </div>
    );
}

/** Natural Scroll and Axis Lock, shared by both hands; nothing scrolls without a pointing module. */
export function SharedScrollRows() {
    const { item, values, set } = usePointingModel();
    const hands = useHandCards();
    if (!hands.length) return null;
    const toggle = (key: string, label: string, hint: string) => item(key)
        ? <ToggleRow label={label} hint={hint} value={values.get(key)} onChange={(v) => set(key, v)} />
        : null;
    return (
        <div className="flex flex-col gap-2" data-shared>
            {toggle(NATURAL_SCROLL_KEY, "Natural Scroll", "Content follows your fingers, as on a phone")}
            {toggle(AXIS_LOCK_KEY, "Axis Lock", "Scrolling holds to one direction at a time. Not on a Mac.")}
        </div>
    );
}

/** One line for a board with no pointing module on either half. */
export function NoModuleLine() {
    const { keyboard, menu, isConnected } = usePointingModel();
    if (!isConnected || !keyboard) return null;
    if (menu && pointingHands(keyboard).length) return null;
    return <p className="rounded-lg border border-dashed border-kb-gray-border px-3 py-2 text-sm text-muted-foreground" data-no-module>No pointing module detected</p>;
}

/** The touchpad mode confirmation and a failed write. */
export function ModelNotices() {
    const { modeChange, writeError } = usePointingModel();
    return (
        <>
            {modeChange.confirm}
            {writeError && <p className="text-sm text-kb-touch-cancel" role="alert" data-write-error>{writeError}</p>}
        </>
    );
}

// ---------------------------------------------------------------- AutoMouse

/**
 * The Auto Mouse settings, when a board with them is connected. MouseKeysSection draws them in its
 * AutoMouse group, under the group's heading and above the AutoMouse keys (AutoMouse Toggle, Layer Time).
 */
export function AutoMouseSettings() {
    const { item, values, set, isConnected, menu, keyboard, flags4 } = usePointingModel();
    const handsShown = useHandCards();
    if (!isConnected || !menu || !item(AUTOMOUSE_ENABLE_KEY)) return null;
    const autoOn = values.get(AUTOMOUSE_ENABLE_KEY) === 1;
    const noTimeout = values.get(AUTOMOUSE_NO_TIMEOUT_KEY);
    const toggle = (key: string, label: string, hint?: string) => item(key)
        ? <ToggleRow key={key} label={label} hint={hint} value={values.get(key)} onChange={(v) => set(key, v)} />
        : null;
    const range = (key: string, label: string, hint: string, format: (v: number) => string, scale = 1) => {
        const it = item(key);
        const [min, max, step] = (it?.options ?? []) as number[];
        if (!it || max === undefined) return null;
        return (
            <RangeRow key={key} label={label} hint={hint} value={values.get(key)} min={min ?? 0} max={max} step={step ?? 1}
                format={(v) => format(v * scale)} onCommit={(v) => set(key, v)} />
        );
    };
    return (
        <div className="flex flex-col gap-2 pb-2" data-automouse-settings>
            {toggle(AUTOMOUSE_ENABLE_KEY, "Enable Auto Mouse", "Switch to the mouse layer when a pointer moves")}
            {autoOn && keyboard && hasAutoMouseLayers(flags4) && item(AUTOMOUSE_LAYERS_ONLY_KEY) && <AutoMouseLayersSetting keyboard={keyboard} values={values} set={set} />}
            {autoOn && handsShown.map((h) => toggle(HAND_KEYS[h.side].automouse, `${h.side === "left" ? "Left" : "Right"} Pointer Activates`, "This hand switches to the mouse layer"))}
            {autoOn && toggle(AUTOMOUSE_NO_TIMEOUT_KEY, "No Layer Timeout", "The layer never returns on its own")}
            {autoOn && noTimeout === 0 && range(AUTOMOUSE_TIMEOUT_KEY, "Layer Timeout", "How long the layer stays once the pointer rests", (v) => `${v} ms`)}
            {autoOn && range(AUTOMOUSE_THRESHOLD_KEY, "Activation Threshold", "Ignores small bumps. 0 switches on any motion", String)}
            {autoOn && range(AUTOMOUSE_DECAY_KEY, "Activation Decay", "How long movement counts before it is forgotten", (v) => `${v} ms`, 10)}
        </div>
    );
}

// ---------------------------------------------------------------- touchpad settings (in the Tune touchpad modal)

/** The touchpad's taps, drag, scroll start and palm rejection, drawn in the Tune touchpad modal. */
export function TouchpadSettings() {
    const { item, values, set, setNow, flags3, flags4, hasPad, padsOs, keyboard, isConnected, menu } = usePointingModel();
    if (!keyboard || !menu || !isConnected || !hasPad) return null;
    const toggle = (key: string, label: string, hint?: string) => item(key)
        ? <ToggleRow key={key} label={label} hint={hint} value={values.get(key)} onChange={(v) => set(key, v)} />
        : null;
    const tuning = hasPadTuning(flags3);
    const builtIn = !padsOs;
    const holdOn = (values.get(PAD_HOLD_KEY) ?? 1) !== 0;
    const tapsShown = builtIn && (item(PAD_TAP_KEY) || tuning);
    const palmOn = hasPadPalm(flags4);
    const scrollStartOn = tuning && builtIn;
    const palmValue = values.get(PAD_PALM_KEY) ?? 0;
    const palmTable = (PAD_PALM_CHANNELS as readonly number[]).includes(palmValue) ? PAD_PALM_CHANNELS : [...PAD_PALM_CHANNELS, palmValue];
    const scroll = values.get(PAD_SCROLL_KEY) ?? 0;
    const scrollTable = (PAD_SCROLL_MM100 as readonly number[]).includes(scroll) ? PAD_SCROLL_MM100.slice(1) : [...PAD_SCROLL_MM100.slice(1), scroll];
    if (!tapsShown && !palmOn && !scrollStartOn) return null;
    return (
        <div className="flex shrink-0 flex-col gap-3 @container" data-touchpad-settings>
            {tapsShown && (
                <section className="flex flex-col gap-2" aria-labelledby="pad-taps-title">
                    <h3 id="pad-taps-title" className="text-sm font-semibold text-kb-ink">Taps and drag</h3>
                    {toggle(PAD_TAP_KEY, "Tap to Click")}
                    {toggle(PAD_TWO_FINGER_KEY, "Two-Finger Tap to Right Click")}
                    {toggle(PAD_HOLD_KEY, "Press and Hold to Drag")}
                    {tuning && (
                        <>
                            <StepControl label="Tap Time" value={values.get(PAD_TAP_MS_KEY) || PAD_TAP_DEFAULT_MS} table={PAD_TAP_MS} format={(v) => `${v} ms`}
                                onChange={(v) => setNow(PAD_TAP_MS_KEY, v)} note="Lift within this to tap" />
                            <StepControl label="Hold Time" value={values.get(PAD_HOLD_MS_KEY) || PAD_HOLD_MS[0]} table={PAD_HOLD_MS} format={(v) => `${v} ms`}
                                onChange={(v) => setNow(PAD_HOLD_MS_KEY, v)} disabled={!holdOn}
                                note={holdOn ? "Hold still this much longer to start a drag" : "Press and Hold to Drag is off"} />
                            <StepControl label="Dead Zone" value={values.get(PAD_DEAD_ZONE_KEY) || PAD_DEAD_ZONE_DEFAULT} table={PAD_DEAD_ZONE_MM100} format={formatMm}
                                onChange={(v) => setNow(PAD_DEAD_ZONE_KEY, v)} note="How far a finger can move and still tap or hold" />
                        </>
                    )}
                </section>
            )}
            {(palmOn || scrollStartOn) && (
                <section className="flex flex-col gap-2" aria-labelledby="pad-scrolling-title">
                    <h3 id="pad-scrolling-title" className="text-sm font-semibold text-kb-ink">Scrolling and palm rejection</h3>
                    {scrollStartOn && (
                        <StepControl label="Scroll Start" value={scroll} table={scrollTable} format={formatMm} onChange={(v) => setNow(PAD_SCROLL_KEY, v)}
                            note="How far two fingers move before they scroll" />
                    )}
                    {palmOn && (
                        <StepControl label="Palm Rejection" value={palmValue} table={palmTable} format={formatPalm} onChange={(v) => setNow(PAD_PALM_KEY, v)}
                            note="Ignores a contact wider than this" />
                    )}
                </section>
            )}
        </div>
    );
}
