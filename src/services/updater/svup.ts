// The firmware a host installs: the 108-byte manifest and the raw image. Customers get
// them inside a pair UF2 (uf2.ts, loadFirmwareFile); the manifest followed by the image is
// the "svup" form make_update.py writes with --svup, which the tests and the mock board use.
// Layout: keyboards/svalboard/updater/update_manifest.h (sval_update_manifest_t).
// The image carries a 32-byte build-info record (update_build_info.h, magic "SVBI").

import { MANIFEST_BYTES, MANIFEST_FLAG_DIAGNOSTIC, MANIFEST_FLAG_RELEASE, hex, u16, u32 } from "./protocol";

export const SVUP_MAGIC = [0x53, 0x56, 0x55, 0x50]; // "SVUP"
export const SVUP_MANIFEST_VERSION = 2;
export const IMAGE_MIN = 0x200;
export const IMAGE_ALIGN = 0x100;
export const SVBI_MAGIC = [0x53, 0x56, 0x42, 0x49]; // "SVBI"
export const SVBI_INFO_VERSION = 3;
export const SVBI_BYTES = 32;
/** F-N1: the image is a no-chord developer build (build-info byte 5). */
export const BUILD_FLAG_NO_CHORD = 0x40;
export const BUILD_FLAG_RELEASE = 0x01;
/** D45: a dev build that keeps its settings across flashes (build-info byte 5); a release board refuses it. */
export const BUILD_FLAG_KEEP_SETTINGS = 0x80;

/** Why a file can't be installed, in a sentence for the customer. */
export type FileErrorCode = "not-firmware" | "no-pair" | "damaged" | "newer" | "one-side";

export class SvupError extends Error {
    constructor(message: string, readonly code: FileErrorCode = "damaged") {
        super(message);
        this.name = "SvupError";
    }
}

export interface SvupManifest {
    manifestVersion: number;
    hand: number;
    pointingId: number;
    keymapId: number;
    flags: number;
    release: boolean;
    diagnostic: boolean;
    securityEpoch: number;
    storageFormat: number;
    updaterProto: number;
    imageLen: number;
    fwVersion: number;
    /** The NUL-padded version string: the release tag. */
    tag: string;
    sha512: Uint8Array;
}

export interface BuildInfo {
    offset: number;
    infoVersion: number;
    flags: number;
    updaterProto: number;
    fwVersion: number;
    tag: string;
    hand: number;
    pointingId: number;
    noChord: boolean;
    keepSettings: boolean;
    release: boolean;
}

export interface SvupFile {
    /** The whole file as it was loaded (the pair UF2; the svup form in tests). */
    bytes: Uint8Array;
    manifestBytes: Uint8Array;
    image: Uint8Array;
    manifest: SvupManifest;
    buildInfo: BuildInfo | null;
    /** The image's build-info says it skips the approval chord (F-N1). */
    noChord: boolean;
    /** The image's build-info says it keeps its settings across flashes (a dev build, D45). */
    keepSettings: boolean;
    /** SHA-256 of the whole file (the pair UF2), lowercase hex: what pins name. */
    sha256: string;
    /** SHA-512 of the 108-byte manifest (ARM reports its first 4 bytes). */
    manifestSha512: Uint8Array;
    /** CRC-32/MPEG-2 over image bytes [0x100, len): COMMIT carries its low 16 bits. */
    crcBody: number;
    /** SHA-512 of the image matches the manifest's. */
    imageHashOk: boolean;
}

function cString(bytes: Uint8Array): string {
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end));
}

