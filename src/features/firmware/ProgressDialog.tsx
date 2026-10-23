// The update as it runs (update-flow 5), every screen from the flow's state:
// "Confirm on your keyboard" only while the board waits for the key press after ARM,
// otherwise "Updating your keyboard" with one bar, the stage now, and the time left.

import { useEffect, useState } from "react";

import type { FlowState, Step } from "@/services/updater/flow";
import { handName, otherHand } from "@/services/updater/protocol";
import { ChordDiagram } from "./ChordDiagram";
import { FwTitle, Spinner } from "./parts";

/** Seconds the board waits for the key press (the flow allows a little more for the round trips). */
export const CONFIRM_SECONDS = 30;

/** The keyboard is waiting for the key press now. */
export const awaitingConfirm = (s: FlowState) => s.phase === "running" && s.step === "approve";

export function confirmSecondsLeft(s: FlowState, now: number): number {
    return s.approveAt === null ? CONFIRM_SECONDS : Math.min(CONFIRM_SECONDS, Math.max(0, CONFIRM_SECONDS - Math.floor((now - s.approveAt) / 1000)));
}

/** The keys to press, which half, and why. */
export function ConfirmView({ state, legends, now }: { state: FlowState; legends: [string, string]; now: number }) {
    const usb = state.usbHand;
    const left = confirmSecondsLeft(state, now);
    return (
        <div className="flex flex-col gap-4" data-testid="update-confirm">
            <FwTitle sub="Firmware only changes when someone at the keyboard says so.">Confirm on your keyboard</FwTitle>
            <ChordDiagram hand={usb} legends={legends} />
            <p className="text-sm">
                On the {handName(usb)} half, press <strong>{legends[0]}</strong> and <strong>{legends[1]}</strong> together and hold them for a second.
                The light on that half is blinking blue now, and flashes white when it's done.
            </p>
            <p className="text-sm text-muted-foreground tabular-nums" aria-live="off">{left === 1 ? "1 second left" : `${left} seconds left`}</p>
        </div>
    );
}

/** Where each step sits on the one bar, as [start, end] of 0..1, for an update of both halves. */
const SPAN_BOTH: Partial<Record<Step, [number, number]>> = {
    start: [0, 0.02], approve: [0.02, 0.02], "other-erase": [0.02, 0.08], "other-send": [0.08, 0.3], "other-verify": [0.3, 0.33],
    relay: [0.33, 0.58], "other-install": [0.58, 0.62], "other-restart": [0.62, 0.65], "self-arm": [0.65, 0.66],
    "self-erase": [0.66, 0.7], "self-send": [0.7, 0.84], "self-verify": [0.84, 0.86], "self-install": [0.86, 0.89],
    reconnect: [0.89, 0.93], "check-halves": [0.93, 0.95], "settings-reset": [0.95, 0.98], restore: [0.95, 0.99], done: [1, 1],
};
/** One half: the other half's steps, or the half with USB's, stretched over the bar. */
const SPAN_OTHER: Partial<Record<Step, [number, number]>> = {
    start: [0, 0.03], approve: [0.03, 0.03], "other-erase": [0.03, 0.12], "other-send": [0.12, 0.45], "other-verify": [0.45, 0.5],
    relay: [0.5, 0.85], "other-install": [0.85, 0.9], "other-restart": [0.9, 0.94], "check-halves": [0.94, 0.96], "settings-reset": [0.96, 0.98], restore: [0.96, 0.99], done: [1, 1],
};
const SPAN_USB: Partial<Record<Step, [number, number]>> = {
    start: [0, 0.03], approve: [0.03, 0.03], "self-arm": [0.03, 0.05], "self-erase": [0.05, 0.15], "self-send": [0.15, 0.6], "self-verify": [0.6, 0.65],
    "self-install": [0.65, 0.72], reconnect: [0.72, 0.85], "check-halves": [0.85, 0.9], "settings-reset": [0.9, 0.95], restore: [0.9, 0.98], done: [1, 1],
};

