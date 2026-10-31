import { withTouchpadTaps } from "@/utils/touchpad-taps";
import { hasPadTouch as hasPadTouchFlag, PAD_TOUCH_PAGE, parsePadTouch, type PadTouchReport } from "@/utils/touchpad-tuning";
import { LabelService } from "./label.service";
import { KleService } from "./kle.service";
import { keyService } from "./key.service";
import { activeKeycodeVersion, applyKeycodeNumbering, UNREPORTED_KEYCODE_VERSION } from '@/constants/keycode-numbering';
import { SVIL_DEFINITION_HEADER_BYTES, SVIL_TABLE_ALT_REPEAT_KEY, VIA_BUFFER_HEADER_BYTES, SVIL_TABLE_LEADER, SvilUSB, checkSvilStatus, readSvilTable, svilHasMacroBuffer, svilIndexArgs, usbInstance } from "./usb.service";
import { LE16 } from "./utils";
import { payloadCapacity } from "./hid-report";

import LZMA from "js-lzma";
import { assertSupportedSvilProto } from "@/utils/unsupported-firmware";
import { CMD_SVIL_FLICKER_LATCH, FLICKER_COUNTS, FLICKER_READ, hasFlickerLatch, parseFlickerCounts, parseFlickerRead, type FlickerCounts, type FlickerRead } from "@/services/flicker-latch";
import { CMD_SVIL_TYPING_PAUSE, hasTypingPause, parseTypingPauseReply, type TypingPauseReply } from "@/services/typing-pause";
import { parsePointingHardware, SVIL_FLAG2_POINTING_HARDWARE } from "@/utils/pointing-hardware";
import { parsePointingContacts, SVIL_FLAG2_POINTING_CONTACTS, withPadContacts, type PointingContactsReport } from "@/utils/pointing-contacts";
import { KEYBARD_MOTION_READER, parsePointingMotion, SVIL_FLAG2_POINTING_MOTION, SVIL_FLAG2_POINTING_MOTION_READERS, type PointingMotionReport } from "@/utils/pointing-motion";
import type { KeyboardInfo, AltRepeatKeyEntry, LeaderEntry } from "../types/keyboard.types";

// Svil feature flags (from protocol info response)
// CAPS_WORD = 0x01, LAYER_LOCK = 0x02 - not currently used
const SVIL_FLAG_ONESHOT = 0x04;
const SVIL_FLAG_LEADER = 0x08;
const SVIL_FLAG_DEFAULT_LAYER_STATE = 0x40;
// Second feature byte
const SVIL_FLAG2_DEFAULT_LAYER_SET = 0x01;
import { ComboService } from "./combo.service";
import { FragmentComposerService } from "./fragment-composer.service";
import { FragmentService } from "./fragment.service";
import { MacroService } from "./macro.service";
import { OverrideService } from "./override.service";
import { QMKService } from "./qmk.service";
import { svalService } from "./sval.service";
import { TapdanceService } from "./tapdance.service";

// Stream wrapper for js-lzma (Svil uses raw LZMA, not XZ container)
class LZMAInStream {
    private data: Uint8Array;
    private offset: number = 0;

    constructor(data: Uint8Array) {
        this.data = data;
    }

    readByte(): number {
        if (this.offset >= this.data.length) {
            return -1;
        }
        return this.data[this.offset++];
    }
}

class LZMAOutStream {
    private buffer: number[] = [];

    writeByte(byte: number): void {
        this.buffer.push(byte);
    }

    getBytes(): Uint8Array {
        return new Uint8Array(this.buffer);
    }
}

// Raw LZMA header: properties byte, 4-byte dictionary size, 8-byte uncompressed size
const LZMA_HEADER_SIZE = 13;
// The properties byte is (pb * 5 + lp) * 9 + lc with lc <= 8, lp <= 4, pb <= 4
const LZMA_MAX_PROPERTIES = 9 * 5 * 5 - 1;

// LZMA decompression helper
async function decompress(buffer: ArrayBuffer): Promise<string> {
    // js-lzma doesn't validate the header: an empty or garbage buffer sends it
    // into an endless loop that ends in V8's "Too many properties to enumerate".
    const header = new Uint8Array(buffer);
    if (header.length < LZMA_HEADER_SIZE || header[0] > LZMA_MAX_PROPERTIES) {
        throw new Error(`The keyboard sent an unreadable keyboard definition (${header.length} bytes). Reconnect the keyboard; if this keeps happening, update its firmware.`);
    }
    try {
        const compressed = new Uint8Array(buffer);
        const inStream = new LZMAInStream(compressed);
        const outStream = new LZMAOutStream();

        LZMA.decompressFile(inStream, outStream);

        const decoder = new TextDecoder();
        return decoder.decode(outStream.getBytes());
    } catch (error) {
        console.error("LZMA decompression failed:", error);
        console.error("Buffer size:", buffer.byteLength);
        console.error("Buffer preview:", new Uint8Array(buffer).slice(0, 32));
        throw error;
    }
}

