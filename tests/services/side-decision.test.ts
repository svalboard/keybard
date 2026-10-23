// What Keybard does about each half's side: supported or not, unknown, same side, migrated, status 4.
import { describe, expect, it } from "vitest";

import { SideSource, SideStatus, Strap, decodeSideGet, encodeSideGet, type SideReport } from "@/services/side";
import {
    assessSides, explainSideStatus, knownSidesFrom, likelyUsbSide, planAfterUpdate, sidesSound, writesForAnswer,
} from "@/services/side-decision";

const report = (o: Parameters<typeof encodeSideGet>[0]): SideReport => decodeSideGet(encodeSideGet(o))!;
const pair = (usb: "left" | "right" | "unknown", other: "left" | "right" | "unknown", source: number = SideSource.KEYBARD) => report({
    side: usb, source, otherConnected: true, otherReported: true, otherSide: other,
    pair: usb === "unknown" || other === "unknown" ? "no-side" : usb === other ? "same" : "ok",
});

describe("assessSides", () => {
    it("unsupported: per-hand firmware keeps today's flow", () => {
        expect(assessSides(false, null)).toEqual({ kind: "unsupported" });
        expect(sidesSound(assessSides(false, null))).toBe(true);
        expect(assessSides(true, null)).toEqual({ kind: "unreadable" });
    });
    it("ok, with migrated when the half took its side from a per-hand build", () => {
        expect(assessSides(true, pair("right", "left"))).toEqual({ kind: "ok", usb: "right", other: "left", migrated: false });
        expect(assessSides(true, pair("left", "right", SideSource.MIGRATED))).toMatchObject({ kind: "ok", migrated: true });
    });
    it("unknown: which halves, and a guess when one half is known", () => {
        expect(assessSides(true, pair("unknown", "right"))).toEqual({ kind: "unknown", halves: ["usb"], usb: "unknown", other: "right", guess: { usb: "left" } });
        expect(assessSides(true, pair("left", "unknown"))).toEqual({ kind: "unknown", halves: ["other"], usb: "left", other: "unknown", guess: { other: "right" } });
        expect(assessSides(true, pair("unknown", "unknown"))).toMatchObject({ kind: "unknown", halves: ["usb", "other"], guess: {} });
    });
    it("same side", () => {
        expect(assessSides(true, pair("right", "right"))).toEqual({ kind: "same", side: "right" });
        expect(sidesSound({ kind: "same", side: "right" })).toBe(false);
    });
    it("alone and pending", () => {
        expect(assessSides(true, report({ side: "left", otherConnected: false }))).toEqual({ kind: "alone", usb: "left" });
        expect(assessSides(true, report({ side: "unknown", otherConnected: false }))).toMatchObject({ kind: "unknown", halves: ["usb"] });
        expect(assessSides(true, report({ side: "left", otherConnected: true, otherReported: false, pair: "pending" }))).toEqual({ kind: "pending", usb: "left" });
    });
});

describe("knownSidesFrom: the sides before an update", () => {
    it("from SIDE", () => {
        expect(knownSidesFrom(assessSides(true, pair("left", "right")))).toEqual({ usb: "left", other: "right" });
    });
    it("from a per-hand build's updater hand", () => {
        expect(knownSidesFrom({ kind: "unsupported" }, 1, true)).toEqual({ usb: "right", other: "left" });
        expect(knownSidesFrom({ kind: "unsupported" }, 0, false)).toEqual({ usb: "left", other: null });
        expect(knownSidesFrom({ kind: "unsupported" }, 0xff, true)).toEqual({ usb: null, other: null });
    });
});