/** The one bar: how far the update is, 0..1, from the step and that step's own progress. */
export function overallProgress(s: FlowState): number {
    const spans = s.target === "both" ? SPAN_BOTH : s.target === s.usbHand ? SPAN_USB : SPAN_OTHER;
    const span = spans[s.step];
    if (!span) return s.phase === "result" ? 1 : 0;
    const moving = s.step.startsWith("other") || s.step === "relay" ? otherHand(s.usbHand) : s.usbHand;
    const p = s.rows.find((r) => r.hand === moving)?.progress;
    const within = typeof p === "number" && /erase|send|relay/.test(s.step) ? Math.min(1, Math.max(0, p)) : 0;
    return span[0] + (span[1] - span[0]) * within;
}

/** The stage now, in one line. */
export function stageLine(s: FlowState): string {
    const o = handName(otherHand(s.usbHand));
    const u = handName(s.usbHand);
    switch (s.step) {
        case "start": case "approve": case "self-arm": return "Getting ready";
        case "other-erase": return `Preparing the ${o} half`;
        case "other-send": return `Sending the firmware for the ${o} half`;
        case "other-verify": return `Checking the ${o} half's firmware`;
        case "relay": return `Copying it to the ${o} half. Don't type on that half until it's done.`;
        case "other-install": return `Installing on the ${o} half`;
        case "other-restart": return s.target === "both" ? `The ${o} half is restarting. The light on the ${u} half stays red until it's updated too.` : `The ${o} half is restarting`;
        case "self-erase": return `Preparing the ${u} half`;
        case "self-send": return `Sending the firmware for the ${u} half`;
        case "self-verify": return `Checking the ${u} half's firmware`;
        case "self-install": return `Installing on the ${u} half`;
        case "reconnect": return `The ${u} half is restarting`;
        case "check-halves": return "Checking both halves";
        case "settings-reset": return s.afterwards === "blank" ? "Clearing every key" : "Setting up the default layout";
        case "restore": return "Putting your layout back";
        default: return "Finishing";
    }
}

const REMAINING_S: Partial<Record<Step, number>> = {
    start: 110, approve: 100, "other-erase": 95, "other-send": 85, "other-verify": 78, relay: 70, "other-install": 55,
    "other-restart": 50, "self-arm": 45, "self-erase": 44, "self-send": 38, "self-verify": 30, "self-install": 28,
    reconnect: 25, "check-halves": 15, "settings-reset": 15, restore: 10,
};

/** About how long is left. */
export function timeLeft(s: FlowState, now: number): string {
    const left = REMAINING_S[s.step];
    if (left === undefined) return "";
    const share = s.target === "both" ? 1 : 0.55;
    const secs = Math.max(5, Math.round(left * share - (now - s.stepAt) / 1000));
    if (secs >= 90) return `About ${Math.round(secs / 60)} minutes left`;
    if (secs >= 45) return "About a minute left";
    return "Less than a minute left";
}

export function useTicker(now: () => number, ms = 250): number {
    const [t, setT] = useState(now);
    useEffect(() => {
        const id = setInterval(() => setT(now()), ms);
        return () => clearInterval(id);
    }, [now, ms]);
    return t;
}

export function ProgressView({ state, now }: { state: FlowState; now: number }) {
    const pct = Math.round(overallProgress(state) * 100);
    return (
        <div className="flex flex-col gap-4" data-testid="update-progress" data-step={state.step}>
            <FwTitle sub="Keep the keyboard plugged in, and keep the cable between the halves connected.">Updating your keyboard</FwTitle>
            <div className="flex flex-col gap-3">
                <div className="h-2 w-full overflow-hidden rounded-full bg-kb-gray-medium" role="progressbar" aria-label="Update progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                    <div className="h-full rounded-full bg-kb-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
                </div>
                <p className="flex items-center gap-3 text-sm" aria-live="polite" data-testid="update-stage"><Spinner />{stageLine(state)}</p>
                <p className="min-h-5 text-sm text-muted-foreground tabular-nums">{timeLeft(state, now)}</p>
            </div>
        </div>
    );
}