/**
 * KeyboardService - Keyboard configuration service using the Svil protocol
 *
 * The Svil protocol extends VIA3 with additional features:
 * - Alt Repeat Key, Leader sequences, One-shot settings
 * - Client ID wrapper for multi-client concurrent access
 * - Dynamic keyboard definitions with custom UI menus
 */
export class KeyboardService {
    private usb: SvilUSB;
    private macro: MacroService;
    private tapdance: TapdanceService;
    private combo: ComboService;
    private override: OverrideService;
    private qmk: QMKService;
    private kle: KleService;
    private fragment: FragmentService;
    private fragmentComposer: FragmentComposerService;

    constructor(usb: SvilUSB) {
        this.usb = usb;
        this.macro = new MacroService(usb);
        this.tapdance = new TapdanceService(usb);
        this.combo = new ComboService(usb);
        this.override = new OverrideService(usb);
        this.qmk = new QMKService(usb);
        this.kle = new KleService();
        this.fragment = new FragmentService(usb);
        this.fragmentComposer = new FragmentComposerService(this.kle, this.fragment);
    }

    static isWebHIDSupported(): boolean {
        return "hid" in navigator;
    }

    async init(_kbinfo: KeyboardInfo): Promise<void> {
        // Initialization hook for API setup
    }

    async load(kbinfo: KeyboardInfo): Promise<KeyboardInfo> {
        // Load keyboard information
        await this.getKeyboardInfo(kbinfo);

        // Number keycodes the way this board does, then register its custom
        // keycodes (SV_...) from the keyboard definition on top.
        if (!applyKeycodeNumbering(kbinfo.keycode_version!)) {
            console.warn(`Keybard has no keycode numbering for QMK keycodes ${kbinfo.keycode_version}; using ${activeKeycodeVersion()}. Keycodes QMK renumbered since then may be wrong.`);
        }
        keyService.generateAllKeycodes(kbinfo);

        // Populate keylayout using KLE service if payload exists
        if (kbinfo.payload && kbinfo.payload.layouts && kbinfo.payload.layouts.keymap) {
            try {
                (kbinfo as any).keylayout = this.kle.deserializeToKeylayout(kbinfo, kbinfo.payload.layouts.keymap as unknown as any[]);
            } catch (e) {
                console.error("Failed to deserialize keylayout:", e);
            }
        }

        // Check for Svalboard-specific features
        const isSval = await svalService.check(kbinfo);
        if (isSval) {
            console.log("Svalboard detected, proto:", kbinfo.sval_proto, "firmware:", kbinfo.sval_firmware);
            await svalService.pull(kbinfo);
            // Sync hardware layer colors to cosmetic colors for UI display
            svalService.syncCosmeticLayerColors(kbinfo);
        }

        // Set up default cosmetic layer names
        svalService.setupCosmeticLayerNames(kbinfo);

        // Load features (combos, macros, etc.)
        await this.getFeatures(kbinfo);

        // Get keymap for all layers
        await this.getKeyMap(kbinfo);
        // getKeyMap establishes the layer count needed to accept stored labels.
        await new LabelService(this.usb).loadLayerNames(kbinfo);
        await this.macro.get(kbinfo);
        await this.tapdance.get(kbinfo);
        await this.combo.get(kbinfo);
        await this.override.get(kbinfo);
        await new LabelService(this.usb).loadBindingNames(kbinfo);

        // Load Svil-specific features based on feature flags
        // Alt Repeat Keys don't have a flag - check entry count from definition
        if (kbinfo.alt_repeat_key_count && kbinfo.alt_repeat_key_count > 0) {
            try {
                await this.getAltRepeatKeys(kbinfo);
            } catch (e) {
                console.warn("Alt Repeat Keys not available:", e);
            }
        }

        // Leaders require LEADER flag (0x08)
        const flags = kbinfo.feature_flags ?? 0;
        if ((flags & SVIL_FLAG_LEADER) && kbinfo.leader_count && kbinfo.leader_count > 0) {
            try {
                await this.getLeaders(kbinfo);
            } catch (e) {
                console.warn("Leaders not available:", e);
            }
        }

        // One-shot requires ONESHOT flag (0x04)
        if (flags & SVIL_FLAG_ONESHOT) {
            try {
                await this.getOneShot(kbinfo);
            } catch (e) {
                console.warn("One-shot settings not available:", e);
            }
        }

        await this.getPointingHardware(kbinfo);

        // Load fragment data (hardware detection and EEPROM selections)
        if (this.fragment.hasFragments(kbinfo)) {
            try {
                await this.fragment.get(kbinfo);
                // Compose keyboard layout from fragments
                const composedLayout = this.fragmentComposer.composeLayout(kbinfo);
                if (Object.keys(composedLayout).length > 0) {
                    kbinfo.keylayout = composedLayout;
                    console.log("Fragment layout composed:", Object.keys(composedLayout).length, "keys");
                }
            } catch (e) {
                console.warn("Fragments not available:", e);
            }
        }

        return kbinfo;
    }

