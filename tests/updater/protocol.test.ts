import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
    ARM_BY_PAIR, ARM_PRE_APPROVED, Op, Status, chunkArgs, commitArgs, decodeArm, decodeInfo0, decodeInfo1, decodeRelay,
    decodeReply, decodeStatus, encodeArm, encodeInfo0, encodeInfo1, encodePacket, encodeRelay, encodeStatus,
    encodeViaPayload, isReplyTo, makeRsp, manifestArgs, manifestPieces, settingsResetArgs,
} from "@/services/updater/protocol";
import { buildSvup, crc32Mpeg2, findBuildInfo, loadSvup, parseManifest, splitSvup, SvupError } from "@/services/updater/svup";

describe("updater packets", () => {
    it("frames a request as [0xDD][client][0xFE][0x07][0x55][op][hand][args]", () => {
        const p = encodePacket(0x11223344, Op.ARM, 1, [1]);
        expect(p.length).toBe(64);
        expect(Array.from(p.subarray(0, 11))).toEqual([0xdd, 0x44, 0x33, 0x22, 0x11, 0xfe, 0x07, 0x55, 0x02, 0x01, 0x01]);
        expect(encodeViaPayload(Op.SETTINGS_RESET, 1, settingsResetArgs(1))).toEqual([0x07, 0x55, 0x0e, 0x01, 0x52, 0x53, 0x45, 0x54, 0x01, 0x00]);
        // D44: mode 1, a blank board
        expect(encodeViaPayload(Op.SETTINGS_RESET, 1, settingsResetArgs(1, 1))).toEqual([0x07, 0x55, 0x0e, 0x01, 0x52, 0x53, 0x45, 0x54, 0x01, 0x01]);
    });

    it("refuses arguments that don't fit a report", () => {
        expect(() => encodePacket(1, Op.CHUNK, 0, new Array(55).fill(0))).toThrow(RangeError);
        expect(() => chunkArgs(0, new Uint8Array(51))).toThrow(RangeError);
        expect(() => manifestArgs(0, new Uint8Array(53))).toThrow(RangeError);
    });

    it("matches replies by client and echoed op, and reads value_data", () => {
        const report = encodePacket(7, Op.STATUS, 1);
        report[9] = Status.OK;
        report[10] = 5;
        expect(isReplyTo(report, 7, Op.STATUS)).toBe(true);
        expect(isReplyTo(report, 8, Op.STATUS)).toBe(false);
        expect(isReplyTo(report, 7, Op.INFO)).toBe(false);
        const r = decodeReply(report);
        expect(r.rsp.length).toBe(55);
        expect(r.rsp[1]).toBe(5);
    });

    it("lays out CHUNK, COMMIT and MANIFEST arguments little-endian", () => {
        expect(chunkArgs(0x012345, [9, 8])).toEqual([0x45, 0x23, 0x01, 2, 9, 8]);
        expect(commitArgs(0xa1b2c3d4, 0xbeef)).toEqual([0xd4, 0xc3, 0xb2, 0xa1, 0xef, 0xbe]);
        const pieces = manifestPieces(new Uint8Array(108));
        expect(pieces.map(([off, b]) => [off, b.length])).toEqual([[0, 52], [52, 52], [104, 4]]);
    });

    it("decodes INFO page 0 at the documented offsets, including the no-chord bit", () => {
        const rsp = encodeInfo0({ status: 0, state: 0, protocol: 4, slotBase: 0x200000, slotSize: 0x200000, maxImage: 0x160000, pointingId: 5, hand: 1, fwVersion: 2301, storageFormat: 2, securityEpoch: 3, flags: 0x85, lastError: 15, chunkMax: 50, manifestMax: 52, reportBytes: 64 });
        expect(rsp[2]).toBe(4);
        expect(rsp[13]).toBe(1);
        expect(rsp[21]).toBe(0x85);
        const i = decodeInfo0({ status: 0, rsp });
        expect(i).toMatchObject({ protocol: 4, hand: 1, fwVersion: 2301, securityEpoch: 3, flash16MiB: true, releaseBuild: true, noChord: true, writesFailing: false, lastError: 15, chunkMax: 50, manifestMax: 52, reportBytes: 64, maxImage: 0x160000, answered: true });
        const silent = makeRsp(Status.UNAVAILABLE, [0xff]);
        expect(decodeInfo0({ status: 2, rsp: silent }).answered).toBe(false);
    });

    it("decodes INFO page 1's tag", () => {
        expect(decodeInfo1({ status: 0, rsp: encodeInfo1(0, 2400, "x3.2") })).toEqual({ status: 0, page: 1, fwVersion: 2400, tag: "x3.2" });
    });

    it("decodes STATUS, with flags2 at rsp[23]", () => {
        const rsp = encodeStatus({ status: 0, state: 5, staged: 0x10203, imageLen: 0x20000, sectorsErased: 3, sectorsToErase: 31, lastError: 0, verifyMs: 485, eraseMsMax: 53, crcLo16: 0xabcd, flags: 3, presence: 2, flags2: 3 });
        expect(rsp[19] | (rsp[20] << 8)).toBe(0xabcd);
        expect(rsp[22]).toBe(2);
        expect(rsp[23]).toBe(3);
        expect(decodeStatus({ status: 0, rsp })).toMatchObject({ state: 5, staged: 0x10203, imageLen: 0x20000, sectorsToErase: 31, crcLo16: 0xabcd, chordMade: true, bound: true, presence: 2, approvalHeld: true, preApproved: true });
    });

    it("decodes RELAY and ARM replies", () => {
        const relay = decodeRelay({ status: 0, rsp: encodeRelay({ status: 0, phase: 4, otherState: 5, otherError: 0, acked: 5000, imageLen: 10000, otherErased: 3, otherToErase: 3, retries: 2, relayMs: 1234, error: 0, state: 10, linkPaused: false, unconfirmed: true }) });
        expect(relay).toMatchObject({ phase: 4, acked: 5000, imageLen: 10000, relayMs: 1234, unconfirmed: true, state: 10 });
        const arm = decodeArm({ status: 0, rsp: encodeArm(0, 0xdeadbeef, [1, 2, 3, 4], [5, 6, 7, 8], ARM_PRE_APPROVED | ARM_BY_PAIR) });
        expect(arm).toMatchObject({ nonce: 0xdeadbeef, preApproved: true, byPair: true, noChord: false, pair: false });
        expect(Array.from(arm.manifestHash)).toEqual([1, 2, 3, 4]);
        expect(Array.from(arm.pairHash)).toEqual([5, 6, 7, 8]);
    });
});

