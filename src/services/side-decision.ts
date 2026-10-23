// What Keybard does about each half's side, as pure functions of what the board reports.
//
// - Boards without SIDE (per-hand builds) keep today's flow: nothing here applies.
// - Keybard never writes a side by itself. Every SET follows the customer's answer and a
//   confirmation, with the likely answer as the main button.
// - Before an update Keybard notes each half's side (from SIDE, or from the updater's
//   INFO hand on a per-hand build). After the update it reads SIDE again. A half that came
//   back unknown, changed, or two halves on one side: Keybard asks which half is plugged in.
//   Halves that took their side from the firmware (the per-hand build, or the thumb PCBA)
//   are shown once to confirm: "That's right" or "Swap".
// - Two halves on the same side: neither types until it is fixed. Keybard doesn't assume
//   which half is wrong.
// - Hardware mismatches warn and confirm; nothing here refuses. A thumb PCBA that
//   disagrees (SET status 4) is explained, not retried.

import {
    SideStatus, oppositeSide, strapSide, type Side, type SideReport, type SideValue,
} from "./side";

/** "usb": the half plugged into the computer. "other": the half on the split cable. */
export type HalfRole = "usb" | "other";

export type SideAssessment =
    /** Per-hand firmware: no SIDE command. Today's flow, unchanged. */
    | { kind: "unsupported" }
    /** SIDE is advertised but the read failed. */
    | { kind: "unreadable" }
    /** Both halves have a side, and they differ. */
    | { kind: "ok"; usb: Side; other: Side; migrated: boolean }
    /** Only the half with USB is connected. */
    | { kind: "alone"; usb: SideValue }
    /** The other half connected moments ago and hasn't reported yet. */
    | { kind: "pending"; usb: SideValue }
    /** One or both halves have no side. `guess` is the side the half most likely is. */
    | { kind: "unknown"; halves: HalfRole[]; usb: SideValue; other: SideValue | null; guess: Partial<Record<HalfRole, Side>>; strap?: Side }
    /** Both halves claim the same side. `strap`: the plugged-in half's thumb PCBA names a side. */
    | { kind: "same"; side: Side; strap?: Side };

/** Read the board's SIDE reply. */
export function assessSides(supported: boolean, r: SideReport | null): SideAssessment {
    if (!supported) return { kind: "unsupported" };
    if (!r) return { kind: "unreadable" };
    const otherKnown = r.otherConnected && r.otherReported;
    const other: SideValue | null = otherKnown ? r.otherSide : null;
    const strap = strapSide(r.strap);
    const withStrap = strap ? { strap } : {};
    if (r.pair === "same" && r.side !== "unknown") return { kind: "same", side: r.side, ...withStrap };
    const unknown: HalfRole[] = [];
    if (r.side === "unknown") unknown.push("usb");
    if (otherKnown && r.otherSide === "unknown") unknown.push("other");
    if (unknown.length) {
        const guess: Partial<Record<HalfRole, Side>> = {};
        // One half known: the other is the opposite.
        if (unknown.length === 1 && unknown[0] === "usb" && other && other !== "unknown") guess.usb = oppositeSide(other);
        if (unknown.length === 1 && unknown[0] === "other" && r.side !== "unknown") guess.other = oppositeSide(r.side);
        return { kind: "unknown", halves: unknown, usb: r.side, other, guess, ...withStrap };
    }
    if (!r.otherConnected) return { kind: "alone", usb: r.side };
    if (!r.otherReported || r.pair === "pending") return { kind: "pending", usb: r.side };
    if (r.side === "unknown" || r.otherSide === "unknown") return { kind: "unknown", halves: [], usb: r.side, other, guess: {} };
    if (r.side === r.otherSide) return { kind: "same", side: r.side, ...withStrap };
    return { kind: "ok", usb: r.side, other: r.otherSide, migrated: r.source === 3 };
}

/**
 * The other half hasn't reported over the split link yet (just after a restart it comes up
 * a few seconds later): a read to wait out, not one to conclude anything from.
 */