    async getKeyboardInfo(kbinfo: KeyboardInfo): Promise<KeyboardInfo> {
        // VIA Protocol version (via wrapped VIA command)
        kbinfo.via_proto = (await this.usb.send(SvilUSB.CMD_VIA_GET_PROTOCOL_VERSION, [], {
            unpack: "B>H",
            index: 1,
        })) as number;

        // Get Svil protocol info
        const svilInfo = await this.usb.sendSvil(SvilUSB.CMD_SVIL_GET_INFO, [], {
            uint8: true,
        });

        // Parse Svil info response:
        // Response format after wrapper stripped:
        // [cmd_echo][protocol_version:4][uid:8][feature_flags:1][keycodes major, minor, patch][storage flags]
        const dv = new DataView((svilInfo as Uint8Array).buffer);
        kbinfo.svil_proto = dv.getUint32(1, true); // Skip cmd_echo
        // Table and label requests switch to 2-byte indices from v2 on
        this.usb.svilProtocolVersion = kbinfo.svil_proto;
        kbinfo.feature_flags = svilInfo[13]; // Skip cmd_echo
        // [feature_flags2:1] follows the storage flags byte; older firmware sends zero.
        kbinfo.feature_flags2 = svilInfo[18] ?? 0;
        // [feature_flags3:1] (GET_INFO byte 20) after it; older firmware sends zero.
        kbinfo.feature_flags3 = svilInfo[19] ?? 0;
        // The QMK keycode numbering the board uses; older firmware sends zeros.
        const keycodeVersion = Array.from((svilInfo as Uint8Array).slice(14, 17));
        kbinfo.keycode_version_reported = keycodeVersion.some(Boolean);
        kbinfo.keycode_version = kbinfo.keycode_version_reported ? keycodeVersion.join('.') : UNREPORTED_KEYCODE_VERSION;
        // Storage flags; older firmware sends zero.
        // Bit 0: the board reset its settings because its storage could not be read,
        // until the host clears it (CMD_SVIL_STORAGE_RESET_CLEAR).
        // Bit 1: since it started, the board couldn't save a change to flash. It still
        // shows the change but loses it on restart; only a restart clears this.
        kbinfo.storage_reset = !!(svilInfo[17] & 1);
        kbinfo.storage_write_failed = !!(svilInfo[17] & 2);
        // Bit 2: the first boot of a different firmware build reset every setting (D39),
        // until the host clears it (CMD_SVIL_STORAGE_RESET_CLEAR) after acting on it.
        kbinfo.storage_build_reset = !!(svilInfo[17] & 4);
        // Nothing past here is safe on a board that isn't speaking Sval protocol 3+
        assertSupportedSvilProto(kbinfo.svil_proto);

        // Extract UID as hex string for kbid
        // UID is stored as little-endian 64-bit integer, so reverse bytes for hex string
        const uidBytes = (svilInfo as Uint8Array).slice(5, 13); // Skip cmd_echo + protocol_version
        kbinfo.kbid = Array.from(uidBytes).reverse().map(b => b.toString(16).padStart(2, '0')).join('');

        // Get compressed JSON payload size via Svil protocol
        // Response format after wrapper stripped: [cmd_echo][size0][size1][size2][size3]
        const sizeResp = await this.usb.sendSvil(SvilUSB.CMD_SVIL_DEFINITION_SIZE, [], {
            uint32: true,
            index: 1, // Skip command echo byte
        });
        const payload_size = sizeResp as number;

        if (payload_size < LZMA_HEADER_SIZE || payload_size > 50 * 1024 * 1024) { // Safety sanity check (50MB)
            throw new Error(`Invalid payload size: ${payload_size}`);
        }

        // Fetch definition in chunks using Svil protocol, as large as the report
        // allows (22 bytes at 32, 54 at 64). The firmware may clamp a chunk below
        // what was asked, so a short chunk is not the end of the definition.
        const chunkSize = payloadCapacity(this.usb, SVIL_DEFINITION_HEADER_BYTES);
        const payload = new ArrayBuffer(payload_size);
        const pdv = new DataView(payload);
        let offset = 0;

        while (offset < payload_size) {
            const requestSize = Math.min(chunkSize, payload_size - offset);
            const resp = await this.usb.sendSvil(
                SvilUSB.CMD_SVIL_DEFINITION_CHUNK,
                [...LE16(offset), requestSize],
                { uint8: true }
            );

            const data = resp as Uint8Array;
            // Response format after wrapper stripped: [cmd_echo][offset_lo][offset_hi][actual_size][data...]
            const actualSize = Math.min(data[3], requestSize);
            for (let i = 0; i < actualSize && offset < payload_size; i++) {
                pdv.setInt8(offset, data[4 + i]);
                offset++;
            }

            if (actualSize === 0) break; // End of data
        }

        // Decompress and parse JSON
        const decompressed = await decompress(payload);
        const payloadData = JSON.parse(decompressed);
        kbinfo.payload = payloadData;

        kbinfo.rows = payloadData.matrix.rows;
        kbinfo.cols = payloadData.matrix.cols;
        kbinfo.custom_keycodes = payloadData.customKeycodes;

        // Extract keyboard name from definition
        if (payloadData.name) {
            kbinfo.name = payloadData.name;
        }

        // Extract Svil feature counts from the definition
        const featureCounts = payloadData.sval ?? payloadData.viable;
        if (featureCounts) {
            kbinfo.tapdance_count = featureCounts.tap_dance || 0;
            kbinfo.combo_count = featureCounts.combo || 0;
            kbinfo.key_override_count = featureCounts.key_override || 0;
            kbinfo.alt_repeat_key_count = featureCounts.alt_repeat_key || 0;
            kbinfo.leader_count = featureCounts.leader || 0;
        }

        // Extract fragments and composition for modular layouts
        if (payloadData.fragments) {
            kbinfo.fragments = payloadData.fragments;
        }
        if (payloadData.composition) {
            kbinfo.composition = payloadData.composition;
        }

        // Extract VIA3 custom UI menus for dynamic settings panels
        if (payloadData.menus && Array.isArray(payloadData.menus)) {
            // Firmware with the touchpad tap setting: its switches join the pointing menu.
            kbinfo.menus = withTouchpadTaps(payloadData.menus, kbinfo.feature_flags3);
            console.log("Loaded custom UI menus:", payloadData.menus.map((m: { label?: string }) => m.label).filter(Boolean));
        }

        return kbinfo;
    }