/** Parse the 108-byte manifest. Throws SvupError on a malformed one. */
export function parseManifest(m: Uint8Array): SvupManifest {
    if (m.length < MANIFEST_BYTES) throw new SvupError("This file is too short to be Svalboard firmware.", "not-firmware");
    if (!SVUP_MAGIC.every((b, i) => m[i] === b)) throw new SvupError("This isn't a Svalboard firmware file (.uf2).", "not-firmware");
    const manifestVersion = u16(m, 4);
    if (manifestVersion !== SVUP_MANIFEST_VERSION) throw new SvupError("This firmware file is newer than this Keybard knows. Reload Keybard to get a newer one.", "newer");
    const flags = u16(m, 10);
    const imageLen = u32(m, 16);
    return {
        manifestVersion,
        hand: m[7],
        pointingId: m[8],
        keymapId: m[9],
        flags,
        release: !!(flags & MANIFEST_FLAG_RELEASE),
        diagnostic: !!(flags & MANIFEST_FLAG_DIAGNOSTIC),
        securityEpoch: u16(m, 12),
        storageFormat: m[14],
        updaterProto: m[15],
        imageLen,
        fwVersion: u32(m, 20),
        tag: cString(m.subarray(28, 44)),
        sha512: m.slice(44, 108),
    };
}

/** Split a .svup into its manifest and image, checking the lengths agree. */
export function splitSvup(bytes: Uint8Array): { manifestBytes: Uint8Array; image: Uint8Array; manifest: SvupManifest } {
    const manifestBytes = bytes.slice(0, MANIFEST_BYTES);
    const manifest = parseManifest(manifestBytes);
    const image = bytes.subarray(MANIFEST_BYTES);
    if (manifest.imageLen !== image.length) throw new SvupError(`The file's image is ${image.length} bytes, its manifest says ${manifest.imageLen}.`);
    if (manifest.imageLen < IMAGE_MIN || manifest.imageLen % IMAGE_ALIGN) throw new SvupError(`Invalid image length ${manifest.imageLen}.`);
    return { manifestBytes, image, manifest };
}

/**
 * The image's build-info record: the first "SVBI" with info version 3. Null when
 * there is none (images from before the record, or not firmware at all).
 */
export function findBuildInfo(image: Uint8Array): BuildInfo | null {
    for (let i = 0; i + SVBI_BYTES <= image.length; i++) {
        if (image[i] !== 0x53 || image[i + 1] !== 0x56 || image[i + 2] !== 0x42 || image[i + 3] !== 0x49) continue;
        if (image[i + 4] !== SVBI_INFO_VERSION) continue;
        const flags = image[i + 5];
        return {
            offset: i,
            infoVersion: image[i + 4],
            flags,
            updaterProto: image[i + 7],
            fwVersion: u32(image, i + 8),
            tag: cString(image.subarray(i + 12, i + 28)),
            hand: image[i + 28],
            pointingId: image[i + 29],
            noChord: !!(flags & BUILD_FLAG_NO_CHORD),
            keepSettings: !!(flags & BUILD_FLAG_KEEP_SETTINGS),
            release: !!(flags & BUILD_FLAG_RELEASE),
        };
    }
    return null;
}

let crcTable: Uint32Array | null = null;

/** CRC-32/MPEG-2: poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, no final XOR. */
export function crc32Mpeg2(data: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n << 24;
            for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
            crcTable[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
    return crc >>> 0;
}

/** The image CRC the firmware reports and COMMIT carries: over [0x100, len). */
export const imageCrc = (image: Uint8Array): number => crc32Mpeg2(image.subarray(IMAGE_ALIGN));

async function digest(algorithm: "SHA-256" | "SHA-512", data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest(algorithm, data as BufferSource));
}

export const sha256Hex = async (data: Uint8Array): Promise<string> => hex(await digest("SHA-256", data));
export const sha512 = (data: Uint8Array): Promise<Uint8Array> => digest("SHA-512", data);

/** Parse the svup form (manifest then image) and compute everything the flow checks. Throws SvupError. */
export async function loadSvup(input: Uint8Array | ArrayBuffer): Promise<SvupFile> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const { manifestBytes, image, manifest } = splitSvup(bytes);
    return describeFile(bytes, manifestBytes, image, manifest);
}

