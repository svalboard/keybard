// Pair UF2 files (x4 on): one file per release for both halves. Keybard reads the manifest
// and the image out of it and installs both halves with them.
//
// Fixtures (tests/fixtures/firmware, gzipped):
//   svalboard_sval_x4.uf2.gz       built on svalboard/qmk feat/pair-uf2 (01a8a8b165) in WSL:
//                                  make svalboard/either:sval SVAL_UPDATER=yes SVAL_UPDATE_RELEASE=yes
//                                    SVAL_FW_VERSION_STRING=x4 (fw_version.txt: 9), then
//                                  make_update.py pair ... --kb svalboard/either --keymap sval --release
//   SVUP_SHA256 below              of `make_update.py verify-pair svalboard_sval_x4.uf2 --svup OUT.svup`,
//                                  the manifest and image a host sends
//   svalboard_left_sval_x3.1.3.uf2.gz  the left half's file of the x3.1.3 release (per side, no pair record)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { HAND_EITHER, MANIFEST_BYTES } from "@/services/updater/protocol";
import { SvupError, loadSvup } from "@/services/updater/svup";
import {
    FILE_MESSAGES, PAIR_RECORD_OFFSET, XIP_BASE, buildPairUf2, buildPlainUf2, isUf2, loadFirmwareFile, parsePairUf2,
} from "@/services/updater/uf2";

const fixture = (name: string) => new Uint8Array(gunzipSync(readFileSync(join(process.cwd(), "tests", "fixtures", "firmware", name))));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const PAIR = fixture("svalboard_sval_x4.uf2.gz");
const PER_SIDE = fixture("svalboard_left_sval_x3.1.3.uf2.gz");
const PAIR_SHA256 = "c650c9ac1665c4430cf80f4a7b1efd2adc9e7983f9b0168c96cd8f72d5d18c79";
const SVUP_SHA256 = "76dd058d00c2c559e1a4da680023809fe7f299fbcff18314add11e93ba3fda9d";
const IMAGE_LEN = 152320;

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function refused(bytes: Uint8Array): Promise<SvupError> {
    try {
        await loadFirmwareFile(bytes);
    } catch (e) {
        if (e instanceof SvupError) return e;
        throw e;
    }
    throw new Error("loaded");
}

describe("a pair UF2 built on the firmware branch", () => {
    it("is the file the firmware build made", () => {
        expect(sha256(PAIR)).toBe(PAIR_SHA256);
        expect(isUf2(PAIR)).toBe(true);
        expect(PAIR.length % 512).toBe(0);
    });

    it("gives exactly the manifest and image `make_update.py verify-pair --svup` writes", () => {
        const { manifestBytes, image } = parsePairUf2(PAIR);
        expect(manifestBytes.length).toBe(MANIFEST_BYTES);
        expect(image.length).toBe(IMAGE_LEN);
        const svup = new Uint8Array(MANIFEST_BYTES + image.length);
        svup.set(manifestBytes, 0);
        svup.set(image, MANIFEST_BYTES);
        expect(sha256(svup)).toBe(SVUP_SHA256);
    });

    it("loads as one file for both halves: hand 2, x4, version 9, release, hashes that match", async () => {
        const f = await loadFirmwareFile(PAIR);
        expect(f.manifest).toMatchObject({ hand: HAND_EITHER, tag: "x4", fwVersion: 9, release: true, diagnostic: false, imageLen: IMAGE_LEN });
        expect(f.imageHashOk).toBe(true);
        expect(f.buildInfo).toMatchObject({ hand: HAND_EITHER, tag: "x4", fwVersion: 9, release: true });
        expect(f.noChord).toBe(false);
        // Pins name the .uf2 itself.
        expect(f.sha256).toBe(PAIR_SHA256);
        expect(f.bytes).toBe(PAIR);
        // The same manifest and image as the svup form a host would send.
        const svup = await loadSvup(new Uint8Array([...f.manifestBytes, ...f.image]));
        expect(svup.crcBody).toBe(f.crcBody);
        expect([...svup.manifestSha512]).toEqual([...f.manifestSha512]);
    });

    it("is what Keybard's own builder writes for that manifest and image (the mock board's files)", () => {
        const { manifestBytes, image } = parsePairUf2(PAIR);
        expect(sha256(buildPairUf2(manifestBytes, image))).toBe(PAIR_SHA256);
    });

    it("has the record sector last, at 0x270000", () => {
        const count = PAIR.length / 512;
        for (let k = 0; k < 16; k++) expect(u32(PAIR, (count - 16 + k) * 512 + 12)).toBe(XIP_BASE + PAIR_RECORD_OFFSET + k * 256);
        expect(u32(PAIR, 12)).toBe(XIP_BASE);
    });
});

describe("files Keybard refuses", () => {
    it("an older per-side file (x3.1.3, no pair record): installs by hand, with the steps", async () => {
        expect(isUf2(PER_SIDE)).toBe(true);
        const e = await refused(PER_SIDE);
        expect(e.code).toBe("no-pair");
        expect(e.message).toBe(FILE_MESSAGES.noPair);
        expect(e.message).toMatch(/press its RESET button twice, then drag the file onto the RPI-RP2 drive/);
    });

    it("a plain UF2 of any image: no pair record", async () => {
        expect((await refused(buildPlainUf2(new Uint8Array(0x3000).fill(7)))).code).toBe("no-pair");
    });

    it("not a UF2 at all", async () => {
        expect((await refused(new TextEncoder().encode("hello".repeat(200)))).code).toBe("not-firmware");
        const { manifestBytes, image } = parsePairUf2(PAIR);
        // The svup form is not a file customers get any more.
        expect((await refused(new Uint8Array([...manifestBytes, ...image]))).code).toBe("not-firmware");
    });

    const recordPage = (b: Uint8Array) => (b.length / 512 - 16) * 512 + 32;

    it("a damaged record (CRC), a cut file, a renumbered block", async () => {
        const crc = PAIR.slice();
        crc[recordPage(crc) + 20] ^= 0x01;
        expect((await refused(crc)).code).toBe("damaged");
        expect((await refused(PAIR.slice(0, PAIR.length - 100))).code).toBe("damaged");
        const renumbered = PAIR.slice();
        renumbered[512 * 3 + 20] ^= 0x01;
        expect((await refused(renumbered)).code).toBe("damaged");
    });

    it("a record of a later version: newer than this Keybard", async () => {
        const { manifestBytes, image } = parsePairUf2(PAIR);
        const b = buildPairUf2(manifestBytes, image);
        const at = recordPage(b);
        b[at + 4] = 2;
        // Keep the CRC right, so only the version differs.
        const { crc32Mpeg2 } = await import("@/services/updater/svup");
        const crc = crc32Mpeg2(b.subarray(at, at + 124));
        b.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24], at + 124);
        expect((await refused(b)).code).toBe("newer");
    });

    it("a record for one side (hand 0): the boot relay refuses those, so does Keybard", async () => {
        const { manifestBytes, image } = parsePairUf2(PAIR);
        const one = manifestBytes.slice();
        one[7] = 0;
        expect((await refused(buildPairUf2(one, image))).code).toBe("one-side");
    });

    it("a changed image byte: loads, but its SHA-512 doesn't match (the sheet says it's damaged)", async () => {
        const b = PAIR.slice();
        b[32 + 0x200] ^= 0xff;
        const f = await loadFirmwareFile(b);
        expect(f.imageHashOk).toBe(false);
    });
});