    async getFeatures(kbinfo: KeyboardInfo): Promise<void> {
        // Get macro info via VIA commands (wrapped)
        // Response: [cmd_echo][count lo][count hi]. 256-macro firmware sends the high
        // byte; older firmware leaves it zero, so the same read works for both.
        const countResp = await this.usb.send(SvilUSB.CMD_VIA_MACRO_GET_COUNT, [], { uint8: true }) as Uint8Array;
        const macro_count = countResp[1] | (countResp[2] << 8);

        // v3+: the macro buffer can outgrow VIA's 16-bit size, so ask Sval for the 32-bit one.
        // Response format after wrapper stripped: [cmd_echo][size:4]
        const macros_size = svilHasMacroBuffer(this.usb.svilProtocolVersion)
            ? (await this.usb.sendSvil(SvilUSB.CMD_SVIL_MACRO_BUFFER_SIZE, [], { uint32: true, index: 1 })) as number
            : (await this.usb.send(SvilUSB.CMD_VIA_MACRO_GET_BUFFER_SIZE, [], {
                unpack: "B>H",
                index: 1,
            })) as number;

        kbinfo.macro_count = macro_count;
        kbinfo.macros_size = macros_size;

        // Feature counts are already loaded from viable.json in getKeyboardInfo
    }

    async getKeyMap(kbinfo: KeyboardInfo): Promise<void> {
        kbinfo.layers = await this.usb.send(SvilUSB.CMD_VIA_GET_LAYER_COUNT, [], {
            uint8: true,
            index: 1,
        });

        if (!kbinfo.layers) {
            throw new Error("Failed to get layer count");
        }

        const size = kbinfo.layers * kbinfo.rows * kbinfo.cols;

        // Get keymap data as uint16 array (big-endian converted to host endian)
        const alldata = await this.usb.getViaBuffer(SvilUSB.CMD_VIA_KEYMAP_GET_BUFFER, size * 2, { uint16: true, slice: 2, bigendian: true, bytes: 2 });

        kbinfo.keymap = [];

        if (!Array.isArray(alldata)) {
            throw new Error("Expected array of keycodes from getViaBuffer");
        }

        for (let l = 0; l < kbinfo.layers; l++) {
            const layer: number[] = [];
            for (let r = 0; r < kbinfo.rows; r++) {
                for (let c = 0; c < kbinfo.cols; c++) {
                    const offset = l * kbinfo.rows * kbinfo.cols + r * kbinfo.cols + c;
                    const keycode = alldata[offset];
                    layer.push(keycode);
                }
            }
            kbinfo.keymap[l] = layer;
        }
    }

    /**
     * Get Alt Repeat Key entries from keyboard
     */
    async getAltRepeatKeys(kbinfo: KeyboardInfo): Promise<void> {
        if (!kbinfo.alt_repeat_key_count) return;

        kbinfo.alt_repeat_keys = [];
        // Scan (v3+) or per-index get
        const entries = await readSvilTable(this.usb, SVIL_TABLE_ALT_REPEAT_KEY, kbinfo.alt_repeat_key_count);
        for (let i = 0; i < kbinfo.alt_repeat_key_count; i++) {
            const data = entries[i];

            // Entry: [keycode:2][alt_keycode:2][allowed_mods][options]
            const dv = new DataView(data.buffer);
            const entry: AltRepeatKeyEntry = {
                arkid: i,
                keycode: keyService.stringify(dv.getUint16(0, true)),
                alt_keycode: keyService.stringify(dv.getUint16(2, true)),
                allowed_mods: data[4],
                options: data[5],
            };
            kbinfo.alt_repeat_keys.push(entry);
        }
    }