export const sidesSettling = (a: SideAssessment): boolean =>
    a.kind === "pending" || a.kind === "unreadable" || a.kind === "alone" || (a.kind === "unknown" && a.other === null);

/** A half has no side, or both claim the same one: Keybard asks which half is which (neither half types). */
export const sidesNeedAnswer = (a: SideAssessment): boolean => a.kind === "same" || a.kind === "unknown" || (a.kind === "alone" && a.usb === "unknown");

/** Whether the halves can type: both have a side and they differ (or only one half is there). */
export const sidesSound = (a: SideAssessment): boolean => a.kind === "ok" || a.kind === "unsupported" || (a.kind === "alone" && a.usb !== "unknown");

/** What Keybard knew about each half's side before an update. */
export interface KnownSides {
    usb: Side | null;
    other: Side | null;
}

/** The sides as read before the update: from SIDE, or from a per-hand build's updater hand. */
export function knownSidesFrom(a: SideAssessment, updaterHand?: number, otherAnswered?: boolean): KnownSides {
    if (a.kind === "ok") return { usb: a.usb, other: a.other };
    if (a.kind === "alone") return { usb: a.usb === "unknown" ? null : a.usb, other: null };
    if (a.kind === "pending") return { usb: a.usb === "unknown" ? null : a.usb, other: null };
    if (a.kind === "unknown") {
        return { usb: a.usb === "unknown" ? null : a.usb, other: a.other && a.other !== "unknown" ? a.other : null };
    }
    if (a.kind === "unsupported" && (updaterHand === 0 || updaterHand === 1)) {
        const usb: Side = updaterHand === 0 ? "left" : "right";
        return { usb, other: otherAnswered === false ? null : oppositeSide(usb) };
    }
    return { usb: null, other: null };
}

export interface SideWrite {
    role: HalfRole;
    side: Side;
    /** Why: the half has no side, or both halves claim one, or the customer swapped them. */
    why: "unknown" | "same" | "swap" | "changed";
}

export interface AfterUpdatePlan {
    /**
     * none: both halves have the sides Keybard read before; nothing to say.
     * confirm: both halves have a side, but the firmware chose it (from the per-hand build or
     *   the thumb PCBA): show it once, "That's right" or "Swap".
     * ask: a half has no side, both claim one, or they changed: ask which half is plugged in.
     */
    action: "none" | "confirm" | "ask";
    /** The likely side of the plugged-in half: the main button. Null when Keybard can't tell. */
    likelyUsb: Side | null;
    /** Keybard knew the plugged-in half's side before: word the question as "Keep ... as the left half?". */
    restore: boolean;
    /** A half took its side from the per-hand build it ran. */
    migrated: boolean;
}

/**
 * The plugged-in half's likely side: what Keybard read before, else its thumb PCBA, else
 * the opposite of the other half when only the plugged-in half has no side. Two halves on
 * one side give no guess from each other: either could be the wrong one.
 */
export function likelyUsbSide(a: SideAssessment, before: KnownSides = { usb: null, other: null }): Side | null {
    if (before.usb) return before.usb;
    if (before.other) return oppositeSide(before.other);
    if ((a.kind === "unknown" || a.kind === "same") && a.strap) return a.strap;
    if (a.kind === "unknown") return a.usb === "left" || a.usb === "right" ? a.usb : a.guess.usb ?? null;
    if (a.kind === "ok") return a.usb;
    return null;
}

/**
 * After an update: compare the sides now with the sides before. Keybard never writes a side
 * by itself: every change is a question for the customer, with the likely answer first.
 * `firmwareChose`: the halves took their sides from the firmware this time (a per-hand
 * build before, or the thumb PCBA), so the result is shown once to confirm.
 */
