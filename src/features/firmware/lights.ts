// What each half's light does at each step, from the firmware (update-flow 5.3, tech doc 1.10).
// Derived from the flow state, never read from the board.

import type { FlowState, Stage } from "@/services/updater/flow";
import type { Hand } from "@/services/updater/protocol";

export type LightPattern =
    /** The user's layer color: nothing updater-related. */
    | "layer"
    /** Firmware default color after a restart (layer 0 green). */
    | "default"
    /** Blue, blinking twice a second: hold the chord now. */
    | "blue-blink"
    /** The rainbow: one slow continuous hue cycle, "busy". */
    | "rainbow"
    /** Steady magenta: installing, don't unplug. */
    | "magenta"
    /** Red, blinking once a second: the halves differ (expected between the halves). */
    | "red-slow"
    | "off";

export const LIGHT_LABEL: Record<LightPattern, string> = {
    layer: "Layer color",
    default: "Default color",
    "blue-blink": "Blue, blinking",
    rainbow: "Rainbow",
    magenta: "Magenta, steady",
    "red-slow": "Red, blinking slowly",
    off: "Off",
};

/** The light on one half now. */
export function lightFor(state: FlowState, hand: Hand, now: number): LightPattern {
    const usb = state.usbHand;
    const isUsb = hand === usb;
    const since = now - state.stepAt;
    const pair = state.target === "both";
    switch (state.step) {
        case "start":
            return "layer";
        case "approve":
            return isUsb ? "blue-blink" : "layer";
        case "other-erase":
        case "other-send":
        case "other-verify":
            return isUsb ? "rainbow" : "layer";
        case "relay":
            return "rainbow";
        case "other-install":
            return "magenta"; // both halves, although only the other half writes
        case "other-restart":
            // The half with USB waits for a match: red until it's updated too (expected).
            return isUsb ? "red-slow" : "default";
        case "self-arm":
            return isUsb ? (pair ? "red-slow" : "layer") : pair ? "default" : "layer";
        case "self-erase":
        case "self-send":
        case "self-verify":
            return isUsb ? "rainbow" : pair ? "default" : "layer";
        case "self-install":
            return isUsb ? "magenta" : pair ? "default" : "layer";
        case "reconnect":
        case "settings-reset":
            return isUsb ? (since < 1500 ? "off" : "default") : "default";
        case "sides":
            // A half without a side, or two on the same side, shows the default color and doesn't type.
            return "default";
        case "check-halves":
            return state.committed.includes(hand) ? "default" : "layer";
        case "restore":
        case "done":
            return state.afterwards === "restore" ? "layer" : "default";
        case "failed":
            return "layer";
    }
}

/** Row labels (update-flow 5.1). */
export function stageLabel(stage: Stage, progress: number | null, otherName: string): string {
    const pct = progress === null ? "" : ` ${Math.round(progress * 100)}%`;
    switch (stage) {
        case "waiting": return "Waiting";
        case "approve": return "Approve";
        case "preparing": return "Preparing";
        case "sending": return `Sending${pct}`;
        case "checking": return "Checking";
        case "copying": return `Copying to ${otherName}${pct}`;
        case "installing": return "Installing";
        case "restarting": return "Restarting";
        case "reconnecting": return "Reconnecting";
        case "checking-halves": return "Checking both halves";
        case "checking-sides": return "Checking which half is which";
        case "restoring": return "Putting your layout back";
        case "done": return "Done";
        case "stopped": return "Stopped";
    }
}