    /**
     * Get Leader sequence entries from keyboard
     */
    async getLeaders(kbinfo: KeyboardInfo): Promise<void> {
        if (!kbinfo.leader_count) return;

        kbinfo.leaders = [];
        // Scan (v3+) or per-index get
        const entries = await readSvilTable(this.usb, SVIL_TABLE_LEADER, kbinfo.leader_count);
        for (let i = 0; i < kbinfo.leader_count; i++) {
            const data = entries[i];

            // Entry: [seq0:2][seq1:2][seq2:2][seq3:2][seq4:2][output:2][options:2]
            const dv = new DataView(data.buffer);
            const sequence: string[] = [];
            for (let j = 0; j < 5; j++) {
                const kc = dv.getUint16(j * 2, true);
                if (kc !== 0) {
                    sequence.push(keyService.stringify(kc));
                }
            }

            const entry: LeaderEntry = {
                ldrid: i,
                sequence,
                output: keyService.stringify(dv.getUint16(10, true)),
                options: dv.getUint16(12, true),
            };
            kbinfo.leaders.push(entry);
        }
    }

    /**
     * Get One-shot settings from keyboard
     */
    async getOneShot(kbinfo: KeyboardInfo): Promise<void> {
        const data = await this.usb.sendSvil(
            SvilUSB.CMD_SVIL_ONE_SHOT_GET,
            [],
            { uint8: true }
        ) as Uint8Array;

        // Response format after wrapper stripped: [cmd_echo][timeout:2][tap_toggle]
        const dv = new DataView(data.buffer);
        kbinfo.one_shot = {
            timeout: dv.getUint16(1, true), // Skip cmd_echo
            tap_toggle: data[3],
        };
    }

    async pollMatrix(kbinfo: KeyboardInfo): Promise<boolean[][]> {
        const data = await this.usb.send(SvilUSB.CMD_VIA_GET_KEYBOARD_VALUE, [SvilUSB.VIA_SWITCH_MATRIX_STATE], {}) as Uint8Array;
        const rowbytes = Math.ceil(kbinfo.cols / 8);

        // Skip first 3 bytes: cmd echo, value ID, offset byte (matches viable-gui)
        let offset = 0;
        if (data[0] === SvilUSB.CMD_VIA_GET_KEYBOARD_VALUE && data[1] === SvilUSB.VIA_SWITCH_MATRIX_STATE) {
            offset = 3;
        }

        const kmpressed: boolean[][] = [];
        for (let row = 0; row < kbinfo.rows; row++) {
            const rowpressed: boolean[] = [];
            if (offset + rowbytes > data.length) {
                break;
            }
            const coldata = data.slice(offset, offset + rowbytes);
            for (let col = 0; col < kbinfo.cols; col++) {
                // Reverse byte order within row (matches viable-gui)
                const colbyte = rowbytes - 1 - Math.floor(col / 8);
                const colbit = 1 << (col % 8);

                if (colbyte >= 0 && colbyte < coldata.length) {
                    rowpressed.push((coldata[colbyte] & colbit) !== 0);
                } else {
                    rowpressed.push(false);
                }
            }
            offset += rowbytes;
            kmpressed.push(rowpressed);
        }
        return kmpressed;
    }

    /** Whether the board can pause its typing while the matrix tester is open (TYPING_PAUSE). */
    hasTypingPause(kbinfo: KeyboardInfo | null | undefined): boolean {
        return hasTypingPause(kbinfo?.feature_flags3);
    }

    /**
     * TYPING_PAUSE (0x3C): op 0 off, 1 on (or renew), 2 status. Null on a reply
     * that isn't one (firmware without the command answers 0xFF).
     */
    async typingPause(op: number): Promise<TypingPauseReply | null> {
        const reply = await this.usb.sendSvil(CMD_SVIL_TYPING_PAUSE, [op], { uint8: true }) as Uint8Array;
        return parseTypingPauseReply(reply);
    }

    /** Whether the board reports every raw switch change (FLICKER_LATCH) over this connection. */
    hasFlickerLatch(kbinfo: KeyboardInfo | null | undefined): boolean {
        return hasFlickerLatch(kbinfo?.feature_flags3, this.usb.reportLength);
    }

    /** FLICKER_LATCH read: raw rows and the latches of both halves (cleared by the read). */
    async readFlickerLatch(): Promise<FlickerRead | null> {
        const reply = await this.usb.sendSvil(CMD_SVIL_FLICKER_LATCH, [FLICKER_READ], { uint8: true }) as Uint8Array;
        return parseFlickerRead(reply);
    }

    /** FLICKER_LATCH counts of one half (0 left, 1 right), cleared by the read. */
    async readFlickerCounts(half: number, kbinfo: KeyboardInfo): Promise<FlickerCounts | null> {
        const reply = await this.usb.sendSvil(CMD_SVIL_FLICKER_LATCH, [FLICKER_COUNTS, half], { uint8: true }) as Uint8Array;
        return parseFlickerCounts(reply, Math.floor(kbinfo.rows / 2), kbinfo.cols);
    }

