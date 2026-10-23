import { describe, expect, it } from "vitest";
import {
    ReplyMismatchError, Status, State, decodeInfo0, decodeInfo1, encodeInfo0, encodeInfo1, looksLikeInfo1, type UpdaterReply,
} from "@/services/updater/protocol";

const reply = (rsp: Uint8Array): UpdaterReply => ({ status: rsp[0], rsp });

const page0 = (state: number = State.IDLE) => encodeInfo0({
    status: Status.OK, state, protocol: 4, slotBase: 0x800000, slotSize: 0x160000, maxImage: 0x160000,
    pointingId: 5, hand: 1, fwVersion: 12, storageFormat: 2, securityEpoch: 0, flags: 0x05, lastError: 0,
    chunkMax: 50, manifestMax: 52, reportBytes: 64,
});

describe("INFO replies that answer the other page", () => {
    it("tells page 1 from page 0", () => {
        expect(looksLikeInfo1(encodeInfo1(Status.OK, 12, "x4test12"))).toBe(true);
        expect(looksLikeInfo1(encodeInfo1(Status.OK, 0, ""))).toBe(true);
        expect(looksLikeInfo1(page0())).toBe(false);
        // Page 0 in MANIFEST_LOADING has the page-1 marker byte, and still isn't page 1.
        expect(looksLikeInfo1(page0(State.MANIFEST_LOADING))).toBe(false);
    });

    it("refuses a late page 1 reply taken as page 0 (the mule's false 'Nothing was changed')", () => {
        // Read as page 0, this is state 1 and fw_version 0: a restarted half on "old firmware".
        expect(() => decodeInfo0(reply(encodeInfo1(Status.OK, 12, "x4test12")))).toThrow(ReplyMismatchError);
    });

    it("refuses a late page 0 reply taken as page 1", () => {
        expect(() => decodeInfo1(reply(page0()))).toThrow(ReplyMismatchError);
    });

    it("still reads the right pages", () => {
        expect(decodeInfo0(reply(page0(State.MANIFEST_LOADING))).fwVersion).toBe(12);
        expect(decodeInfo1(reply(encodeInfo1(Status.OK, 12, "x4test12"))).tag).toBe("x4test12");
    });
});
