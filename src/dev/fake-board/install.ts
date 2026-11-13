// Starts the simulated Svalboard for ?fakeBoard (see start.ts) and labels the
// page so nobody mistakes it for a real board.
import type { FakeBoardChoice } from "@/lib/deepLinks";
import { FAKE_BOARD_PRODUCT_NAME, FakeSvalboardDevice } from "./device";

declare global {
    interface Window {
        /** The simulated board, for tests and the console. */
        keybardFakeBoard?: { device: FakeSvalboardDevice; wipe: () => void; addOtherBoard: () => FakeSvalboardDevice; firmwareHost?: unknown };
    }
}

function showBadge(choice: FakeBoardChoice, wipe: () => void) {
    const badge = document.createElement("div");
    badge.setAttribute("role", "status");
    badge.dataset.fakeBoardBadge = choice;
    badge.className = "fixed bottom-2 right-2 z-[1000] flex items-center gap-2 rounded-full border border-kb-gray-border bg-kb-warn-bg px-3 py-1 text-xs font-medium text-kb-warn-ink shadow-sm";
    const label = document.createElement("span");
    label.textContent = choice === "old" ? `${FAKE_BOARD_PRODUCT_NAME}, firmware without combo names`
        : choice === "no-pause" ? `${FAKE_BOARD_PRODUCT_NAME}, firmware that can't pause typing`
        : choice === "turbo6" ? `${FAKE_BOARD_PRODUCT_NAME}, updated from turbo 6`
        : choice === "leader0" ? `${FAKE_BOARD_PRODUCT_NAME}, leader timeout stored as 0`
        : choice === "touchpad" ? `${FAKE_BOARD_PRODUCT_NAME}, touchpads`
        : choice === "touchpad-gestures" ? `${FAKE_BOARD_PRODUCT_NAME}, touchpads on built-in gestures`
        : choice === "pointing" ? `${FAKE_BOARD_PRODUCT_NAME}, left trackball and right touchpad`
        : choice === "pointing-os" ? `${FAKE_BOARD_PRODUCT_NAME}, left trackball and right touchpad, driven by the computer`
        : choice === "two-balls" ? `${FAKE_BOARD_PRODUCT_NAME}, a trackball on each half`
        : choice === "ball-trackpoint" ? `${FAKE_BOARD_PRODUCT_NAME}, left trackball and right TrackPoint`
        : choice === "no-module" ? `${FAKE_BOARD_PRODUCT_NAME}, no pointing module`
        : choice === "touchpad-434" ? `${FAKE_BOARD_PRODUCT_NAME}, touchpads, v4.3.4 firmware`
        : choice === "altrepeat" ? `${FAKE_BOARD_PRODUCT_NAME}, one Alt-Repeat entry`
        : choice === "legends" ? `${FAKE_BOARD_PRODUCT_NAME}, legend samples`
        : choice === "unread" ? `${FAKE_BOARD_PRODUCT_NAME}, some reads unanswered` : FAKE_BOARD_PRODUCT_NAME;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset";
    reset.title = "Put the simulated board back to its starting settings";
    reset.className = "cursor-pointer underline underline-offset-2 text-kb-warn-ink";
    reset.addEventListener("click", () => {
        if (window.confirm("Put the simulated board back to its starting settings? Its changes are lost.")) wipe();
    });
    badge.append(label, reset);
    const mount = () => document.body.appendChild(badge);
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

export function installFakeBoard(choice: FakeBoardChoice): HIDDevice {
    // "old" predates both combo names and the typing pause.
    // This firmware has 64-byte reports, the typing pause, the flicker latch and the debounce switch; the older choices have none of them.
    // "turbo6" is this firmware too, on a board that ran turbo 6 with both scan waits at 0 before it.
    // "leader0" is this firmware with the leader timeout of 0 that older firmware's settings reset stored.
    // "touchpad" is this firmware with an Azoteq touchpad on each half, and a computer that asks
    // for touchpad mode (Input Mode 3) as Windows and Linux do; "touchpad-gestures" the same
    // board where it never asks (a Mac), so the pads run their built-in gestures.
    // "touchpad-434" is v4.3.4's firmware on that board: the touch page only.
    // "pointing" is a trackball on the left and a touchpad on the right, on a Mac; "pointing-os" the
    // same board on a computer that asks for touchpad mode (Windows or Linux in Automatic).
    const pointing = choice === "pointing" || choice === "pointing-os";
    const pads = choice === "touchpad" || choice === "touchpad-gestures" || choice === "touchpad-434" || pointing;
    // "unread" is this firmware on a board that doesn't answer the QMK settings, two custom
    // values, and holds a tap dance with a term of 0.
    const current = choice === "combo-names" || choice === "turbo6" || choice === "leader0" || choice === "unread" || choice === "legends" || choice === "altrepeat" || choice === "two-balls" || choice === "ball-trackpoint" || choice === "no-module" || pads;
    const modules = choice === "two-balls" ? { left: "pmw3389", right: "pmw3389" } as const
        : choice === "ball-trackpoint" ? { left: "pmw3389", right: "trackpoint" } as const : undefined;
    // The debug console command (0x3E) came after v4.3.4.
    const device = new FakeSvalboardDevice({ comboLabels: choice !== "old", typingPause: current, flickerLatch: current,
        debugConsole: current && choice !== "touchpad-434", debounceSwitch: current,
        timingUsOnly: current, seedTurbo: choice === "turbo6" ? 6 : undefined, seedLeaderZero: choice === "leader0", seedUnread: choice === "unread", seedLegends: choice === "legends", seedAltRepeat: choice === "altrepeat", reportLength: current ? 64 : 32,
        padGestures: current, scrollSpeed: current && choice !== "touchpad-434", autoMouseLayers: current && choice !== "touchpad-434", leftTrackball: pointing, touchpad: pads, modules, hostTouchpad: choice === "touchpad" || choice === "touchpad-434" || choice === "pointing-os", multiFinger: choice !== "touchpad-434" });
    const wipe = () => {
        device.forgetSettings();
        window.location.reload();
    };
    // A second permitted board, plugged in before this one: getDevices() lists it first.
    const addOtherBoard = () => {
        const other = new FakeSvalboardDevice({ persist: false, serial: [0x0e, 0x7e, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc], reportLength: current ? 64 : 32 });
        (navigator as Navigator & { hid?: { others?: HIDDevice[] } }).hid?.others?.unshift(other.asHIDDevice());
        return other;
    };
    window.keybardFakeBoard = { device, wipe, addOtherBoard };
    showBadge(choice, wipe);
    console.info(`[fake board] ${FAKE_BOARD_PRODUCT_NAME} (${choice === "old" ? "firmware without combo names" : choice === "no-pause" ? "firmware that can't pause typing" : "combo names on the board"}) in place of WebHID.`);
    return device.asHIDDevice();
}
