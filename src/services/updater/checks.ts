// The checks the update sheet (B1) runs before Start: what the board runs, which
// file goes to which half, the warnings (update-flow 4.2) and the one refusal.
// Gentle: hardware mismatches warn and the button reads "Update anyway"; only a
// carried file that misses its pin, or a file a half would refuse, stops the install.

import { matchPin, type FirmwareReleasePin } from "@/constants/firmware-releases";
import { UpdaterClient, UpdaterStatusError } from "./client";
import {
    HAND_EITHER, HAND_SELF, POINTING_AUTO, POINTING_NAMES, Presence, State, Status, UPDATER_PROTOCOL, handName, otherHand,
    statusName, type Hand, type Info0, type Info1, type StatusReply,
} from "./protocol";
import type { SvupFile } from "./svup";
import { ReplyTimeoutError, type Clock } from "./transport";
import type { SideHost } from "../side-host";
import { assessSides, knownSidesFrom, sidesSettling, sidesSound, type KnownSides, type SideAssessment } from "../side-decision";

/**
 * How long a read waits for the other half after the half with USB answers: the split link
 * comes up about 6 s after a boot on the mule, and twice that is the worst case.
 */
export const OTHER_HALF_WAIT_MS = 12_000;

export type CheckState = "pending" | "ok" | "warn" | "refuse";

export interface CheckRow {
    id: string;
    label: string;
    state: CheckState;
    detail?: string;
}

/** The install as the user picked it on the Firmware page. */
export type InstallSource =
    | { kind: "release"; release: FirmwareReleasePin; files: Partial<Record<Hand, SvupFile>> }
    | { kind: "file"; files: SvupFile[] };

export type InstallKind = "update" | "reinstall" | "install" | "custom";

export type Target = "both" | Hand;

export interface BoardState {
    usb: Info0;
    usbTag: string;
    other: Info0 | null;
    status: StatusReply;
    /** INFO page 0 flags bit7 on the half with USB (F-N1). */
    noChord: boolean;
}

/** A stop before the sheet can offer Start (update-flow 8). */
export type PreFailure =
    | { id: "F3" | "F17" | "F18" | "unsupported"; detail?: string }
    /** One-image firmware: a half has no side, or both claim the same one. Set it first. */
    | { id: "sides"; sides: SideAssessment; detail?: string };

export interface Plan {
    board: BoardState;
    target: Target;
    files: Partial<Record<Hand, SvupFile>>;
    kind: InstallKind;
    /** The release being installed: a tag, or the file's own version string. */
    toTag: string;
    fromTag: string;
    title: string;
    checks: CheckRow[];
    warnings: CheckRow[];
    refusal: CheckRow | null;
    /** The other half didn't answer: offer the half with USB only. */
    otherSilent: boolean;
    pinned: boolean;
    /** Each half's side before the install, to compare with after it (one-image firmware). */
    sidesBefore: KnownSides;
    /** Every file is the one image for both halves. */
    oneImage: boolean;
    /** sidesBefore came from SIDE (true), or from a per-hand build's updater hand (false). */
    sidesFromSide: boolean;
}

export interface CheckOptions {
    clock: Clock;
    /** The user chose one half (Advanced, or Finish update). */
    onlyHand?: Hand;
    /** Sval protocol this Keybard speaks (K18). */
    maxSvalProtocol?: number;
    releases?: FirmwareReleasePin[];
    /** Extra rows from the host: Keybard Overlay paused, Scan Lab closed, device access. */
    hostRows?: CheckRow[];
    /** SIDE (0x33), read first on one-image firmware. */
    sides?: SideHost;
}

/** "it's too large for this keyboard" as a sentence. */
const sentence = (why: string) => `${why[0].toUpperCase()}${why.slice(1)}.`;