export function planAfterUpdate(before: KnownSides, now: SideAssessment, o: { firmwareChose?: boolean } = {}): AfterUpdatePlan {
    const none: AfterUpdatePlan = { action: "none", likelyUsb: null, restore: false, migrated: false };
    if (now.kind === "unsupported" || now.kind === "unreadable") return none;
    const ask = (): AfterUpdatePlan => ({ action: "ask", likelyUsb: likelyUsbSide(now, before), restore: !!before.usb, migrated: false });
    if (now.kind === "ok") {
        const changed = (before.usb !== null && before.usb !== now.usb) || (before.other !== null && before.other !== now.other);
        if (changed) return ask();
        if (o.firmwareChose) return { action: "confirm", likelyUsb: now.usb, restore: false, migrated: now.migrated };
        return { ...none, migrated: now.migrated };
    }
    if (now.kind === "alone" || now.kind === "pending") {
        if (now.usb === "unknown" || (before.usb && now.usb !== before.usb)) return ask();
        return none;
    }
    return ask();
}

/** The sides each half runs as now (null: not connected, or not reported). */
export function currentSides(a: SideAssessment): { usb: SideValue | null; other: SideValue | null } {
    switch (a.kind) {
        case "ok": return { usb: a.usb, other: a.other };
        case "same": return { usb: a.side, other: a.side };
        case "unknown": return { usb: a.usb, other: a.other };
        case "alone":
        case "pending": return { usb: a.usb, other: null };
        default: return { usb: null, other: null };
    }
}

/**
 * The customer said which half is plugged into the computer: the SETs that make the
 * halves match, the other half first (writing the half with USB restarts the connection).
 */
export function writesForAnswer(a: SideAssessment, usb: Side): SideWrite[] {
    const now = currentSides(a);
    const why: SideWrite["why"] = a.kind === "same" ? "same" : a.kind === "ok" ? "swap" : "unknown";
    const writes: SideWrite[] = [];
    const other = oppositeSide(usb);
    if (now.other !== null && now.other !== other) writes.push({ role: "other", side: other, why: now.other === "unknown" ? "unknown" : why });
    if (now.usb !== usb) writes.push({ role: "usb", side: usb, why: now.usb === "unknown" ? "unknown" : why });
    return writes;
}

const SUPPORT = "open a ticket in #customer-service on the Svalboard Discord (https://www.svalboard.com/discord)";

export const sideWord = (s: Side) => (s === "left" ? "left" : "right");
export const halfName = (role: HalfRole) => (role === "usb" ? "the half plugged into your computer" : "the half on the split cable");

/**
 * A SET or CLEAR status in plain words, or null for OK (0) and accepted (7).
 * `strap` is the GET reply's strap class, for status 4.
 */
export function explainSideStatus(status: number, o: { role?: HalfRole; wanted?: Side; strap?: number } = {}): string | null {
    const which = o.role ? halfName(o.role) : "this half";
    switch (status) {
        case SideStatus.OK:
        case SideStatus.OTHER_ACCEPTED:
            return null;
        case SideStatus.STRAP_DISAGREES: {
            // The thumb PCBA's wiring sets the side, and it wins over a write.
            const fitted = (o.strap !== undefined ? strapSide(o.strap) : null) ?? (o.wanted ? oppositeSide(o.wanted) : null);
            if (!fitted) return `${capitalize(which)} has a thumb PCBA for the other side, which sets its side. To sort it out, ${SUPPORT}.`;
            return `${capitalize(which)} has a ${fitted} thumb PCBA, which makes it the ${fitted} half. ` +
                `If it's really the ${oppositeSide(fitted)} half, it has the wrong thumb PCBA. To sort it out, ${SUPPORT}.`;
        }
        case SideStatus.NO_RECORD_AREA:
            return `${capitalize(which)} has no room to save its side. To sort it out, ${SUPPORT}.`;
        case SideStatus.WRITE_FAILED:
            return `${capitalize(which)} couldn't save its side. Try again; if it keeps failing, ${SUPPORT}.`;
        case SideStatus.OTHER_NOT_CONNECTED:
            return "The other half isn't connected. Check the split cable, then try again.";
        case SideStatus.NO_ANSWER:
            return "The other half didn't answer. It may run older firmware: update both halves, then try again.";
        default:
            return `Keybard couldn't set the side (status ${status}). Try again; if it keeps failing, ${SUPPORT}.`;
    }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const SIDE_SUPPORT_TEXT = SUPPORT;