/** Everything the flow checks about a manifest and its image; `bytes` is the file they came in. */
export async function describeFile(bytes: Uint8Array, manifestBytes: Uint8Array, image: Uint8Array, manifest: SvupManifest): Promise<SvupFile> {
    const buildInfo = findBuildInfo(image);
    const [sha256, manifestSha512, imageSha512] = await Promise.all([sha256Hex(bytes), sha512(manifestBytes), sha512(image)]);
    return {
        bytes,
        manifestBytes,
        image,
        manifest,
        buildInfo,
        noChord: !!buildInfo?.noChord,
        keepSettings: !!buildInfo?.keepSettings,
        sha256,
        manifestSha512,
        crcBody: imageCrc(image),
        imageHashOk: hex(imageSha512) === hex(manifest.sha512),
    };
}

// ---- building files (the mock board and the tests) --------------------------------------

export interface BuildSvupOptions {
    hand: number;
    fwVersion: number;
    tag: string;
    imageLen?: number;
    pointingId?: number;
    flags?: number;
    securityEpoch?: number;
    storageFormat?: number;
    updaterProto?: number;
    /** Build-info flags (BUILD_FLAG_*); the record is written at 0x400 unless null. */
    buildFlags?: number | null;
    /** Mixed into the image bytes so two builds of one release differ. */
    seed?: number;
}

/** A synthetic but well-formed .svup: valid manifest, SHA-512 and build info. */
export async function buildSvup(o: BuildSvupOptions): Promise<Uint8Array> {
    const imageLen = o.imageLen ?? 0x1000;
    const image = new Uint8Array(imageLen);
    let x = (o.seed ?? 1) * 2654435761 + o.fwVersion * 40503 + o.hand;
    for (let i = 0; i < imageLen; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        image[i] = x >>> 24;
    }
    if (o.buildFlags !== null && imageLen >= 0x400 + SVBI_BYTES) {
        const bi = new Uint8Array(SVBI_BYTES);
        bi.set(SVBI_MAGIC, 0);
        bi[4] = SVBI_INFO_VERSION;
        bi[5] = o.buildFlags ?? 0;
        bi[7] = o.updaterProto ?? 4;
        bi.set([o.fwVersion & 0xff, (o.fwVersion >>> 8) & 0xff, (o.fwVersion >>> 16) & 0xff, (o.fwVersion >>> 24) & 0xff], 8);
        bi.set(new TextEncoder().encode(o.tag.slice(0, 16)), 12);
        bi[28] = o.hand;
        bi[29] = o.pointingId ?? 5;
        bi[30] = 1;
        image.set(bi, 0x400);
    }
    const m = new Uint8Array(MANIFEST_BYTES);
    m.set(SVUP_MAGIC, 0);
    m[4] = SVUP_MANIFEST_VERSION;
    m[7] = o.hand;
    m[8] = o.pointingId ?? 5;
    m[9] = 1;
    const flags = o.flags ?? MANIFEST_FLAG_RELEASE;
    m[10] = flags & 0xff;
    m[11] = flags >>> 8;
    const epoch = o.securityEpoch ?? 0;
    m[12] = epoch & 0xff;
    m[13] = epoch >>> 8;
    m[14] = o.storageFormat ?? 2;
    m[15] = o.updaterProto ?? 4;
    m.set([imageLen & 0xff, (imageLen >>> 8) & 0xff, (imageLen >>> 16) & 0xff, (imageLen >>> 24) & 0xff], 16);
    m.set([o.fwVersion & 0xff, (o.fwVersion >>> 8) & 0xff, (o.fwVersion >>> 16) & 0xff, (o.fwVersion >>> 24) & 0xff], 20);
    m.set(new TextEncoder().encode(o.tag.slice(0, 16)), 28);
    m.set(await sha512(image), 44);
    const out = new Uint8Array(MANIFEST_BYTES + imageLen);
    out.set(m, 0);
    out.set(image, MANIFEST_BYTES);
    return out;
}