/** Read what the board runs: INFO of both halves, the tag, presence. ABORTs a latched error first. */
export async function readBoard(client: UpdaterClient, clock: Clock): Promise<BoardState | PreFailure> {
    // A board just connected or restarted may not answer yet: a few tries before giving up.
    const info = async () => {
        for (const wait of [500, 1000]) {
            try {
                return await client.info(HAND_SELF);
            } catch (error) {
                if (!(error instanceof ReplyTimeoutError)) throw error;
                await clock.sleep(wait);
            }
        }
        return client.info(HAND_SELF);
    };
    let usb = await info();
    if (usb.protocol !== UPDATER_PROTOCOL) return { id: "unsupported", detail: `updater protocol ${usb.protocol}` };
    if (!usb.flash16MiB) return { id: "F18" };
    if (usb.writesFailing) return { id: "F17" };
    if (usb.state === State.ERROR) {
        // A tab that died mid-session left an error latched: anyone may clear it.
        await client.abort(usb.hand);
        usb = await client.info(HAND_SELF);
    }
    // Busy for a moment (a session another tab is ending): wait it out before saying so.
    for (const busyUntil = clock.now() + 3000; usb.state !== State.IDLE && clock.now() < busyUntil;) {
        await clock.sleep(500);
        usb = await info();
    }
    if (usb.state !== State.IDLE) return { id: "F3", detail: `the updater is busy (${usb.state})` };
    const page1: Info1 = await client.info1();
    const hand = usb.hand as Hand;
    let status = await client.status(hand);
    // The split link comes up a while after a boot: wait for it before calling the other half silent.
    const deadline = clock.now() + OTHER_HALF_WAIT_MS;
    while (status.presence === Presence.NONE && clock.now() < deadline) {
        await clock.sleep(250);
        status = await client.status(hand);
    }
    let other: Info0 | null = null;
    if (status.presence === Presence.MATCH || status.presence === Presence.VERSION) {
        const o = await client.info(otherHand(hand));
        other = o.answered ? o : null;
    }
    return { usb, usbTag: page1.tag, other, status, noChord: usb.noChord };
}

/** Why a half would refuse this file, as far as its INFO shows (null: none seen). */
export function refusalFor(file: SvupFile, half: Info0, isOther: boolean): string | null {
    const m = file.manifest;
    // The half without USB may run protocol 3 or 4 (the relay is unchanged); never 2.
    const ok = isOther ? [3, UPDATER_PROTOCOL] : [UPDATER_PROTOCOL];
    if (!ok.includes(half.protocol)) return `it speaks updater protocol ${half.protocol}`;
    // A no-chord or kept-settings build (D43, D45) is a developer file even if it was packed
    // without DIAGNOSTIC: a release half refuses its image with BAD_IMAGE after the chord.
    if (half.releaseBuild && (m.diagnostic || file.noChord || file.keepSettings)) return "it's a developer file and this keyboard runs a release";
    if (m.securityEpoch < half.securityEpoch) return "it's older than this keyboard allows";
    if (m.storageFormat < half.storageFormat) return "its layout format is older than this keyboard's";
    if (m.imageLen > half.maxImage) return "it's too large for this keyboard";
    if (!file.imageHashOk) return "the file is damaged";
    return null;
}

function assignFiles(source: InstallSource): { files: Partial<Record<Hand, SvupFile>>; problems: CheckRow[] } {
    if (source.kind === "release") return { files: source.files, problems: [] };
    const files: Partial<Record<Hand, SvupFile>> = {};
    const problems: CheckRow[] = [];
    // The one image (hand 2) serves both halves.
    const either = source.files.filter((f) => f.manifest.hand === HAND_EITHER);
    if (either.length) {
        if (source.files.length > 1) problems.push({ id: "file-twice", label: "This file is for both halves.", state: "refuse", detail: "Choose it on its own." });
        return { files: { 0: either[0], 1: either[0] }, problems };
    }
    for (const f of source.files) {
        const h = f.manifest.hand === 0 || f.manifest.hand === 1 ? (f.manifest.hand as Hand) : null;
        if (h === null) problems.push({ id: "file-hand", label: "This file doesn't say which half it's for.", state: "refuse", detail: "Choose a Svalboard firmware file." });
        else if (files[h]) problems.push({ id: "file-twice", label: `There are two files for the ${handName(h)} half.`, state: "refuse", detail: "Choose one file per half." });
        else files[h] = f;
    }
    return { files, problems };
}

function kindFor(board: BoardState, file: SvupFile, pinned: boolean): InstallKind {
    if (!pinned) return "custom";
    if (file.manifest.fwVersion === board.usb.fwVersion && file.manifest.tag === board.usbTag) return "reinstall";
    return file.manifest.fwVersion > board.usb.fwVersion ? "update" : "install";
}

export function titleFor(kind: InstallKind, tag: string): string {
    switch (kind) {
        case "update": return `Update to ${tag}`;
        case "reinstall": return `Reinstall ${tag}`;
        case "install": return `Install ${tag}`;
        default: return "Install custom firmware";
    }
}