describe("planAfterUpdate: Keybard asks, never writes by itself", () => {
    const before = { usb: "right" as const, other: "left" as const };
    it("the same sides as before, read from SIDE: nothing to say", () => {
        expect(planAfterUpdate(before, assessSides(true, pair("right", "left")))).toEqual({ action: "none", likelyUsb: null, restore: false, migrated: false });
    });
    it("migrated: show the result once to confirm", () => {
        expect(planAfterUpdate(before, assessSides(true, pair("right", "left", SideSource.MIGRATED)), { firmwareChose: true })).toEqual({ action: "confirm", likelyUsb: "right", restore: false, migrated: true });
        // Once the customer has answered, the caller stops asking: nothing more to say.
        expect(planAfterUpdate(before, assessSides(true, pair("right", "left", SideSource.MIGRATED)))).toMatchObject({ action: "none", migrated: true });
        expect(planAfterUpdate(before, assessSides(true, pair("right", "left")), { firmwareChose: true })).toMatchObject({ action: "confirm" });
    });
    it("unsupported after the update: nothing", () => {
        expect(planAfterUpdate(before, { kind: "unsupported" })).toMatchObject({ action: "none" });
    });
    it("a half came back unknown: ask, with its old side first, worded as keeping it", () => {
        expect(planAfterUpdate(before, assessSides(true, pair("right", "unknown")))).toEqual({ action: "ask", likelyUsb: "right", restore: true, migrated: false });
        expect(planAfterUpdate(before, assessSides(true, pair("unknown", "unknown")))).toMatchObject({ action: "ask", likelyUsb: "right", restore: true });
    });
    it("unknown and not known before: ask, the likely answer from the other half", () => {
        expect(planAfterUpdate({ usb: null, other: null }, assessSides(true, pair("unknown", "unknown")))).toEqual({ action: "ask", likelyUsb: null, restore: false, migrated: false });
        expect(planAfterUpdate({ usb: null, other: null }, assessSides(true, pair("unknown", "right")))).toMatchObject({ action: "ask", likelyUsb: "left", restore: false });
    });
    it("same side: ask; with nothing known, no guess (either half could be the wrong one)", () => {
        expect(planAfterUpdate(before, assessSides(true, pair("right", "right")))).toMatchObject({ action: "ask", likelyUsb: "right", restore: true });
        expect(planAfterUpdate({ usb: null, other: null }, assessSides(true, pair("left", "left")))).toMatchObject({ action: "ask", likelyUsb: null });
        // The plugged-in half's thumb PCBA names a side: that's the likely answer.
        const strapped = assessSides(true, report({ side: "right", strap: Strap.RIGHT, otherConnected: true, otherReported: true, otherSide: "right", pair: "same" }));
        expect(planAfterUpdate({ usb: null, other: null }, strapped)).toMatchObject({ action: "ask", likelyUsb: "right" });
    });
    it("both halves swapped: ask, offering the sides from before", () => {
        expect(planAfterUpdate(before, assessSides(true, pair("left", "right")))).toMatchObject({ action: "ask", likelyUsb: "right", restore: true });
    });
    it("only the half with USB, and it came back unknown", () => {
        const alone = assessSides(true, report({ side: "unknown", otherConnected: false }));
        expect(planAfterUpdate(before, alone)).toMatchObject({ action: "ask", likelyUsb: "right" });
        expect(planAfterUpdate({ usb: null, other: null }, alone)).toMatchObject({ action: "ask", likelyUsb: null });
    });
});

describe("the customer's answer", () => {
    it("likelyUsbSide", () => {
        expect(likelyUsbSide(assessSides(true, pair("right", "unknown")))).toBe("right");
        expect(likelyUsbSide(assessSides(true, pair("unknown", "right")))).toBe("left");
        expect(likelyUsbSide(assessSides(true, pair("unknown", "unknown")))).toBeNull();
        expect(likelyUsbSide({ kind: "same", side: "right" })).toBeNull();
        expect(likelyUsbSide({ kind: "same", side: "right" }, { usb: null, other: "right" })).toBe("left");
    });
    it("writes only what differs, the other half first", () => {
        expect(writesForAnswer(assessSides(true, pair("right", "right")), "left")).toEqual([{ role: "usb", side: "left", why: "same" }]);
        expect(writesForAnswer(assessSides(true, pair("right", "right")), "right")).toEqual([{ role: "other", side: "left", why: "same" }]);
        expect(writesForAnswer(assessSides(true, pair("unknown", "unknown")), "left").map((w) => `${w.role}:${w.side}`)).toEqual(["other:right", "usb:left"]);
        expect(writesForAnswer(assessSides(true, report({ side: "unknown", otherConnected: false })), "right")).toEqual([{ role: "usb", side: "right", why: "unknown" }]);
        // "Swap" on sides the firmware chose: both halves change.
        expect(writesForAnswer(assessSides(true, pair("right", "left")), "left")).toEqual([{ role: "other", side: "right", why: "swap" }, { role: "usb", side: "left", why: "swap" }]);
        expect(writesForAnswer(assessSides(true, pair("right", "left")), "right")).toEqual([]);
    });
});

describe("explainSideStatus", () => {
    it("OK and accepted need no words", () => {
        expect(explainSideStatus(SideStatus.OK)).toBeNull();
        expect(explainSideStatus(SideStatus.OTHER_ACCEPTED)).toBeNull();
    });
    it("status 4: the thumb PCBA, in plain words, with where to get help", () => {
        const text = explainSideStatus(SideStatus.STRAP_DISAGREES, { role: "usb", wanted: "left", strap: Strap.RIGHT })!;
        expect(text).toContain("right thumb PCBA");
        expect(text).toBe("The half plugged into your computer has a right thumb PCBA, which makes it the right half. If it's really the left half, it has the wrong thumb PCBA. To sort it out, open a ticket in #customer-service on the Svalboard Discord (https://www.svalboard.com/discord).");
        expect(text).toContain("#customer-service on the Svalboard Discord (https://www.svalboard.com/discord)");
        expect(text).not.toMatch(/strap|status|0x/i);
        // Without the strap read (the other half), it says the other side of what was asked.
        expect(explainSideStatus(4, { role: "other", wanted: "right" })).toContain("a left thumb PCBA");
    });
    it("every other status has words", () => {
        for (const s of [1, 2, 3, 5, 6, 9]) expect(explainSideStatus(s)).toMatch(/\w/);
        expect(explainSideStatus(SideStatus.OTHER_NOT_CONNECTED)).toContain("split cable");
    });
});