    async getLayerStateMask(): Promise<number> {
        const mask = await this.usb.sendSvil(SvilUSB.CMD_SVIL_LAYER_STATE_GET, [], {
            uint32: true,
            index: 1,
        }) as number;
        return mask >>> 0;
    }

    /**
     * Active and default layer masks. The default mask is null unless the board
     * advertises SVIL_FLAG_DEFAULT_LAYER_STATE (it follows the active mask in the reply).
     */
    async getLayerStateMasks(kbinfo: KeyboardInfo): Promise<{ active: number; default: number | null }> {
        const reply = await this.usb.sendSvil(SvilUSB.CMD_SVIL_LAYER_STATE_GET, [], { uint8: true }) as Uint8Array;
        const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
        const hasDefault = ((kbinfo.feature_flags ?? 0) & SVIL_FLAG_DEFAULT_LAYER_STATE) !== 0;
        return { active: view.getUint32(1, true), default: hasDefault ? view.getUint32(5, true) : null };
    }

    /**
     * Each half's side and trackball sensor, so Keybard can warn about the wrong
     * trackball firmware. Skipped on firmware that doesn't advertise it; a failed
     * read just leaves it unset.
     */
    async getPointingHardware(kbinfo: KeyboardInfo): Promise<void> {
        delete kbinfo.pointing_hardware;
        if (((kbinfo.feature_flags2 ?? 0) & SVIL_FLAG2_POINTING_HARDWARE) === 0) return;
        try {
            const reply = await this.usb.sendSvil(SvilUSB.CMD_SVIL_POINTING_HARDWARE, [], { uint8: true }) as Uint8Array;
            const report = parsePointingHardware(reply, SvilUSB.CMD_SVIL_POINTING_HARDWARE);
            if (report) kbinfo.pointing_hardware = report;
        } catch (e) {
            console.warn("Pointing hardware report not available:", e);
        }
    }

    /**
     * Hardware detection (0x18) read fresh, for the pointing slots: the board
     * settles its pointing modules after connect. Leaves kbinfo untouched; an
     * empty map on firmware without fragments or on a failed read.
     */
    async getFragmentHardware(kbinfo: KeyboardInfo): Promise<Map<number, number>> {
        if (!this.fragment.hasFragments(kbinfo)) return new Map();
        return (await this.fragment.readHardwareDetection()) ?? new Map();
    }

    /** Whether the board answers POINTING_MOTION (0x2D). */
    hasPointingMotion(kbinfo: KeyboardInfo | null | undefined): boolean {
        return ((kbinfo?.feature_flags2 ?? 0) & SVIL_FLAG2_POINTING_MOTION) !== 0;
    }

    /**
     * Each hand's pointing motion since the previous read (POINTING_MOTION, 0x2D,
     * read-and-clear; a read, never a write). Where the board keeps counts per
     * reader, Keybard reads as reader 1, so Keybard Host polling the same board
     * doesn't take half of the motion. Null without sending on firmware that
     * doesn't advertise it, and null on a failed or empty read.
     */
    async getPointingMotion(kbinfo: KeyboardInfo): Promise<PointingMotionReport | null> {
        if (!this.hasPointingMotion(kbinfo)) return null;
        const perReader = ((kbinfo.feature_flags2 ?? 0) & SVIL_FLAG2_POINTING_MOTION_READERS) !== 0;
        try {
            const reply = await this.usb.sendSvil(SvilUSB.CMD_SVIL_POINTING_MOTION, perReader ? [KEYBARD_MOTION_READER] : [], { uint8: true }) as Uint8Array;
            const report = parsePointingMotion(reply, SvilUSB.CMD_SVIL_POINTING_MOTION);
            if (!report || !this.hasPointingContacts(kbinfo)) return report;
            return withPadContacts(report, await this.getPointingContacts(kbinfo));
        } catch {
            return null;
        }
    }

    /** Whether the board answers the touch page of POINTING_MOTION (0x2D page 1). */
    hasPadTouch(kbinfo: KeyboardInfo | null | undefined): boolean {
        return hasPadTouchFlag(kbinfo?.feature_flags3);
    }

    /**
     * Each pad's touch as the chip's tap and press-and-hold rules see it (the
     * touch page of POINTING_MOTION: DF 2D <reader> 01; a read that clears only
     * its own events, never the motion counts). Null without sending on
     * firmware that doesn't advertise it, and null on a failed or empty read.
     */
    async getPadTouch(kbinfo: KeyboardInfo): Promise<PadTouchReport | null> {
        if (!this.hasPadTouch(kbinfo)) return null;
        const perReader = ((kbinfo.feature_flags2 ?? 0) & SVIL_FLAG2_POINTING_MOTION_READERS) !== 0;
        try {
            const reply = await this.usb.sendSvil(SvilUSB.CMD_SVIL_POINTING_MOTION, [perReader ? KEYBARD_MOTION_READER : 0, PAD_TOUCH_PAGE], { uint8: true }) as Uint8Array;
            return parsePadTouch(reply, SvilUSB.CMD_SVIL_POINTING_MOTION);
        } catch {
            return null;
        }
    }

