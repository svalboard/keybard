// Pair UF2 files: one file per release that installs both halves (x4 and later).
//
// Source of truth: docs/pair-uf2.md and keyboards/svalboard/tools/make_update.py
// (parse_pair_uf2, pair_uf2_bytes) in svalboard/qmk. A standard RP2040 UF2:
//   blocks 0..M-1     the image from flash offset 0, 0xFF up to a whole 4 KiB sector
//   blocks M..M+15    the pair record sector at flash offset 0x270000: page 0 the
//                     record (magic "SVPU", version 1, length 128, kind 1, image
//                     offset 0, the 108-byte manifest, CRC-32/MPEG-2), the rest 0xFF
// Keybard reads the manifest and the image out of it and installs both halves with
// them through the updater (protocol 4), exactly what `make_update.py verify-pair
// FILE.uf2 --svup OUT.svup` writes. A UF2 without the record (the per-side files
// releases had before x4) is refused: it installs by hand only.

import { HAND_EITHER, MANIFEST_BYTES } from "./protocol";
import { IMAGE_ALIGN, IMAGE_MIN, SvupError, crc32Mpeg2, describeFile, parseManifest, type SvupFile } from "./svup";

export const UF2_MAGIC0 = 0x0a324655;
export const UF2_MAGIC1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;
export const UF2_FLAG_FAMILY = 0x00002000;
export const RP2040_FAMILY = 0xe48bff56;
export const XIP_BASE = 0x10000000;
export const PAIR_RECORD_OFFSET = 0x270000;
export const PAIR_MAGIC = 0x55505653; // "SVPU"
export const PAIR_RECORD_VERSION = 1;
export const PAIR_KIND_RELAY_SELF = 1;
export const PAIR_RECORD_BYTES = 128;
/** SVAL_UPDATE_MAX_IMAGE: the firmware area. */
export const MAX_IMAGE = 0x160000;

const BLOCK = 512;
const PAGE = 256;
const SECTOR = 4096;
const PAGES_PER_SECTOR = SECTOR / PAGE;

export const FILE_MESSAGES = {
    notFirmware: "This isn't a Svalboard firmware file (.uf2).",
    noPair: "Keybard installs only firmware files that update both halves, from x4 on. To install this file by hand, plug in the half it's for, press its RESET button twice, then drag the file onto the RPI-RP2 drive.",
    damaged: "This firmware file is damaged. Download it again, then choose it.",
    newer: "This firmware file is newer than this Keybard knows. Reload Keybard to get a newer one.",
    oneSide: "This firmware file is for one half only. Keybard installs only firmware files that update both halves, from x4 on.",
} as const;

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

/** The file starts like a UF2 block. */
export function isUf2(bytes: Uint8Array): boolean {
    return bytes.length >= BLOCK && u32(bytes, 0) === UF2_MAGIC0 && u32(bytes, 4) === UF2_MAGIC1;
}

export interface PairUf2 {
    /** The 108-byte manifest from the record. */
    manifestBytes: Uint8Array;
    /** The image: the first image_len bytes of the image area. */
    image: Uint8Array;
}

/**
 * The manifest and the image of a pair UF2, refusing any other layout (make_update.py
 * parse_pair_uf2). Throws SvupError with a sentence for the customer. The image's
 * SHA-512 is checked by the caller (loadFirmwareFile), as for any file.
 */
export function parsePairUf2(data: Uint8Array): PairUf2 {
    if (!isUf2(data)) throw new SvupError(FILE_MESSAGES.notFirmware, "not-firmware");
    if (data.length % BLOCK) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
    const count = data.length / BLOCK;
    const addrs: number[] = [];
    for (let i = 0; i < count; i++) {
        const o = i * BLOCK;
        if (u32(data, o) !== UF2_MAGIC0 || u32(data, o + 4) !== UF2_MAGIC1 || u32(data, o + 508) !== UF2_MAGIC_END) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
        const flags = u32(data, o + 8);
        const size = u32(data, o + 16);
        const family = u32(data, o + 28);
        // Not an RP2040 flash UF2 at all, or a layout only a host tool writes: not one Keybard installs.
        if (flags !== UF2_FLAG_FAMILY || family !== RP2040_FAMILY || size !== PAGE) throw new SvupError(FILE_MESSAGES.noPair, "no-pair");
        if (u32(data, o + 20) !== i || u32(data, o + 24) !== count) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
        addrs.push(u32(data, o + 12) - XIP_BASE);
    }
    // The pair layout: the image from offset 0 in whole sectors, then the record sector. Anything
    // else (a per-side release file, any other UF2) has no record: it installs by hand.
    const recordAt = count - PAGES_PER_SECTOR;
    const isPairLayout = count % PAGES_PER_SECTOR === 0 && count >= 2 * PAGES_PER_SECTOR &&
        addrs.every((a, i) => (i < recordAt ? a === i * PAGE : a === PAIR_RECORD_OFFSET + (i - recordAt) * PAGE));
    if (!isPairLayout) throw new SvupError(FILE_MESSAGES.noPair, "no-pair");
    const page = (i: number) => data.subarray(i * BLOCK + 32, i * BLOCK + 32 + PAGE);
    const sector = new Uint8Array(SECTOR);
    for (let k = 0; k < PAGES_PER_SECTOR; k++) sector.set(page(recordAt + k), k * PAGE);
    if (u32(sector, 0) !== PAIR_MAGIC) throw new SvupError(FILE_MESSAGES.noPair, "no-pair");
    if (crc32Mpeg2(sector.subarray(0, PAIR_RECORD_BYTES - 4)) !== u32(sector, PAIR_RECORD_BYTES - 4)) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
    if (u16(sector, 4) !== PAIR_RECORD_VERSION) throw new SvupError(FILE_MESSAGES.newer, "newer");
    if (u16(sector, 6) !== PAIR_RECORD_BYTES || sector[8] !== PAIR_KIND_RELAY_SELF || sector[9] || sector[10] || sector[11] || u32(sector, 12) !== 0) {
        throw new SvupError(FILE_MESSAGES.damaged, "damaged");
    }
    for (let i = PAIR_RECORD_BYTES; i < SECTOR; i++) if (sector[i] !== 0xff) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
    if (recordAt * PAGE > MAX_IMAGE) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
    const manifestBytes = sector.slice(16, 16 + MANIFEST_BYTES);
    const manifest = parseManifest(manifestBytes);
    if (manifest.hand !== HAND_EITHER) throw new SvupError(FILE_MESSAGES.oneSide, "one-side");
    const area = new Uint8Array(recordAt * PAGE);
    for (let i = 0; i < recordAt; i++) area.set(page(i), i * PAGE);
    const n = manifest.imageLen;
    if (n < IMAGE_MIN || n > area.length || area.length - n >= SECTOR || n % IMAGE_ALIGN) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
    for (let i = n; i < area.length; i++) if (area[i] !== 0xff) throw new SvupError(FILE_MESSAGES.damaged, "damaged");
    return { manifestBytes, image: area.slice(0, n) };
}

