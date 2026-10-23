// What the Firmware page shows under "This keyboard", read from the updater.

import { describeFirmware, identifyFirmwareRelease } from "@/constants/firmware";
import type { KeyboardInfo } from "@/types/keyboard.types";
import { UpdaterClient } from "@/services/updater/client";
import { OTHER_HALF_WAIT_MS } from "@/services/updater/checks";
import { HAND_SELF, Presence, UPDATER_PROTOCOL, otherHand, type Hand } from "@/services/updater/protocol";
import { DisconnectedError, realClock, type Clock, type UpdaterTransport } from "@/services/updater/transport";
import type { SideHost } from "@/services/side-host";
import { assessSides, sidesSettling, type SideAssessment } from "@/services/side-decision";

export interface HalfSummary {
    hand: Hand;
    usb: boolean;
    /** The release tag, or "build <n>" for the half without USB when it differs. */
    tag: string;
    fwVersion: number;
    answered: boolean;
}

export interface BoardSummary {
    /** The board runs an updater this Keybard installs through (protocol 4). */
    updater: boolean;
    /**
     * The board didn't answer the updater (after a few tries): Keybard can't tell what it
     * runs. Not legacy: only a board that answers as protocol 3 or older is sent to Install by hand.
     */
    unread?: boolean;
    /** For boards without one: what they run, as far as Keybard can tell. */
    legacyLabel: string | null;
    usbHand: Hand;
    halves: HalfSummary[];
    /** Presence or INFO bit5 say the halves run different firmware (F9 / Q17). */
    differ: boolean;
    noChord: boolean;
    fwVersion: number;
    tag: string;
    /** One-image firmware: which half is which (null: a per-hand build, or not read). */
    sides?: SideAssessment | null;
}

export { OTHER_HALF_WAIT_MS };

/**
 * SIDE on one-image firmware; null on a per-hand build. Waits out "not reported yet" (the
 * other half reports once the split link is up, up to OTHER_HALF_WAIT_MS after a boot).
 */
export async function readSides(sides: SideHost | undefined, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = OTHER_HALF_WAIT_MS): Promise<SideAssessment | null> {
    if (!sides || !(await sides.supported())) return null;
    let a = assessSides(true, await sides.read());
    for (let waited = 0; waited < waitMs && sidesSettling(a); waited += 250) {
        await sleep(250);
        a = assessSides(true, await sides.read());
    }
    return a;
}

/**
 * What an updater build calls itself: its version string (the release tag release CI
 * builds it with), or its numeric version when the string is empty (a local build).
 */
export function updaterVersionLabel(versionString: string, fwVersion: number): string {
    const text = versionString.trim();
    return text || `fw version ${fwVersion}`;
}

/** The waits before each retry of a read the board didn't answer: 3 tries, 1.5 s of waiting in all. */
export const BOARD_READ_RETRY_MS = [500, 1000];

export interface BoardReadOptions {
    /** Waits between tries; [] tries once. */
    retryMs?: number[];
    /** The clock the waits run on (the mock board's, in the harness and tests). */
    clock?: Pick<Clock, "now" | "sleep">;
    /** How long to wait for the other half to answer (OTHER_HALF_WAIT_MS). */
    otherWaitMs?: number;
}

function legacySummary(keyboard?: KeyboardInfo | null): BoardSummary {
    return {
        updater: false, legacyLabel: keyboard ? describeFirmware(keyboard) : null, usbHand: 1, halves: [], differ: false,
        noChord: false, fwVersion: 0, tag: keyboard ? describeFirmware(keyboard) ?? "" : "",
    };
}

/** The board didn't answer: Keybard can't tell what it runs. */
export function unreadSummary(): BoardSummary {
    return { updater: false, unread: true, legacyLabel: null, usbHand: 1, halves: [], differ: false, noChord: false, fwVersion: 0, tag: "" };
}

/**
 * Read the board's firmware state. A board that answers as an updater Keybard doesn't
 * install through (protocol 3, or an older build that echoes the request back) reads as
 * legacy. A board that doesn't answer is tried again a few times (it may still be starting
 * after a restart, or another app may be talking to it), then reads as unread, never as
 * legacy, unless what it reported on connecting already shows it predates the updater.
 */