    /** Whether the board reports every touch contact (POINTING_CONTACTS, 0x2F). */
    hasPointingContacts(kbinfo: KeyboardInfo | null | undefined): boolean {
        return ((kbinfo?.feature_flags2 ?? 0) & SVIL_FLAG2_POINTING_CONTACTS) !== 0;
    }

    /**
     * Every touch contact down now, each on its pad (POINTING_CONTACTS, 0x2F; a
     * read that clears nothing). Null without sending on firmware that doesn't
     * advertise it, and null on a failed or empty read.
     */
    async getPointingContacts(kbinfo: KeyboardInfo): Promise<PointingContactsReport | null> {
        if (!this.hasPointingContacts(kbinfo)) return null;
        try {
            const reply = await this.usb.sendSvil(SvilUSB.CMD_SVIL_POINTING_CONTACTS, [], { uint8: true }) as Uint8Array;
            return parsePointingContacts(reply, SvilUSB.CMD_SVIL_POINTING_CONTACTS);
        } catch {
            return null;
        }
    }

    /** Whether the board can change its saved default layer (DEFAULT_LAYER_SET). */
    canSetDefaultLayer(kbinfo: KeyboardInfo): boolean {
        return ((kbinfo.feature_flags2 ?? 0) & SVIL_FLAG2_DEFAULT_LAYER_SET) !== 0;
    }

    /** Makes layer the default, now and after a restart, as a PDF(layer) key does. */
    async setDefaultLayer(layer: number): Promise<void> {
        const resp = await this.usb.sendSvil(SvilUSB.CMD_SVIL_DEFAULT_LAYER_SET, [layer], { uint8: true }) as Uint8Array;
        checkSvilStatus(SvilUSB.CMD_SVIL_DEFAULT_LAYER_SET, resp);
    }

    /** Sets the default layer, then reads it back: a default that didn't change is an error, not a silent miss. */
    async setDefaultLayerChecked(kbinfo: KeyboardInfo, layer: number): Promise<void> {
        await this.setDefaultLayer(layer);
        const { defaultLayer } = await this.getLayerIndexes(kbinfo);
        if (defaultLayer !== null && defaultLayer !== layer) {
            throw new Error(`The keyboard's default layer is ${defaultLayer}, not ${layer} as Keybard asked. Set it again from the layer's menu.`);
        }
    }

    /**
     * The layer the board is showing and its default layer (null unless the board reports it).
     * QMK shows the highest layer that is on, counting the default layer, so with no other
     * layer on the board shows its default, which needn't be layer 0.
     */
    async getLayerIndexes(kbinfo: KeyboardInfo): Promise<{ active: number; defaultLayer: number | null }> {
        const masks = await this.getLayerStateMasks(kbinfo);
        return {
            active: this.getActiveLayerIndexFromMask(masks.active | (masks.default ?? 0)),
            defaultLayer: masks.default === null ? null : this.getActiveLayerIndexFromMask(masks.default),
        };
    }

    /** Sets the live layer state. QMK doesn't save it. */
    async setLayerStateMask(mask: number): Promise<void> {
        const m = mask >>> 0;
        await this.usb.sendSvil(SvilUSB.CMD_SVIL_LAYER_STATE_SET, [m & 0xff, (m >>> 8) & 0xff, (m >>> 16) & 0xff, (m >>> 24) & 0xff]);
    }

    getActiveLayerIndexFromMask(mask: number): number {
        const unsignedMask = mask >>> 0;
        if (unsignedMask === 0) return 0;
        for (let i = 31; i >= 0; i--) {
            if ((unsignedMask & (1 << i)) !== 0) {
                return i;
            }
        }
        /* v8 ignore next */
        return 0;
    }

    async getActiveLayerIndex(): Promise<number> {
        const mask = await this.getLayerStateMask();
        return this.getActiveLayerIndexFromMask(mask);
    }

    // API methods for updating keyboard settings
    async updateKey(layer: number, row: number, col: number, keymask: number): Promise<void> {
        const BE16 = (num: number) => [(num >> 8) & 0xff, num & 0xff];
        await this.usb.send(SvilUSB.CMD_VIA_SET_KEYCODE, [layer, row, col, ...BE16(keymask)], {});
    }

    /** The most keycodes one dynamic keymap set-buffer message carries (11 at 32 bytes, 27 at 64). */
    keymapBlockKeys(): number {
        return Math.floor(payloadCapacity(this.usb, VIA_BUFFER_HEADER_BYTES) / 2);
    }

    /**
     * Write keycodes to consecutive keymap positions in one message, starting at
     * keymap index (layer * rows + row) * cols + col.
     * Request: [0x13][offset:2 BE][size][keycode:2 BE ...]
     */
    async updateKeyBlock(index: number, keycodes: number[]): Promise<void> {
        const BE16 = (num: number) => [(num >> 8) & 0xff, num & 0xff];
        const offset = index * 2;
        const size = keycodes.length * 2;
        if (!keycodes.length || keycodes.length > this.keymapBlockKeys() || offset + size > 0x10000) {
            throw new Error(`Keymap block of ${keycodes.length} keys at ${index} doesn't fit one message`);
        }
        await this.usb.send(SvilUSB.CMD_VIA_KEYMAP_SET_BUFFER, [...BE16(offset), size, ...keycodes.flatMap(BE16)], {});
    }

