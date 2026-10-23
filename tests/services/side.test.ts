// SIDE (0x33) codec: the bytes of svalboard/qmk side.c (sval_side_command) and protocol.md "Side".
import { describe, expect, it } from "vitest";

import {
    CMD_SVIL_SIDE, SideClient, SideOp, SideSource, SideStatus, Strap, decodeSideGet, decodeSideStatus, encodeSideGet,
    hasSideCommand, sideClearArgs, sideGetArgs, sideSetArgs, type SvalTransport,
} from "@/services/side";

/** A GET reply as sendSvil returns it: firmware data[1..] (the 0xDF prefix stripped). */
function firmwareGet(d: number[]): Uint8Array {
    // side.c fills d[1..14] after d[0] = op; the wire packet is [DF][33][op][status]...
    const out = new Uint8Array(31);
    out.set([CMD_SVIL_SIDE, ...d]);
    return out;
}

describe("SIDE discovery", () => {
    it("reads GET_INFO byte 19 bit 6", () => {
        expect(hasSideCommand(0x40)).toBe(true);
        expect(hasSideCommand(0x47)).toBe(true);
        expect(hasSideCommand(0x3f)).toBe(false);
        expect(hasSideCommand(0)).toBe(false);
        expect(hasSideCommand(undefined)).toBe(false);
    });
});

describe("SIDE requests", () => {
    it("GET is DF 33 00", () => {
        expect(sideGetArgs()).toEqual([0]);
    });
    it("SET is DF 33 01 <target> <side> <source> <flags>", () => {
        expect(sideSetArgs(1, "left", { restart: true })).toEqual([1, 1, 0, 2, 1]);
        expect(sideSetArgs(0, "right")).toEqual([1, 0, 1, 2, 0]);
        expect(sideSetArgs(0, "right", { source: SideSource.FACTORY })).toEqual([1, 0, 1, 1, 0]);
    });
    it("CLEAR is DF 33 02 <target> <flags>", () => {
        expect(sideClearArgs(1, { restart: true })).toEqual([2, 1, 1]);
        expect(sideClearArgs(0)).toEqual([2, 0, 0]);
    });
});

describe("SIDE GET reply", () => {
    it("decodes every field at the firmware's offsets", () => {
        // op, status, format, side R, source migrated, strap right, raw, record R/migrated,
        // other connected+reported, other L, pair ok, link tx GP1, how listened, flags area+usb
        const r = decodeSideGet(firmwareGet([0, 0, 1, 1, 3, Strap.RIGHT, 0x83, 1, 3, 3, 0, 0, 1, 1, 0x0c]))!;
        expect(r).toMatchObject({
            side: "right", source: 3, strap: 4, strapRaw: 0x83, recordSide: "right", recordSource: 3,
            otherConnected: true, otherReported: true, otherSide: "left", pair: "ok", linkTx: 1, linkHow: 1,
            inputBlocked: false, restartPending: false, recordArea: true, usbHalf: true,
        });
    });
    it("reads unknown, no record, same side, pending and the flags", () => {
        expect(decodeSideGet(firmwareGet([0, 0, 1, 0xff, 0, 0, 0, 0xfe, 0, 1, 0xff, 2, 0xff, 2, 0x09]))).toMatchObject({
            side: "unknown", recordSide: "none", otherConnected: true, otherReported: false, otherSide: "unknown", pair: "no-side",
            linkTx: 0xff, linkHow: 2, inputBlocked: true, usbHalf: true, recordArea: false,
        });
        expect(decodeSideGet(firmwareGet([0, 0, 1, 1, 2, 0, 0, 0, 2, 3, 1, 1, 0, 0, 0x0f]))).toMatchObject({ pair: "same", recordSide: "left", restartPending: true });
        expect(decodeSideGet(firmwareGet([0, 0, 1, 1, 2, 0, 0, 1, 2, 1, 0xff, 3, 0, 0, 0x0c]))!.pair).toBe("pending");
    });
    it("rejects another command, another op, a bad status or format, a short reply", () => {
        expect(decodeSideGet([0x2c, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
        expect(decodeSideGet(firmwareGet([1, 0, 1, 1]))).toBeNull();
        expect(decodeSideGet(firmwareGet([0, 1, 1, 1]))).toBeNull();
        expect(decodeSideGet(firmwareGet([0, 0, 2, 1]))).toBeNull();
        expect(decodeSideGet([CMD_SVIL_SIDE, 0, 0, 1])).toBeNull();
    });
    it("round-trips the mock board's encoder", () => {
        const bytes = encodeSideGet({ side: "left", source: SideSource.KEYBARD, otherConnected: true, otherReported: true, otherSide: "right", pair: "ok" });
        expect(decodeSideGet(bytes)).toMatchObject({ side: "left", source: 2, otherSide: "right", pair: "ok", usbHalf: true, recordArea: true });
        expect(decodeSideGet(encodeSideGet({ side: "unknown", pair: "same" }))!.pair).toBe("same");
    });
});

describe("SIDE SET / CLEAR status", () => {
    it("reads [33][op][status]", () => {
        expect(decodeSideStatus([CMD_SVIL_SIDE, SideOp.SET, 4], SideOp.SET)).toBe(SideStatus.STRAP_DISAGREES);
        expect(decodeSideStatus([CMD_SVIL_SIDE, SideOp.CLEAR, 7], SideOp.CLEAR)).toBe(SideStatus.OTHER_ACCEPTED);
        expect(decodeSideStatus([CMD_SVIL_SIDE, SideOp.CLEAR, 0], SideOp.SET)).toBeNull();
        expect(decodeSideStatus([0x2b, SideOp.SET, 0], SideOp.SET)).toBeNull();
    });
    it("SideClient sends the command and decodes", async () => {
        const sent: Array<[number, number[]]> = [];
        const t: SvalTransport = {
            async sval(cmd, args) {
                sent.push([cmd, args]);
                if (args[0] === 0) return encodeSideGet({ side: "right" });
                return Uint8Array.from([CMD_SVIL_SIDE, args[0], args[0] === 1 ? 7 : 0]);
            },
        };
        const c = new SideClient(t);
        expect((await c.get())!.side).toBe("right");
        expect(await c.set(1, "left", { restart: true })).toBe(7);
        expect(await c.clear(0)).toBe(0);
        expect(sent).toEqual([[0x33, [0]], [0x33, [1, 1, 0, 2, 1]], [0x33, [2, 0, 0]]]);
    });
});