/** Every check of tech doc 2.1 and update-flow 4.1-4.2, against the board as it is now. */
export async function planInstall(client: UpdaterClient, source: InstallSource, o: CheckOptions): Promise<Plan | PreFailure> {
    // One-image firmware: both halves need a side before an update (the relay can't reach a
    // half without one), and Keybard notes them to compare after the install.
    let sideRead: SideAssessment = { kind: "unsupported" };
    if (o.sides && (await o.sides.supported())) {
        const deadline = o.clock.now() + OTHER_HALF_WAIT_MS;
        for (;;) {
            sideRead = assessSides(true, await o.sides.read());
            if (!sidesSettling(sideRead) || o.clock.now() >= deadline) break;
            await o.clock.sleep(250);
        }
        if (sideRead.kind === "unknown" || sideRead.kind === "same" || (sideRead.kind === "alone" && sideRead.usb === "unknown")) {
            return { id: "sides", sides: sideRead };
        }
    }
    const read = await readBoard(client, o.clock).catch((error) => {
        if (error instanceof UpdaterStatusError && (error.status === Status.OTHER_CLIENT || error.status === Status.BUSY)) return { id: "F3" } as PreFailure;
        throw error;
    });
    if ("id" in read) return read;
    const board = read;
    if (board.usb.hand !== 0 && board.usb.hand !== 1) return { id: "sides", sides: sideRead.kind === "unsupported" ? { kind: "unreadable" } : sideRead };
    const usbHand = board.usb.hand as Hand;
    const oHand = otherHand(usbHand);
    const { files, problems } = assignFiles(source);
    const checks: CheckRow[] = [];
    const warnings: CheckRow[] = [];
    let refusal: CheckRow | null = problems[0] ?? null;

    const otherSilent = !board.other;
    let target: Target;
    if (o.onlyHand !== undefined) target = o.onlyHand;
    else if (files[usbHand] && files[oHand]) target = otherSilent ? usbHand : "both";
    else target = files[usbHand] ? usbHand : oHand;
    if (target === oHand && otherSilent) refusal ??= { id: "other-silent", label: `The ${handName(oHand)} half isn't answering.`, state: "refuse", detail: "Check the split cable, then try again." };

    const halves: Hand[] = target === "both" ? [oHand, usbHand] : [target];
    for (const h of halves) if (!files[h]) refusal ??= { id: `missing-${h}`, label: `There's no file for the ${handName(h)} half.`, state: "refuse", detail: "Choose a file for that half." };

    // Connection
    checks.push(otherSilent
        ? { id: "connected", label: `The ${handName(oHand)} half isn't answering.`, state: "warn", detail: `Check the split cable, or update the ${handName(usbHand)} half on its own.` }
        : { id: "connected", label: "Both halves connected", state: "ok" });
    if (otherSilent && target === usbHand && o.onlyHand === undefined && files[oHand]) warnings.push(checks[checks.length - 1]);

    // Integrity: a carried file must match its pin; that's the only refusal of a file Keybard chose.
    const releases = o.releases;
    let pinned = true;
    let integrityOk = true;
    for (const h of halves) {
        const f = files[h];
        if (!f) continue;
        const pin = matchPin(f.sha256, releases);
        if (source.kind === "release") {
            // A release pins its one file for both halves.
            if (f.sha256 !== source.release.file.sha256) integrityOk = false;
        } else if (!pin) {
            pinned = false;
        }
        if (!f.imageHashOk) integrityOk = false;
    }
    // A chosen file that is damaged: get it again. A carried file that misses its pin: reload Keybard.
    const damagedFile = source.kind === "file" && halves.some((h) => files[h] && !files[h]!.imageHashOk);
    if (damagedFile) {
        refusal = { id: "file-damaged", label: "This firmware file is damaged.", state: "refuse", detail: "Download it again, then choose it." };
        checks.push(refusal);
    } else if (!integrityOk) {
        refusal = { id: "integrity", label: "The firmware file failed its check.", state: "refuse", detail: "Keybard won't install it. Reload Keybard and try again." };
        checks.push(refusal);
    } else {
        checks.push({ id: "files", label: "Firmware files verified", state: "ok" });
    }
    if (source.kind === "file" && !pinned) warnings.push({ id: "unknown-file", label: "Keybard can't check where this file came from.", state: "warn", detail: "Install it only if you trust where you got it." });

    // What each half would refuse (checked on the device too, at the pair ARM).
    for (const h of halves) {
        const f = files[h];
        const info = h === usbHand ? board.usb : board.other;
        if (!f || !info) continue;
        const why = refusalFor(f, info, h !== usbHand);
        if (why) refusal ??= { id: `refused-${h}`, label: `The ${handName(h)} half won't accept this file.`, state: "refuse", detail: `${sentence(why)} Choose another file.` };
    }
    // The USB half checks the other half's file and its own at the pair ARM; check its own against itself too.
    if (target === "both" && files[usbHand]) {
        const why = refusalFor(files[usbHand]!, board.usb, false);
        if (why) refusal ??= { id: `refused-${usbHand}`, label: `The ${handName(usbHand)} half won't accept this file.`, state: "refuse", detail: `${sentence(why)} Choose another file.` };
    }

    // Warnings, never refusals (D33).
    for (const h of halves) {
        const f = files[h];
        const info = h === usbHand ? board.usb : board.other;
        if (!f || !info) continue;
        if (f.manifest.hand !== h && f.manifest.hand !== HAND_EITHER) warnings.push({ id: `hand-${h}`, label: `This file is for the ${handName(f.manifest.hand)} half.`, state: "warn", detail: `On the ${handName(h)} half, the halves stop working together. Choose the ${handName(h)} half's file instead.` });
        if (f.manifest.pointingId !== POINTING_AUTO && f.manifest.pointingId !== info.pointingId) {
            const module = POINTING_NAMES[info.pointingId] ?? "pointing module";
            warnings.push({ id: `pointing-${h}`, label: `This file has no ${module.toLowerCase()} driver.`, state: "warn", detail: `Pointing stops working on the ${handName(h)} half.` });
        }
    }
    const lead = files[target === "both" ? usbHand : target]!;
    if (lead && lead.manifest.fwVersion < board.usb.fwVersion) {
        warnings.push({ id: "older", label: `${lead.manifest.tag || "This file"} is older than ${board.usbTag || "what's installed"}.`, state: "warn", detail: `Parts of your layout added since ${lead.manifest.tag || "it"} won't come back.` });
    }
    if (source.kind === "release" && o.maxSvalProtocol !== undefined && (source.release.svalProtocol ?? 0) > o.maxSvalProtocol) {
        warnings.push({ id: "sval-protocol", label: "This Keybard may not be able to edit this firmware.", state: "warn", detail: "You can still install it. Reload Keybard afterward to get a newer one." });
    }
    // The file's updater protocol (manifest byte 15) against the board's: warn, never refuse.
    for (const h of halves) {
        const f = files[h];
        const info = h === usbHand ? board.usb : board.other;
        const proto = f?.manifest.updaterProto;
        if (!f || !info || proto === undefined || proto === info.protocol) continue;
        // Older than the board's. On the half with USB that means installs by hand from then on
        // (Keybard installs only through protocol 4 there); the other half is updated through the
        // relay on protocol 3 or 4, so only an older one matters there.
        const manualAfter = h === usbHand ? proto < UPDATER_PROTOCOL : proto < 3;
        if (proto < info.protocol && manualAfter) warnings.push({ id: `updater-protocol-${h}`, label: "This file has an older updater.", state: "warn", detail: "Afterward, Keybard can't update this keyboard. Later firmware installs by hand." });
        else if (proto < info.protocol) warnings.push({ id: `updater-protocol-${h}`, label: "This file has an older updater.", state: "warn", detail: `The ${handName(h)} half goes back to updater protocol ${proto}.` });
        // Newer than this Keybard speaks: the next update may need a newer Keybard.
        else if (proto > UPDATER_PROTOCOL) warnings.push({ id: `updater-protocol-${h}`, label: "This file has a newer updater than this Keybard knows.", state: "warn", detail: "Afterward, reload Keybard to get a newer one before the next update." });
    }
    if (halves.some((h) => files[h]?.noChord)) warnings.push({ id: "developer", label: "This is a developer build.", state: "warn", detail: "Later updates on this keyboard start without a key press on the keyboard." });
    for (const row of o.hostRows ?? []) {
        checks.push(row);
        if (row.state === "warn") warnings.push(row);
    }

    const oneImage = halves.length > 0 && halves.every((h) => files[h]?.manifest.hand === HAND_EITHER);
    const sidesBefore = knownSidesFrom(sideRead, usbHand, !otherSilent);
    if (sideRead.kind !== "unsupported" && sidesSound(sideRead)) checks.push({ id: "sides", label: "Each half knows its side", state: "ok" });

    const toTag = lead?.manifest.tag || (source.kind === "release" ? source.release.tag : "custom firmware");
    const kind = lead ? kindFor(board, lead, pinned) : "custom";
    return {
        board, target, files, kind, toTag, fromTag: board.usbTag, title: titleFor(kind, toTag), checks, warnings, refusal,
        otherSilent, pinned, sidesBefore, oneImage, sidesFromSide: sideRead.kind !== "unsupported",
    };
}

export const describeStatus = statusName;