    async updateMacros(kbinfo: KeyboardInfo) {
        await this.macro.push(kbinfo);
    }

    async updateTapdance(kbinfo: KeyboardInfo, tdid: number) {
        await this.tapdance.push(kbinfo, tdid);
    }

    async updateCombo(kbinfo: KeyboardInfo, cmbid: number) {
        await this.combo.push(kbinfo, cmbid);
    }

    async updateKeyoverride(kbinfo: KeyboardInfo, koid: number) {
        await this.override.push(kbinfo, koid);
    }

    async updateQMKSetting(kbinfo: KeyboardInfo, qfield: number) {
        await this.qmk.push(kbinfo, qfield);
    }

    /**
     * Update Alt Repeat Key entry on keyboard
     */
    async updateAltRepeatKey(kbinfo: KeyboardInfo, arkid: number): Promise<void> {
        const entry = kbinfo.alt_repeat_keys?.[arkid];
        if (!entry) return;

        const keycode = keyService.parse(entry.keycode);
        const alt_keycode = keyService.parse(entry.alt_keycode);

        const resp = await this.usb.sendSvil(SvilUSB.CMD_SVIL_ALT_REPEAT_KEY_SET, [
            ...svilIndexArgs(this.usb.svilProtocolVersion, arkid),
            keycode & 0xff,
            (keycode >> 8) & 0xff,
            alt_keycode & 0xff,
            (alt_keycode >> 8) & 0xff,
            entry.allowed_mods,
            entry.options,
        ], { uint8: true }) as Uint8Array;
        // Response: [cmd_echo][status], nonzero = refused (e.g. index out of range)
        checkSvilStatus(SvilUSB.CMD_SVIL_ALT_REPEAT_KEY_SET, resp);
    }

    /**
     * Update Leader sequence entry on keyboard
     */
    async updateLeader(kbinfo: KeyboardInfo, ldrid: number): Promise<void> {
        const entry = kbinfo.leaders?.[ldrid];
        if (!entry) return;

        const args: number[] = svilIndexArgs(this.usb.svilProtocolVersion, ldrid);

        // Add up to 5 sequence keys
        for (let i = 0; i < 5; i++) {
            const kc = entry.sequence[i] ? keyService.parse(entry.sequence[i]) : 0;
            args.push(kc & 0xff, (kc >> 8) & 0xff);
        }

        // Add output keycode
        const output = keyService.parse(entry.output);
        args.push(output & 0xff, (output >> 8) & 0xff);

        // Add options
        args.push(entry.options & 0xff, (entry.options >> 8) & 0xff);

        const resp = await this.usb.sendSvil(SvilUSB.CMD_SVIL_LEADER_SET, args, { uint8: true }) as Uint8Array;
        // Response: [cmd_echo][status], nonzero = refused (e.g. index out of range)
        checkSvilStatus(SvilUSB.CMD_SVIL_LEADER_SET, resp);
    }

    /**
     * Update One-shot settings on keyboard
     */
    async updateOneShot(kbinfo: KeyboardInfo): Promise<void> {
        const os = kbinfo.one_shot;
        if (!os) return;

        await this.usb.sendSvil(SvilUSB.CMD_SVIL_ONE_SHOT_SET, [
            os.timeout & 0xff,
            (os.timeout >> 8) & 0xff,
            os.tap_toggle,
        ], {});
    }

    /**
     * Update a fragment selection on keyboard
     */
    async updateFragmentSelection(
        kbinfo: KeyboardInfo,
        instanceIdx: number,
        optionIdx: number
    ): Promise<boolean> {
        return this.fragment.setSelection(kbinfo, instanceIdx, optionIdx);
    }

    /**
     * Get fragment service for direct access if needed
     */
    getFragmentService(): FragmentService {
        return this.fragment;
    }

    /**
     * Get fragment composer service for recomposing layouts
     */
    getFragmentComposer(): FragmentComposerService {
        return this.fragmentComposer;
    }

    /**
     * Save all Svil settings to EEPROM
     */
    async saveSvil(): Promise<void> {
        await this.usb.sendSvil(SvilUSB.CMD_SVIL_SAVE, [], {});
    }

    /**
     * Tell the board the user has been told about a storage reset, so it stops reporting it
     */
    async clearStorageReset(): Promise<void> {
        await this.usb.sendSvil(SvilUSB.CMD_SVIL_STORAGE_RESET_CLEAR, [], {});
    }

    /**
     * Reset all Svil settings to defaults
     */
    async resetSvil(): Promise<void> {
        await this.usb.sendSvil(SvilUSB.CMD_SVIL_RESET, [], {});
    }

    isLayerEmpty(layer: number[]): boolean {
        return layer.every((keycode) => keycode === 0 || keycode === -1 || keycode === 255);
    }
}

export const keyboardService = new KeyboardService(usbInstance);