/**
 * A firmware file as customers get it: a pair UF2 (x4 and later), one file for both halves.
 * Throws SvupError with a sentence to show: not firmware, a UF2 without the pair record
 * (an older per-side file, which installs by hand), or damaged.
 */
export async function loadFirmwareFile(input: Uint8Array | ArrayBuffer): Promise<SvupFile> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const { manifestBytes, image } = parsePairUf2(bytes);
    return describeFile(bytes, manifestBytes, image, parseManifest(manifestBytes));
}

function block(addr: number, payload: Uint8Array, blockNo: number, numBlocks: number): Uint8Array {
    const b = new Uint8Array(BLOCK);
    const v = new DataView(b.buffer);
    [UF2_MAGIC0, UF2_MAGIC1, UF2_FLAG_FAMILY, addr, PAGE, blockNo, numBlocks, RP2040_FAMILY].forEach((x, i) => v.setUint32(i * 4, x, true));
    b.set(payload, 32);
    v.setUint32(508, UF2_MAGIC_END, true);
    return b;
}

/** The pair record (page 0 of its sector) for a manifest. */
export function pairRecord(manifestBytes: Uint8Array): Uint8Array {
    const r = new Uint8Array(PAIR_RECORD_BYTES);
    const v = new DataView(r.buffer);
    v.setUint32(0, PAIR_MAGIC, true);
    v.setUint16(4, PAIR_RECORD_VERSION, true);
    v.setUint16(6, PAIR_RECORD_BYTES, true);
    r[8] = PAIR_KIND_RELAY_SELF;
    r.set(manifestBytes.subarray(0, MANIFEST_BYTES), 16);
    v.setUint32(PAIR_RECORD_BYTES - 4, crc32Mpeg2(r.subarray(0, PAIR_RECORD_BYTES - 4)), true);
    return r;
}

/** A pair UF2 for a manifest and its image, as make_update.py pair writes it (the mock board and the tests). */
export function buildPairUf2(manifestBytes: Uint8Array, image: Uint8Array): Uint8Array {
    const padded = new Uint8Array(Math.ceil(image.length / SECTOR) * SECTOR).fill(0xff);
    padded.set(image);
    const record = new Uint8Array(SECTOR).fill(0xff);
    record.set(pairRecord(manifestBytes));
    const pages: Array<[number, Uint8Array]> = [];
    for (let i = 0; i < padded.length; i += PAGE) pages.push([XIP_BASE + i, padded.subarray(i, i + PAGE)]);
    for (let i = 0; i < SECTOR; i += PAGE) pages.push([XIP_BASE + PAIR_RECORD_OFFSET + i, record.subarray(i, i + PAGE)]);
    const out = new Uint8Array(pages.length * BLOCK);
    pages.forEach(([addr, data], n) => out.set(block(addr, data, n, pages.length), n * BLOCK));
    return out;
}

/** A plain UF2 of an image, as QMK writes one per side (no record): for the refusal tests and the mock. */
export function buildPlainUf2(image: Uint8Array): Uint8Array {
    const n = Math.ceil(image.length / PAGE);
    const out = new Uint8Array(n * BLOCK);
    for (let i = 0; i < n; i++) {
        const payload = new Uint8Array(PAGE);
        payload.set(image.subarray(i * PAGE, (i + 1) * PAGE));
        out.set(block(XIP_BASE + i * PAGE, payload, i, n), i * BLOCK);
    }
    return out;
}