export async function readBoardSummary(transport: UpdaterTransport, keyboard?: KeyboardInfo | null, sideHost?: SideHost, o: BoardReadOptions = {}): Promise<BoardSummary> {
    const retryMs = o.retryMs ?? BOARD_READ_RETRY_MS;
    const clock = o.clock ?? realClock;
    const sleep = (ms: number) => clock.sleep(ms);
    for (let attempt = 0; ; attempt++) {
        try {
            return await readBoardOnce(transport, keyboard, sideHost, clock, o.otherWaitMs ?? OTHER_HALF_WAIT_MS);
        } catch (error) {
            const gone = error instanceof DisconnectedError || !transport.connected();
            if (gone || attempt >= retryMs.length) break;
            await sleep(retryMs[attempt]);
        }
    }
    // Releases before the updater (vRC0 to vLaunch) are told apart by their GET_INFO alone.
    if (keyboard && identifyFirmwareRelease(keyboard)?.outdated) return legacySummary(keyboard);
    return unreadSummary();
}

/** One read; throws when the board doesn't answer INFO, INFO page 1 or STATUS. */
async function readBoardOnce(transport: UpdaterTransport, keyboard: KeyboardInfo | null | undefined, sideHost: SideHost | undefined, clock: Pick<Clock, "now" | "sleep">, otherWaitMs: number): Promise<BoardSummary> {
    const legacy = () => legacySummary(keyboard);
    const c = new UpdaterClient(transport);
    let usb = await c.info(HAND_SELF);
    const sides = await readSides(sideHost, (ms) => clock.sleep(ms), otherWaitMs).catch(() => null);
    if (usb.protocol === UPDATER_PROTOCOL && usb.hand === HAND_SELF) {
        // One-image firmware on a half with no side yet: it answers as hand 0xFF. Show the fix, no halves.
        return {
            updater: true, legacyLabel: null, usbHand: 1, halves: [], differ: false, noChord: usb.noChord, fwVersion: usb.fwVersion,
            tag: (await c.info1().catch(() => null))?.tag ?? "", sides: sides ?? { kind: "unknown", halves: ["usb"], usb: "unknown", other: null, guess: {} },
        };
    }
    if (usb.protocol !== UPDATER_PROTOCOL || (usb.hand !== 0 && usb.hand !== 1)) {
        // An updater Keybard doesn't install through (protocol 3, vNext1 and x3.x): name what it
        // runs from INFO page 1, which every updater protocol answers.
        const label = await c.info1().then((p) => updaterVersionLabel(p.tag, p.fwVersion || usb.fwVersion)).catch(() => updaterVersionLabel("", usb.fwVersion));
        return { ...legacy(), legacyLabel: label, tag: label, fwVersion: usb.fwVersion, usbHand: usb.hand === 0 ? 0 : 1 };
    }
    const usbHand = usb.hand as Hand;
    const tag = updaterVersionLabel((await c.info1()).tag, usb.fwVersion);
    // The other half: just after a restart the split link isn't up yet (presence NONE, no
    // answer). Wait for it before saying it didn't answer.
    const deadline = clock.now() + otherWaitMs;
    let status = await c.status(usbHand);
    let o = await c.info(otherHand(usbHand)).catch(() => null);
    // Presence VERSION while both answer the same version is the link still settling, too.
    const settling = () => !o?.answered || status.presence === Presence.NONE || (status.presence === Presence.VERSION && o.fwVersion === usb.fwVersion);
    let waited = false;
    while (settling() && clock.now() < deadline) {
        await clock.sleep(500);
        waited = true;
        status = await c.status(usbHand);
        o = await c.info(otherHand(usbHand)).catch(() => null);
    }
    // Its flags (the other half differs) as of now, after the wait.
    if (waited) usb = await c.info(HAND_SELF).catch(() => usb);
    const halves: HalfSummary[] = [
        { hand: usbHand, usb: true, tag, fwVersion: usb.fwVersion, answered: true },
    ];
    if (o?.answered) {
        halves.push({ hand: otherHand(usbHand), usb: false, tag: o.fwVersion === usb.fwVersion ? tag : `build ${o.fwVersion}`, fwVersion: o.fwVersion, answered: true });
    } else {
        halves.push({ hand: otherHand(usbHand), usb: false, tag: "", fwVersion: 0, answered: false });
    }
    // On one-image firmware, two halves on one side (SAME_HAND) is a side to set, not firmware to finish.
    const sideTrouble = !!sides && (sides.kind === "same" || sides.kind === "unknown");
    const differ = usb.otherDiffers || status.presence === Presence.VERSION || (!sideTrouble && (status.presence === Presence.SAME_HAND || status.presence === Presence.INVALID));
    halves.sort((a, b) => a.hand - b.hand);
    return { updater: true, legacyLabel: null, usbHand, halves, differ, noChord: usb.noChord, fwVersion: usb.fwVersion, tag, sides };
}