describe(".svup files", () => {
    it("parses a manifest, finds the build info and its no-chord flag", async () => {
        const bytes = await buildSvup({ hand: 0, fwVersion: 2400, tag: "x3.2", buildFlags: 0x40 });
        const f = await loadSvup(bytes);
        expect(f.manifest).toMatchObject({ hand: 0, fwVersion: 2400, tag: "x3.2", imageLen: 0x1000, release: true, diagnostic: false, updaterProto: 4 });
        expect(f.buildInfo).toMatchObject({ infoVersion: 3, fwVersion: 2400, tag: "x3.2", hand: 0, noChord: true });
        expect(f.noChord).toBe(true);
        expect(f.imageHashOk).toBe(true);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.manifestSha512.length).toBe(64);
        const chord = await loadSvup(await buildSvup({ hand: 1, fwVersion: 2400, tag: "x3.2" }));
        expect(chord.noChord).toBe(false);
    });

    it("flags a damaged image and refuses malformed files", async () => {
        const bytes = await buildSvup({ hand: 1, fwVersion: 1, tag: "v1" });
        bytes[200] ^= 0xff;
        expect((await loadSvup(bytes)).imageHashOk).toBe(false);
        expect(() => parseManifest(new Uint8Array(108))).toThrow(SvupError);
        expect(() => splitSvup(bytes.subarray(0, bytes.length - 256))).toThrow(/manifest says/);
    });

    it("computes CRC-32/MPEG-2 (check value 0x0376E6E7)", () => {
        expect(crc32Mpeg2(new TextEncoder().encode("123456789"))).toBe(0x0376e6e7);
    });

    it("reads the build info of no file when there's no SVBI record", () => {
        expect(findBuildInfo(new Uint8Array(4096))).toBeNull();
    });

    // A real release build, when this machine has one (not committed: it's firmware, not ours to ship here).
    const real = "C:/Users/morga/Svalboard/firmware/bench/auto-2301/right-2301.svup";
    it.skipIf(!existsSync(real))("parses a real .svup from a firmware build", async () => {
        const f = await loadSvup(new Uint8Array(readFileSync(real)));
        expect(f.manifest.hand).toBe(1);
        expect(f.manifest.fwVersion).toBe(f.buildInfo?.fwVersion);
        expect(f.imageHashOk).toBe(true);
    });
});
