// The simulated Svalboard's firmware: raw HID report in, raw HID report out,
// byte for byte as Svalboard QMK answers. Every handler follows the C source it
// is named after (svalboard/qmk, combo-labels branch):
//   modules/svalboard/core/client_wrapper.c   0xDD client-ID wrapper
//   modules/svalboard/core/sval.c             0xDF Sval commands
//   modules/svalboard/core/sval_qmk_settings.c, sval_fragments.c
//   quantum/via.c, quantum/nvm/eeprom/nvm_dynamic_keymap.c   wrapped VIA (0xFE)
//   keyboards/svalboard/svalboard.c, identity.c              custom values
// Commands it doesn't model answer as firmware without that feature would.

import {
    blankBoard, ALT_REPEAT_KEY_SIZE, COLS, COMBO_SIZE, CUSTOM_VALUE_IDS, FRAGMENT_MAX_INSTANCES, KEY_OVERRIDE_SIZE,
    LABEL_SIZE, LABEL_TYPE_COMBO, LAYERS, LEADER_SIZE, MACRO_BUFFER_SIZE, MACRO_BUFFER_SIZE_NO_COMBO_LABELS,
    MACRO_COUNT, ROWS, TABLE_ENTRIES, TAP_DANCE_SIZE, type FakeBoardState,
} from "./board";
import {
    ChipModel, nearest, packPadTouch, PAD_DEAD_ZONE_MM100, PAD_HEIGHT_MM100, PAD_SCROLL_MM100, PAD_TAP_MS, PAD_WIDTH_MM100, type ChipSettings,
} from "@/utils/touchpad-tuning";
import { SCRIPT_MS, scriptSample } from "./touch-script";
import { DEFINITION_BYTES, FRAGMENT_INSTANCE_COUNT, POINTING_AZOTEQ_FRAGMENT_ID, POINTING_FRAGMENT_INSTANCES, POINTING_NONE_FRAGMENT_ID } from "./definition";

// ---- client wrapper (client_wrapper.c / .h) --------------------------------
const WRAPPER_PREFIX = 0xdd;
const SVAL_PREFIX = 0xdf;
const VIA_PREFIX = 0xfe;
const CLIENT_ID_ERROR = 0xffffffff;
const CLIENT_ERR_INVALID_ID = 0x01;
const CLIENT_ERR_UNKNOWN_PROTO = 0x03;
const CLIENT_WRAPPER_TTL_SECS = 120;
const CLIENT_WRAPPER_OVERHEAD = 6;

// ---- Sval (sval.h) ----------------------------------------------------------
const SVAL_PROTOCOL_VERSION = 3;
const SVAL_CMD_ERROR = 0xff;
const SVAL_DEFINITION_CHUNK_SIZE = 22;
// SVAL_KEYBOARD_UID (keyboards/svalboard/config.h), sent as stored
export const KEYBOARD_UID = [0x1b, 0x18, 0x7d, 0xf2, 0x21, 0xf6, 0x29, 0x48];
// QMK_KEYCODES_VERSION 0.0.9 (quantum/keycodes.h)
export const KEYCODES_VERSION = [0, 0, 9] as const;

// GET_INFO feature flags. The board has caps word, layer lock and leader, and
// always sets default_layer_state. It also advertises context layers (bit 5),
// which this simulation doesn't model, so that bit stays clear here.
export const FEATURE_FLAGS = 0x01 | 0x02 | 0x08 | 0x40;
// flags2: default layer set, pointing hardware, modifier state, pointing motion;
// combo labels (bit 7) on the combo-labels branch.
export const FLAG2_BASE = 0x01 | 0x02 | 0x04 | 0x08;
export const FLAG2_COMBO_LABELS = 0x80;
// flags3 (GET_INFO byte 20): typing pause (0x3C), bit 2.
export const FLAG3_TYPING_PAUSE = 0x04;
// flags3 bit 3: flicker latch (0x3D).
export const FLAG3_FLICKER_LATCH = 0x08;
// flags3 bit 4: the touchpad tap setting (VIA values 51-54).
export const FLAG3_PAD_GESTURES = 0x10;
// flags3 bits 5 and 6: the touchpad tuning (VIA 55-57) and the touch page of 0x2D.
export const FLAG3_PAD_TUNING = 0x20;
export const FLAG3_PAD_TOUCH = 0x40;
// pad_gestures.c sval_pad_hold_ms: the hold times the board stores, the default (300) first.
/** The build's own scroll distance on the native touchpad (50 pixels at 2048 across 43 mm). */
const FAKE_SCROLL_BUILD_MM100 = 105;
const PAD_HOLD_MS = [300, 20, 50, 100, 150, 200, 250, 350, 400, 500, 600, 700, 800, 1000, 1200, 1500];
const MATRIX_COLS = 6;
const HALF_ROWS = 5;
// keyboards/svalboard/typing_pause.h: the lease after the owner's last packet,
// and how long output stays held back once a pause ends.
export const TYPING_PAUSE_LEASE_MS = 1500;
export const TYPING_PAUSE_DRAIN_MS = 500;

/** A TYPING_PAUSE request the board received, for tests. */
export interface TypingPauseRequest {
    op: number;
    client: number;
    at: number;
}

// ---- VIA (quantum/via.h) ----------------------------------------------------
const VIA_PROTOCOL_VERSION = 0x000d;
const ID_UNHANDLED = 0xff;
const RGBLIGHT_CHANNEL = 2;
const IDENTITY_CHANNEL = 0x49;
const SCANLAB_CHANNEL = 0x53;
const SCANLAB_RSP_LEN = 24;
const SCANLAB_ROWS = 5;
// svalboard.c sval_prewait_us / sval_postwait_us (the turbo table), id_turbo_scan, id_optical_debounce
const TURBO_US = [90, 60, 45, 30, 25, 20, 15];
const ID_TURBO_SCAN = 9;
const ID_OPTICAL_DEBOUNCE = 48;
// feat/timing-us-only: the auto mouse layer timeout (sval_timing.c)
const ID_AUTOMOUSE_CHOICE = 5;
const ID_AUTOMOUSE_MS = 49;
const ID_AUTOMOUSE_NO_TIMEOUT = 50;
const AUTOMOUSE_CHOICES = [200, 300, 400, 500, 800]; // index 5: no timeout
const AUTOMOUSE_NEVER = 5;
const KEYTEST_CHANNEL = 0x54;
const IDENTITY_NAME_MAX_BYTES = 64;
// sval:5356414C424F4152, a fixed serial for the simulation ("SVALBOAR")
const IDENTITY_SERIAL = [0x53, 0x56, 0x41, 0x4c, 0x42, 0x4f, 0x41, 0x52];

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put16 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const put32 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };

export interface FakeFirmwareOptions {
    /** Firmware with combo names (label type 3, GET_INFO flags2 bit 7). Default true. */
    comboLabels?: boolean;
    /** Called after every write that changes stored settings. */
    onChange?: (state: FakeBoardState) => void;
    /** Milliseconds since the board started, for client-ID ages. */
    now?: () => number;
    /**
     * The keymap a keymap reset restores (keymap.c on a real board). Without
     * it, VIA's keymap reset answers as unhandled.
     */
    factoryKeymap?: Uint8Array;
    /** Firmware with the typing pause (Sval 0x3C, GET_INFO byte 20 bit 2). Default true. */
    typingPause?: boolean;
    /** Firmware with the flicker latch (Sval 0x3D, GET_INFO byte 20 bit 3). Default true. */
    flickerLatch?: boolean;
    /**
     * Firmware with the optical debounce switch: VIA value 48 and Scan Lab
     * STATUS byte 23 (svalboard.c, scanlab.c). Default true.
     */
    debounceSwitch?: boolean;
    /**
     * Firmware with the scan timing in µs only (feat/timing-us-only): at boot a
     * wait of 0 is filled in from the turbo table, id_turbo_scan writes both
     * waits and reads the matching preset (0xFF for none), and the auto mouse
     * timeout is VIA 49 (ms) and 50 (no timeout). Default true.
     */
    timingUsOnly?: boolean;
    /** Firmware with the touchpad tap setting: VIA values 51-54, GET_INFO byte 20 bit 4. Default true. */
    padGestures?: boolean;
    /** An Azoteq touchpad on each half (0x2C, 0x18), instead of no pointing module. Default false. */
    touchpad?: boolean;
}

/** A Sval table (TABLE_SCAN ids 0-4): its storage, entry size and "in use" test. */
interface Table {
    bytes: (s: FakeBoardState) => Uint8Array;
    size: number;
    used: (e: Uint8Array) => boolean;
}

const TABLES: Record<number, Table> = {
    0: { bytes: (s) => s.tapDance, size: TAP_DANCE_SIZE, used: (e) => !!(le16(e, 0) || le16(e, 2) || le16(e, 4) || le16(e, 6)) },
    1: { bytes: (s) => s.combo, size: COMBO_SIZE, used: (e) => !!(le16(e, 0) || le16(e, 8)) },
    2: { bytes: (s) => s.keyOverride, size: KEY_OVERRIDE_SIZE, used: (e) => !!(le16(e, 0) || le16(e, 2)) },
    3: { bytes: (s) => s.altRepeatKey, size: ALT_REPEAT_KEY_SIZE, used: (e) => !!(le16(e, 0) || le16(e, 2)) },
    4: { bytes: (s) => s.leader, size: LEADER_SIZE, used: (e) => !!(le16(e, 0) || le16(e, 10)) },
};
// GET / SET command pairs per table, with the minimum SET length (sval.c)
const TABLE_COMMANDS: Record<number, { table: number; set: boolean; minLength: number }> = {
    0x01: { table: 0, set: false, minLength: 0 }, 0x02: { table: 0, set: true, minLength: 14 },
    0x03: { table: 1, set: false, minLength: 0 }, 0x04: { table: 1, set: true, minLength: 16 },
    0x05: { table: 2, set: false, minLength: 0 }, 0x06: { table: 2, set: true, minLength: 16 },
    0x07: { table: 3, set: false, minLength: 0 }, 0x08: { table: 3, set: true, minLength: 10 },
    0x14: { table: 4, set: false, minLength: 0 }, 0x15: { table: 4, set: true, minLength: 18 },
};

// QMK settings (sval_qmk_settings.c setting_descs, MOUSEKEY and LEADER on, AUTO_SHIFT off)
interface SettingDesc { qsid: number; size: number; offset: number; bit: number }
const SETTINGS: SettingDesc[] = [
    { qsid: 1, size: 1, offset: 26, bit: 0 }, // grave_esc_override
    { qsid: 2, size: 2, offset: 22, bit: 0 }, // combo_term
    { qsid: 5, size: 1, offset: 28, bit: 0 }, // osk_tap_toggle
    { qsid: 6, size: 2, offset: 2, bit: 0 }, // osk_timeout
    { qsid: 7, size: 2, offset: 24, bit: 0 }, // tapping_term
    { qsid: 9, size: 2, offset: 4, bit: 0 },
    { qsid: 10, size: 2, offset: 6, bit: 0 },
    { qsid: 11, size: 2, offset: 8, bit: 0 },
    { qsid: 12, size: 2, offset: 10, bit: 0 },
    { qsid: 13, size: 2, offset: 12, bit: 0 },
    { qsid: 14, size: 2, offset: 14, bit: 0 },
    { qsid: 15, size: 2, offset: 16, bit: 0 },
    { qsid: 16, size: 2, offset: 18, bit: 0 },
    { qsid: 17, size: 2, offset: 20, bit: 0 },
    { qsid: 18, size: 2, offset: 30, bit: 0 }, // tap_code_delay
    { qsid: 19, size: 2, offset: 32, bit: 0 }, // tap_hold_caps_delay
    { qsid: 20, size: 1, offset: 34, bit: 0 }, // tapping_toggle
    { qsid: 21, size: 0, offset: 0, bit: 0 }, // magic (keymap_config)
    { qsid: 22, size: 1, offset: 29, bit: 0 }, // permissive hold
    { qsid: 23, size: 1, offset: 29, bit: 1 }, // hold on other key
    { qsid: 24, size: 1, offset: 29, bit: 2 }, // retro tapping
    { qsid: 25, size: 2, offset: 36, bit: 0 }, // quick_tap_term
    { qsid: 26, size: 1, offset: 29, bit: 3 }, // chordal hold
    { qsid: 27, size: 2, offset: 38, bit: 0 }, // flow_tap_term
    { qsid: 28, size: 2, offset: 40, bit: 0 }, // leader_timeout
    { qsid: 29, size: 1, offset: 42, bit: 0 }, // leader per-key timing
];
const isBitSetting = (qsid: number) => (qsid >= 22 && qsid <= 26 && qsid !== 25) || qsid === 29;

// Channel-0 custom values (svalboard.c via_custom_value_command_kb)
const CUSTOM_TWO_BYTE = new Set([6, 13, 14, 20, 21, 22, 23, 24, ID_AUTOMOUSE_MS]);
const CUSTOM_READABLE = (id: number) => (id <= 15) || (id >= 20 && id <= 31) || (id >= 32 && id < 48);
const CUSTOM_WRITABLE = (id: number) => (id <= 14) || (id >= 20 && id <= 30) || (id >= 32 && id < 48);
const TIMING_US_ONLY_IDS = new Set([ID_AUTOMOUSE_MS, ID_AUTOMOUSE_NO_TIMEOUT]);
const nearestChoice = (ms: number) => AUTOMOUSE_CHOICES.reduce((best, c, i) => (Math.abs(c - ms) < Math.abs(AUTOMOUSE_CHOICES[best] - ms) ? i : best), 0);

/** Byte-level model of the board's raw HID protocol. */
export class FakeSvalFirmware {
    readonly comboLabels: boolean;
    readonly typingPause: boolean;
    readonly flickerLatch: boolean;
    readonly debounceSwitch: boolean;
    readonly timingUsOnly: boolean;
    readonly padGestures: boolean;
    readonly touchpad: boolean;
    /**
     * The touchpad tap setting byte (pad_gestures.h): bit 0 tap off, bit 1
     * two-finger tap off, bit 2 press and hold off, bits 3-6 the hold time
     * index. 0 is the defaults. RAM here; the board stores it on save.
     */
    padSetting = 0;
    /** The touchpad tuning (pad_gestures.h): dead zone 0.01 mm, tap time ms, scroll start 0.01 mm (0: the build's own). */
    padTuning = { deadZone: PAD_DEAD_ZONE_MM100[0] as number, tapMs: PAD_TAP_MS[0] as number, scroll: 0 };
    /** Each pad plays TOUCH_SCRIPT through the chip model, the right pad half a loop behind the left. */
    private padPlayers: { model: ChipModel; fedTo: number; offset: number }[] | null = null;
    /** Plays the scripted touches this many times faster (tests that need many touches). */
    touchSpeed = 1;
    /** Every channel-0 custom value write ([id, bytes]), oldest first, for tests. */
    readonly customWrites: { id: number; value: number[] }[] = [];
    /**
     * The optical debounce mode (global_saved_values.optical_debounce_off):
     * RAM, then saved by id_custom_save. Both halves use the saved half's mode
     * at once here; the real other half follows within a presence ping.
     */
    opticalDebounceOn = true;
    /** Every value 48 write, oldest first, and whether a save followed. */
    readonly debounceWrites: { value: number; saved: boolean }[] = [];
    /** Switches held down now ("row,col"), for VIA's matrix state and the latch's raw rows. */
    readonly pressed = new Set<string>();
    /** The flicker latch (flicker_latch.c): pressed and released since the last read, and change counts. */
    private latchPressed = new Uint8Array(ROWS);
    private latchReleased = new Uint8Array(ROWS);
    private changes = new Uint8Array(ROWS * MATRIX_COLS);
    /** Reads of the latch, for tests. */
    latchReads = 0;
    /** Every TYPING_PAUSE request, oldest first. */
    readonly pauseRequests: TypingPauseRequest[] = [];
    private pauseOwner = 0;
    private pauseOwnerSeen = 0;
    private pauseEndedAt: number | null = null;
    private pausePaused = false;
    private pauseLastEnd = 0;
    private currentClient = 0;
    /** Live layer state (layer_state): never saved, as in QMK. */
    layerState = 0;
    private idCounter: number;
    private readonly now: () => number;
    private readonly onChange?: (state: FakeBoardState) => void;
    private readonly factoryKeymap?: Uint8Array;
    /** The identity name staged by OP_NAME writes until OP_COMMIT. */
    private stagedName = new Uint8Array(IDENTITY_NAME_MAX_BYTES);

    constructor(readonly state: FakeBoardState, options: FakeFirmwareOptions = {}) {
        this.comboLabels = options.comboLabels ?? true;
        this.typingPause = options.typingPause ?? true;
        this.flickerLatch = options.flickerLatch ?? true;
        this.debounceSwitch = options.debounceSwitch ?? true;
        this.timingUsOnly = options.timingUsOnly ?? true;
        this.padGestures = options.padGestures ?? true;
        this.touchpad = options.touchpad ?? false;
        this.onChange = options.onChange;
        if (this.timingUsOnly) this.migrateTiming();
        this.factoryKeymap = options.factoryKeymap;
        const start = Date.now();
        this.now = options.now ?? (() => Date.now() - start);
        // client_wrapper_init(): the counter is seeded from the timer
        this.idCounter = Math.floor(Math.random() * 0x10000);
    }

    /**
     * read_eeprom_kb() on feat/timing-us-only: a 0 wait (the old "turbo table")
     * is filled in from the table at the saved turbo index and saved; the auto
     * mouse ms value starts from the old choice.
     */
    private migrateTiming(): void {
        const c = this.state.custom;
        const get16 = (id: number) => c[id * 2] | (c[id * 2 + 1] << 8);
        const set16 = (id: number, v: number) => { c[id * 2] = v & 0xff; c[id * 2 + 1] = (v >> 8) & 0xff; };
        let changed = false;
        const turbo = c[ID_TURBO_SCAN * 2] < TURBO_US.length ? c[ID_TURBO_SCAN * 2] : 0;
        for (const id of [13, 14]) {
            if (get16(id) === 0) { set16(id, TURBO_US[turbo]); changed = true; }
        }
        if (c[ID_TURBO_SCAN * 2] !== 0) { c[ID_TURBO_SCAN * 2] = 0; changed = true; }
        if (get16(ID_AUTOMOUSE_MS) === 0) {
            const choice = c[ID_AUTOMOUSE_CHOICE * 2];
            set16(ID_AUTOMOUSE_MS, choice < AUTOMOUSE_NEVER ? AUTOMOUSE_CHOICES[choice] : 500);
            changed = true;
        }
        if (changed) this.changed();
    }

    /** The preset both waits match (id_turbo_scan read), or 0xFF. */
    private timingPreset(): number {
        const c = this.state.custom;
        const pre = c[26] | (c[27] << 8), post = c[28] | (c[29] << 8);
        const i = TURBO_US.indexOf(pre as (typeof TURBO_US)[number]);
        return pre === post && i >= 0 ? i : 0xff;
    }

    /** VIA 9, 13, 14, 5, 49 and 50 on feat/timing-us-only; true when handled. */
    private timingValue(command: number, valueId: number, value: Uint8Array): boolean {
        const c = this.state.custom;
        const set16 = (id: number, v: number) => { c[id * 2] = v & 0xff; c[id * 2 + 1] = (v >> 8) & 0xff; };
        const get16 = (id: number) => c[id * 2] | (c[id * 2 + 1] << 8);
        if (command === 0x08) {
            if (valueId === ID_TURBO_SCAN) value[0] = this.timingPreset();
            else if (valueId === ID_AUTOMOUSE_MS) { value[0] = c[ID_AUTOMOUSE_MS * 2]; value[1] = c[ID_AUTOMOUSE_MS * 2 + 1]; }
            else if (valueId === ID_AUTOMOUSE_NO_TIMEOUT) value[0] = c[ID_AUTOMOUSE_CHOICE * 2] === AUTOMOUSE_NEVER ? 1 : 0;
            else return false;
            return true;
        }
        if (command !== 0x07) return false;
        const v16 = value[0] | (value[1] << 8);
        if (valueId === ID_TURBO_SCAN) {
            if (value[0] < TURBO_US.length) { set16(13, TURBO_US[value[0]]); set16(14, TURBO_US[value[0]]); }
        } else if (valueId === 13 || valueId === 14) {
            set16(valueId, v16 || TURBO_US[0]);
        } else if (valueId === ID_AUTOMOUSE_CHOICE) {
            if (value[0] > AUTOMOUSE_NEVER) return true;
            c[ID_AUTOMOUSE_CHOICE * 2] = value[0];
            if (value[0] < AUTOMOUSE_NEVER) set16(ID_AUTOMOUSE_MS, AUTOMOUSE_CHOICES[value[0]]);
        } else if (valueId === ID_AUTOMOUSE_MS) {
            const ms = Math.round(Math.min(2000, Math.max(100, v16)) / 10) * 10;
            set16(ID_AUTOMOUSE_MS, ms);
            if (c[ID_AUTOMOUSE_CHOICE * 2] !== AUTOMOUSE_NEVER) c[ID_AUTOMOUSE_CHOICE * 2] = nearestChoice(ms);
        } else if (valueId === ID_AUTOMOUSE_NO_TIMEOUT) {
            c[ID_AUTOMOUSE_CHOICE * 2] = value[0] ? AUTOMOUSE_NEVER : nearestChoice(get16(ID_AUTOMOUSE_MS) || 500);
        } else {
            return false;
        }
        this.changed();
        return true;
    }

    get macroBufferSize(): number {
        return this.comboLabels ? MACRO_BUFFER_SIZE : MACRO_BUFFER_SIZE_NO_COMBO_LABELS;
    }

    get featureFlags3(): number {
        return (this.typingPause ? FLAG3_TYPING_PAUSE : 0) | (this.flickerLatch ? FLAG3_FLICKER_LATCH : 0) | (this.padGestures ? FLAG3_PAD_GESTURES : 0)
            | (this.padGestures && this.touchpad ? FLAG3_PAD_TUNING | FLAG3_PAD_TOUCH : 0);
    }

    private count(row: number, col: number) {
        const i = row * MATRIX_COLS + col;
        if (this.changes[i] < 255) this.changes[i]++;
    }

    /** A switch goes down (one raw scan saw it), as the firmware's scan would record it. */
    press(row: number, col: number): void {
        const k = `${row},${col}`;
        if (this.pressed.has(k)) return;
        this.pressed.add(k);
        this.latchPressed[row] |= 1 << col;
        this.count(row, col);
    }

    /** A switch goes up. */
    release(row: number, col: number): void {
        const k = `${row},${col}`;
        if (!this.pressed.has(k)) return;
        this.pressed.delete(k);
        this.latchReleased[row] |= 1 << col;
        this.count(row, col);
    }

    /** A bounce of one scan: down and up again between two reads. */
    flicker(row: number, col: number): void {
        this.press(row, col);
        this.release(row, col);
    }

    private rawRow(row: number): number {
        let bits = 0;
        for (let col = 0; col < 8; col++) if (this.pressed.has(`${row},${col}`)) bits |= 1 << col;
        return bits;
    }

    /** sval_flicker_command: data after [0xDF][0x3D]. */
    private flickerCommand(data: Uint8Array, length: number): void {
        if (length < 4 + 3 * ROWS || length < 4 + HALF_ROWS * MATRIX_COLS) {
            if (length > 1) data[1] = 3;
            return;
        }
        const op = data[0], arg = data[1];
        data.fill(0, 1, length);
        if (op === 0) {
            this.latchReads++;
            data[2] = 3; // both halves
            data[3] = ROWS;
            for (let r = 0; r < ROWS; r++) {
                data[4 + r] = this.rawRow(r);
                data[4 + ROWS + r] = this.latchPressed[r];
                data[4 + 2 * ROWS + r] = this.latchReleased[r];
            }
            this.latchPressed.fill(0);
            this.latchReleased.fill(0);
        } else if (op === 1 && arg <= 1) {
            data[2] = 1;
            data[3] = arg;
            const from = arg * HALF_ROWS * MATRIX_COLS;
            data.set(this.changes.subarray(from, from + HALF_ROWS * MATRIX_COLS), 4);
            this.changes.fill(0, from, from + HALF_ROWS * MATRIX_COLS);
        } else {
            data[1] = 1;
        }
    }

    /**
     * The typing pause now (typing_pause.c): "paused" until the owner has been
     * quiet for the lease, then "ending" for the drain time, then "off".
     */
    typingPauseState(): "off" | "paused" | "ending" {
        const now = this.timer();
        if (this.pausePaused && now - this.pauseOwnerSeen >= TYPING_PAUSE_LEASE_MS) {
            this.pausePaused = false;
            this.pauseEndedAt = this.pauseOwnerSeen + TYPING_PAUSE_LEASE_MS;
            this.pauseLastEnd = 2; // the owner went quiet
        }
        if (this.pausePaused) return "paused";
        if (this.pauseEndedAt !== null && now - this.pauseEndedAt < TYPING_PAUSE_DRAIN_MS) return "ending";
        this.pauseEndedAt = null;
        return "off";
    }

    /** sval_typing_pause_command: data after [0xDF][0x3C]. */
    private typingPauseCommand(data: Uint8Array, length: number): void {
        if (length < 16) {
            if (length > 1) data[1] = 3;
            return;
        }
        const op = data[0];
        this.pauseRequests.push({ op, client: this.currentClient, at: this.timer() });
        if (this.pauseRequests.length > 2000) this.pauseRequests.splice(0, this.pauseRequests.length - 2000);
        data.fill(0, 1, length);
        let status = 0;
        const state = this.typingPauseState();
        if (op === 1) {
            this.pausePaused = true;
            this.pauseEndedAt = null;
            this.pauseOwner = this.currentClient;
            this.pauseOwnerSeen = this.timer();
        } else if (op === 0) {
            if (state === "paused") {
                this.pausePaused = false;
                this.pauseEndedAt = this.timer();
                this.pauseLastEnd = 1;
            }
        } else if (op !== 2) {
            status = 1;
        }
        const now = this.typingPauseState();
        data[1] = status;
        data[2] = now === "paused" ? 1 : now === "ending" ? 2 : 0;
        data[3] = this.pauseLastEnd;
        data[4] = now !== "off" && this.pauseOwner === this.currentClient ? 1 : 0;
        put16(data, 5, now === "paused" ? Math.max(0, TYPING_PAUSE_LEASE_MS - (this.timer() - this.pauseOwnerSeen)) : 0);
    }

    get featureFlags2(): number {
        return FLAG2_BASE | (this.comboLabels ? FLAG2_COMBO_LABELS : 0);
    }

    private changed() {
        this.onChange?.(this.state);
    }

    /**
     * One raw HID output report from the host. Returns the input report the board
     * sends back, or null when it sends nothing.
     */
    receive(report: Uint8Array): Uint8Array | null {
        const length = report.length;
        const data = new Uint8Array(report); // the firmware works in place on its receive buffer
        if (data[0] === WRAPPER_PREFIX) return this.clientWrapperReceive(data, length);
        // Unwrapped Sval is refused: "handled" by ignoring it (via_command_kb)
        if (data[0] === SVAL_PREFIX) return null;
        // Anything else goes to VIA unwrapped
        this.viaReceive(data, length, false);
        return data;
    }

    // ---- client_wrapper.c ----------------------------------------------------

    private timer(): number {
        return Math.floor(this.now()) >>> 0;
    }

    private allocateId(): number {
        const id = ((this.timer() & 0xffff0000) | (this.idCounter & 0xffff)) >>> 0;
        this.idCounter = (this.idCounter + 1) & 0xffff;
        return id;
    }

    private validId(id: number): boolean {
        if (id === 0 || id === CLIENT_ID_ERROR) return false;
        const idTime = (id & 0xffff0000) >>> 0;
        const now = (this.timer() & 0xffff0000) >>> 0;
        const age = (now - idTime) >>> 0;
        return age < CLIENT_WRAPPER_TTL_SECS * 1000;
    }

    private sendError(clientId: number, code: number, data: Uint8Array): Uint8Array {
        data.fill(0);
        data[0] = WRAPPER_PREFIX;
        put32(data, 1, clientId);
        data[5] = 0xff;
        data[6] = code;
        return data;
    }

    private clientWrapperReceive(data: Uint8Array, length: number): Uint8Array | null {
        const clientId = le32(data, 1);
        if (clientId === 0) {
            // Bootstrap: [0xDD][0][nonce:20] -> [0xDD][0][nonce:20][new id:4][ttl:2]
            if (length < 31) return null;
            put32(data, 25, this.allocateId());
            put16(data, 29, CLIENT_WRAPPER_TTL_SECS);
            return data;
        }
        if (!this.validId(clientId)) return this.sendError(clientId, CLIENT_ERR_INVALID_ID, data);
        // sval_client_packet_kb: only the owner's packets keep the typing pause on.
        this.currentClient = clientId;
        if (this.typingPauseState() === "paused" && clientId === this.pauseOwner) this.pauseOwnerSeen = this.timer();
        const protocol = data[5];
        if (protocol === SVAL_PREFIX) {
            this.svalCommand(data.subarray(5), length - 5);
            return data;
        }
        if (protocol === VIA_PREFIX) {
            // memmove(data, &data[6], length - 6): the last 6 bytes stay as they were
            data.copyWithin(0, 6);
            this.viaReceive(data, length, true);
            // raw_hid_send(): shift right by 6 (the reply's last 6 bytes are lost), add the header
            data.copyWithin(6, 0, length - 6);
            data[0] = WRAPPER_PREFIX;
            put32(data, 1, clientId);
            data[5] = protocol;
            return data;
        }
        return this.sendError(clientId, CLIENT_ERR_UNKNOWN_PROTO, data);
    }

    // ---- quantum/via.c --------------------------------------------------------

    /** via_payload_length / via_buffer_size: what a buffer get/set may use. */
    private viaBufferSize(requested: number, length: number, wrapped: boolean): number {
        const payload = wrapped && length > 6 ? length - 6 : length;
        const room = payload > 4 ? payload - 4 : 0;
        return requested > room ? room : requested;
    }

    private viaReceive(data: Uint8Array, length: number, wrapped: boolean): void {
        const cd = data.subarray(1);
        const s = this.state;
        switch (data[0]) {
            case 0x01: // id_get_protocol_version
                cd[0] = VIA_PROTOCOL_VERSION >> 8;
                cd[1] = VIA_PROTOCOL_VERSION & 0xff;
                break;
            case 0x02: // id_get_keyboard_value
                switch (cd[0]) {
                    case 0x01: { // id_uptime
                        const t = this.timer();
                        cd[1] = (t >>> 24) & 0xff; cd[2] = (t >>> 16) & 0xff; cd[3] = (t >>> 8) & 0xff; cd[4] = t & 0xff;
                        break;
                    }
                    case 0x02: // id_layout_options
                    case 0x04: // id_firmware_version (VIA_FIRMWARE_VERSION 0)
                        cd[1] = cd[2] = cd[3] = cd[4] = 0;
                        break;
                    case 0x03: { // id_switch_matrix_state (VIA_INSECURE): one byte per row, bit = column
                        const offset = cd[1];
                        let i = 2;
                        for (let row = 0; row < 28 && row + offset < ROWS; row++) {
                            let bits = 0;
                            for (let col = 0; col < 8; col++) if (this.pressed.has(`${row + offset},${col}`)) bits |= 1 << col;
                            cd[i++] = bits;
                        }
                        break;
                    }
                    case 0x06: // id_keycodes_version (QMK_KEYCODES_VERSION_BCD)
                        cd[1] = 0; cd[2] = 0; cd[3] = 0; cd[4] = KEYCODES_VERSION[2];
                        break;
                    default:
                        data[0] = ID_UNHANDLED;
                }
                break;
            case 0x03: // id_set_keyboard_value
                if (cd[0] !== 0x02 && cd[0] !== 0x05) data[0] = ID_UNHANDLED; // layout options, device indication
                break;
            case 0x04: { // id_dynamic_keymap_get_keycode
                const kc = this.keycodeAt(cd[0], cd[1], cd[2]);
                cd[3] = kc >> 8;
                cd[4] = kc & 0xff;
                break;
            }
            case 0x05: { // id_dynamic_keymap_set_keycode
                const [layer, row, col] = [cd[0], cd[1], cd[2]];
                if (layer < LAYERS && row < ROWS && col < COLS) {
                    const o = ((layer * ROWS + row) * COLS + col) * 2;
                    s.keymap[o] = cd[3];
                    s.keymap[o + 1] = cd[4];
                    this.changed();
                }
                break;
            }
            case 0x06: // id_dynamic_keymap_reset
                if (!this.factoryKeymap) {
                    data[0] = ID_UNHANDLED;
                    break;
                }
                s.keymap.set(this.factoryKeymap);
                this.changed();
                break;
            case 0x07: case 0x08: case 0x09: // id_custom_set_value / get / save
                this.customValueCommand(data, length, wrapped);
                break;
            case 0x0c: // id_dynamic_keymap_macro_get_count: low byte, then high byte
                cd[0] = MACRO_COUNT & 0xff;
                cd[1] = MACRO_COUNT >> 8;
                break;
            case 0x0d: { // id_dynamic_keymap_macro_get_buffer_size, at most 0xFFFF
                const size = Math.min(this.macroBufferSize, 0xffff);
                cd[0] = size >> 8;
                cd[1] = size & 0xff;
                break;
            }
            case 0x0e: case 0x0f: { // id_dynamic_keymap_macro_get_buffer / set_buffer
                const offset = (cd[0] << 8) | cd[1];
                const size = this.viaBufferSize(cd[2], length, wrapped);
                if (data[0] === 0x0e) this.macroRead(offset, size, cd.subarray(3));
                else { this.macroWrite(offset, cd.subarray(3, 3 + size)); this.changed(); }
                break;
            }
            case 0x10: // id_dynamic_keymap_macro_reset
                s.macros.fill(0);
                this.changed();
                break;
            case 0x11: // id_dynamic_keymap_get_layer_count
                cd[0] = LAYERS;
                break;
            case 0x12: case 0x13: { // id_dynamic_keymap_get_buffer / set_buffer
                const offset = (cd[0] << 8) | cd[1];
                const size = this.viaBufferSize(cd[2], length, wrapped);
                const out = cd.subarray(3);
                for (let i = 0; i < size; i++) {
                    const at = offset + i;
                    if (data[0] === 0x12) out[i] = at < s.keymap.length ? s.keymap[at] : 0;
                    else if (at < s.keymap.length) s.keymap[at] = out[i];
                }
                if (data[0] === 0x13) this.changed();
                break;
            }
            default:
                // eeprom reset, bootloader jump and encoders aren't on this build
                data[0] = ID_UNHANDLED;
        }
    }

    private keycodeAt(layer: number, row: number, col: number): number {
        if (layer >= LAYERS || row >= ROWS || col >= COLS) return 0;
        const o = ((layer * ROWS + row) * COLS + col) * 2;
        return (this.state.keymap[o] << 8) | this.state.keymap[o + 1];
    }

    private macroRead(offset: number, size: number, out: Uint8Array): void {
        const total = this.macroBufferSize;
        for (let i = 0; i < size; i++) out[i] = offset < total && i < total - offset ? this.state.macros[offset + i] : 0;
    }

    private macroWrite(offset: number, bytes: Uint8Array): void {
        const total = this.macroBufferSize;
        for (let i = 0; i < bytes.length; i++) {
            if (offset < total && i < total - offset) this.state.macros[offset + i] = bytes[i];
        }
    }

    // ---- custom values (via.c, svalboard.c, identity.c) -------------------------

    private customValueCommand(data: Uint8Array, length: number, wrapped: boolean): void {
        const [command, channel, valueId] = [data[0], data[1], data[2]];
        const value = data.subarray(3);
        if (channel === RGBLIGHT_CHANNEL) {
            this.rgblightCommand(data);
            return;
        }
        // Keytest (keytest builds only) isn't modeled: unhandled.
        if (channel === KEYTEST_CHANNEL) {
            data[0] = ID_UNHANDLED;
            return;
        }
        if (channel === SCANLAB_CHANNEL) {
            this.scanlabCommand(data, length);
            return;
        }
        if (channel === IDENTITY_CHANNEL) {
            this.identityCommand(data, length, wrapped);
            return;
        }
        // Every other channel (0, and 0x55 on builds without the updater) lands
        // here: svalboard.c switches on the value ID alone.
        const c = this.state.custom;
        if (valueId === ID_OPTICAL_DEBOUNCE && this.debounceSwitch) {
            if (command === 0x07) {
                this.opticalDebounceOn = value[0] !== 0;
                this.debounceWrites.push({ value: value[0], saved: false });
            } else if (command === 0x08) {
                value[0] = this.opticalDebounceOn ? 1 : 0;
            }
            return;
        }
        if (this.padGestures && this.touchpad && valueId >= 55 && valueId <= 57) {
            this.padTuningValue(command, valueId, value);
            return;
        }
        if (this.padGestures && valueId >= 51 && valueId <= 54) {
            this.padValue(command, valueId, value);
            return;
        }
        if (command === 0x09 && this.debounceWrites.length) this.debounceWrites[this.debounceWrites.length - 1].saved = true;
        if (command === 0x07) this.customWrites.push({ id: valueId, value: Array.from(value.subarray(0, 2)) });
        if (this.timingUsOnly && this.timingValue(command, valueId, value)) return;
        if (!this.timingUsOnly && TIMING_US_ONLY_IDS.has(valueId)) return;
        if (command === 0x07) {
            if (valueId >= CUSTOM_VALUE_IDS || !CUSTOM_WRITABLE(valueId)) return;
            let v0 = value[0];
            if ((valueId === 0 || valueId === 2) && v0 >= 11) return; // DPI_CHOICES_LENGTH
            if (valueId === 5 && v0 >= 6) return;
            if (valueId === 9 && v0 >= 7) return; // TURBO_CHOICES_LENGTH
            if (valueId === 30 && v0 > 2) v0 = 2;
            if (valueId >= 25 && valueId <= 29) v0 = v0 ? 1 : 0;
            c[valueId * 2] = v0;
            if (CUSTOM_TWO_BYTE.has(valueId) || valueId >= 32) c[valueId * 2 + 1] = value[1];
            this.changed();
        } else if (command === 0x08) {
            if (valueId >= CUSTOM_VALUE_IDS || !CUSTOM_READABLE(valueId)) return;
            value[0] = c[valueId * 2];
            if (CUSTOM_TWO_BYTE.has(valueId) || valueId === 31 || valueId >= 32) value[1] = c[valueId * 2 + 1];
        }
        // id_custom_save: write_eeprom_kb(); values are already stored here
    }

    /** VIA values 55-57 (svalboard.c, pad_gestures.c): each write takes the nearest stored value. */
    private padTuningValue(command: number, valueId: number, value: Uint8Array): void {
        const t = this.padTuning;
        if (command === 0x07) {
            this.customWrites.push({ id: valueId, value: Array.from(value.subarray(0, 2)) });
            const v = value[0] | (value[1] << 8);
            if (valueId === 55) t.deadZone = nearest(PAD_DEAD_ZONE_MM100, v);
            else if (valueId === 56) t.tapMs = nearest(PAD_TAP_MS, v);
            else t.scroll = v === 0 || v === FAKE_SCROLL_BUILD_MM100 ? 0 : nearest(PAD_SCROLL_MM100.slice(1), v);
        } else if (command === 0x08) {
            const v = valueId === 55 ? t.deadZone : valueId === 56 ? t.tapMs : t.scroll || FAKE_SCROLL_BUILD_MM100;
            value[0] = v & 0xff;
            value[1] = v >> 8;
        }
    }

    private chipSettings(): ChipSettings {
        const s = this.padSetting;
        return {
            deadZone: this.padTuning.deadZone, tapMs: this.padTuning.tapMs, holdMs: PAD_HOLD_MS[(s >> 3) & 0x0f],
            tapOn: (s & 1) === 0, twoFingerOn: (s & 2) === 0, holdOn: (s & 4) === 0,
        };
    }

    /** The touch page of 0x2D (docs/protocol.md "Touchpad touch"), from the scripted touches. */
    private touchPage(out: Uint8Array): void {
        const now = this.now() * this.touchSpeed;
        if (!this.padPlayers) {
            this.padPlayers = [0, SCRIPT_MS / 2].map((offset) => ({ model: new ChipModel(() => this.chipSettings()), fedTo: now, offset }));
        }
        const blocks = this.padPlayers.map((p) => {
            // Feed every 10 ms sample since the last read (at most one loop's worth).
            for (let t = Math.max(p.fedTo, now - SCRIPT_MS); t <= now; t += 10) {
                const loop = (t + p.offset) % SCRIPT_MS;
                p.model.sample({ ...scriptSample(loop), t });
            }
            p.fedTo = now + 10;
            return p.model.read(now);
        });
        const c = this.chipSettings();
        out.set(packPadTouch({
            tapOn: c.tapOn, twoFingerOn: c.twoFingerOn, holdOn: c.holdOn, elapsedMs: 0,
            deadZone: c.deadZone, tapMs: c.tapMs, holdMs: c.holdMs, width: PAD_WIDTH_MM100, height: PAD_HEIGHT_MM100, channelsX: 8, channelsY: 7,
            scrollStart: this.padTuning.scroll || FAKE_SCROLL_BUILD_MM100, left: blocks[0], right: blocks[1],
        }));
    }

    /** VIA values 51-54 (svalboard.c, pad_gestures.c). */
    private padValue(command: number, valueId: number, value: Uint8Array): void {
        const bit = valueId === 51 ? 0x01 : valueId === 52 ? 0x02 : 0x04;
        if (command === 0x07) {
            this.customWrites.push({ id: valueId, value: Array.from(value.subarray(0, 2)) });
            if (valueId === 54) {
                const ms = value[0] | (value[1] << 8);
                // Nearest; a tie takes the shorter (pad_gestures.c).
                const i = PAD_HOLD_MS.reduce((best, h, j) => {
                    const d = Math.abs(h - ms), b = Math.abs(PAD_HOLD_MS[best] - ms);
                    return d < b || (d === b && h < PAD_HOLD_MS[best]) ? j : best;
                }, 0);
                this.padSetting = (this.padSetting & ~0x78) | (i << 3);
            } else {
                this.padSetting = value[0] ? this.padSetting & ~bit : this.padSetting | bit;
            }
        } else if (command === 0x08) {
            if (valueId === 54) {
                const ms = PAD_HOLD_MS[(this.padSetting >> 3) & 0x0f];
                value[0] = ms & 0xff;
                value[1] = ms >> 8;
            } else {
                value[0] = this.padSetting & bit ? 0 : 1;
            }
        }
    }

    /**
     * scanlab_via_command (keyboards/svalboard/scanlab.c): STATUS, POWER and
     * IDLE for both halves, with no sweep or probe running; every other op
     * answers zeros, as an idle engine does. The right half is the one with USB.
     */
    private scanlabCommand(data: Uint8Array, length: number): void {
        const [cmd, , id] = [data[0], data[1], data[2]];
        const args = data.subarray(3);
        if (cmd !== 0x07 && cmd !== 0x08) return;
        const op = cmd === 0x08 ? id & ~0x08 : id;
        const hand = cmd === 0x08 ? (id >> 3) & 1 : args[0] & 1;
        const rsp = new Uint8Array(SCANLAB_RSP_LEN);
        const c = this.state.custom;
        const v16 = (vid: number) => c[vid * 2] | (c[vid * 2 + 1] << 8);
        const turbo = c[ID_TURBO_SCAN * 2] < TURBO_US.length ? c[ID_TURBO_SCAN * 2] : 0;
        const pre = v16(13) || TURBO_US[turbo], post = v16(14) || TURBO_US[turbo];
        const idleFlags = [25, 26, 27, 28, 29].reduce((f, vid, bit) => f | ((c[vid * 2] ? 1 : 0) << bit), 0);
        if (op === 0x10) {
            rsp[0] = 1; // SCANLAB_PROTO_VERSION
            put16(rsp, 8, pre);
            put16(rsp, 10, post);
            rsp[12] = hand === 0 ? 1 : 0;
            rsp[13] = 0b000100; // pushed: the active-dark centre key (sval_pushed_mask)
            put16(rsp, 17, v16(13));
            put16(rsp, 19, v16(14));
            rsp[21] = this.timingUsOnly ? this.timingPreset() : c[ID_TURBO_SCAN * 2];
            rsp[22] = hand === 1 ? 1 : 0; // the USB half sees the other half
            if (this.debounceSwitch) rsp[23] = 0x01 | (this.opticalDebounceOn ? 0x02 : 0);
        } else if (op === 0x11) {
            put16(rsp, 0, v16(20));
            put16(rsp, 2, v16(21));
            put16(rsp, 4, v16(22));
            put16(rsp, 6, 1000); // measured frame, us
            put16(rsp, 8, SCANLAB_ROWS * (pre + 13)); // LED on per frame, us
            put16(rsp, 11, v16(20));
            put16(rsp, 13, pre);
            put16(rsp, 15, post);
            rsp[17] = SCANLAB_ROWS;
            put16(rsp, 18, v16(23));
            put16(rsp, 20, v16(24));
            rsp[22] = (idleFlags & 0x1f) << 2;
        } else if (op === 0x12) {
            rsp[0] = idleFlags;
            rsp[5] = this.state.rgb[0];
            rsp[4] = this.state.rgb[0];
            rsp[7] = 1;
            rsp[21] = 125;
            rsp[22] = [48, 24, 12][Math.min(2, c[30 * 2])];
        }
        // Firmware before the debounce switch copies 23 bytes back.
        const n = Math.min(Math.max(0, length - 3), this.debounceSwitch ? SCANLAB_RSP_LEN : SCANLAB_RSP_LEN - 1);
        args.set(rsp.subarray(0, n));
    }

    /** via_qmk_rgblight_command (quantum/via.c): brightness, effect, speed, color. */
    private rgblightCommand(data: Uint8Array): void {
        const [command, , id] = [data[0], data[1], data[2]];
        const value = data.subarray(3);
        const rgb = this.state.rgb;
        if (command === 0x09) return; // save
        const fields: Record<number, number[]> = { 1: [0], 2: [1], 3: [2], 4: [3, 4] };
        const at = fields[id];
        if (!at) {
            data[0] = ID_UNHANDLED;
            return;
        }
        if (command === 0x07) {
            at.forEach((field, i) => { rgb[field] = value[i]; });
            this.changed();
        } else {
            at.forEach((field, i) => { value[i] = rgb[field]; });
        }
    }

    /** identity_via_command (keyboards/svalboard/identity.c). */
    private identityCommand(data: Uint8Array, length: number, wrapped: boolean): void {
        const [cmd, , op] = [data[0], data[1], data[2]];
        const v = data.subarray(3);
        if (length < 3 + 13) return;
        const chunk = length - 5 - (wrapped ? CLIENT_WRAPPER_OVERHEAD : 0);
        const name = new TextEncoder().encode(this.state.identityName);
        if (cmd === 0x08 && op === 0) {
            v[0] = 1; // protocol
            v[1] = 1; // available
            v[2] = name.length;
            v[3] = IDENTITY_NAME_MAX_BYTES;
            v[4] = 2; // serial source: random
            v.set(IDENTITY_SERIAL, 5);
        } else if (cmd === 0x08 && op === 1) {
            const off = v[0];
            const n = off < name.length ? Math.min(chunk, name.length - off) : 0;
            v[0] = 0;
            v[1] = n;
            v.set(name.subarray(off, off + n), 2);
        } else if (cmd === 0x07 && op === 1) {
            const [off, n] = [v[0], v[1]];
            if (n > chunk || off + n > IDENTITY_NAME_MAX_BYTES) {
                v[0] = 1;
                return;
            }
            this.stagedName.set(v.subarray(2, 2 + n), off);
            v[0] = 0;
        } else if (cmd === 0x07 && op === 2) {
            const n = v[0];
            if (n > IDENTITY_NAME_MAX_BYTES) {
                v[0] = 1;
                return;
            }
            this.state.identityName = new TextDecoder().decode(this.stagedName.subarray(0, n));
            this.changed();
            v[0] = 0;
        } else if (cmd === 0x07 && op === 3) {
            v[0] = 0; // reboot: the simulated board stays connected
        } else {
            v[0] = 1;
        }
    }

    // ---- modules/svalboard/core/sval.c -----------------------------------------

    /** sval_handle_command: data[0] = 0xDF, data[1] = command, in place. */
    private svalCommand(data: Uint8Array, length: number): void {
        const cmd = data[1];
        const s = this.state;
        const table = TABLE_COMMANDS[cmd];
        if (table) {
            this.tableCommand(data, length, table.table, table.set, table.minLength);
            return;
        }
        switch (cmd) {
            case 0x00: { // GET_INFO
                put32(data, 2, SVAL_PROTOCOL_VERSION);
                data.set(KEYBOARD_UID, 6);
                data[14] = FEATURE_FLAGS;
                data[15] = KEYCODES_VERSION[0];
                data[16] = KEYCODES_VERSION[1];
                data[17] = KEYCODES_VERSION[2];
                data[18] = s.storageFlags & 0x05; // bit 1 (write failed) never happens here
                data[19] = this.featureFlags2;
                if (length > 20) data[20] = this.featureFlags3;
                break;
            }
            case 0x2a: // STORAGE_RESET_CLEAR
                if (s.storageFlags) {
                    s.storageFlags = 0;
                    this.changed();
                }
                break;
            case 0x09: { // ONE_SHOT_GET: QMK settings 6 and 5
                data[2] = s.qmkSettings[2];
                data[3] = s.qmkSettings[3];
                data[4] = s.qmkSettings[28];
                break;
            }
            case 0x0a: // ONE_SHOT_SET
                s.qmkSettings[2] = data[2];
                s.qmkSettings[3] = data[3];
                s.qmkSettings[28] = data[4];
                this.changed();
                break;
            case 0x0b: // SAVE: data is written directly
                break;
            case 0x0c: // RESET: every Sval table and label, the keymap and macros (sval_reset)
                this.reset();
                break;
            case 0x0d: // DEFINITION_SIZE
                put32(data, 2, DEFINITION_BYTES.length);
                break;
            case 0x0e: { // DEFINITION_CHUNK: [offset:2][size] -> [offset:2][actual][data...]
                const offset = le16(data, 2);
                let requested = data[4];
                if (requested === 0 || requested > SVAL_DEFINITION_CHUNK_SIZE) requested = SVAL_DEFINITION_CHUNK_SIZE;
                if (offset >= DEFINITION_BYTES.length) {
                    data[4] = 0;
                    break;
                }
                const actual = Math.min(requested, DEFINITION_BYTES.length - offset);
                data.set(DEFINITION_BYTES.subarray(offset, offset + actual), 5);
                data[4] = actual;
                break;
            }
            case 0x10: { // QMK_SETTINGS_QUERY: QSIDs above qsid_gt, 0xFFFF-terminated
                const after = le16(data, 2);
                const out = data.subarray(2, length);
                out.fill(0xff);
                let o = 0;
                for (const d of SETTINGS) {
                    if (d.qsid > after) {
                        if (o + 4 > out.length) break;
                        put16(out, o, d.qsid);
                        o += 2;
                    }
                }
                break;
            }
            case 0x11: // QMK_SETTINGS_GET: [qsid:2] -> [status][value...]
                data[2] = this.qmkSettingsGet(le16(data, 2), data.subarray(3, length));
                break;
            case 0x12: // QMK_SETTINGS_SET: [qsid:2][value...] -> [status]
                data[2] = this.qmkSettingsSet(le16(data, 2), data.subarray(4, length));
                break;
            case 0x13: { // QMK_SETTINGS_RESET
                const fresh = blankBoard();
                s.qmkSettings = fresh.qmkSettings;
                s.magic = fresh.magic;
                this.changed();
                break;
            }
            case 0x16: { // LAYER_STATE_GET: [active:4][default:4][mods][status]
                if (length < 10) {
                    data[1] = SVAL_CMD_ERROR;
                    break;
                }
                put32(data, 2, this.layerState);
                put32(data, 6, (1 << s.defaultLayer) >>> 0);
                if (length >= 12) {
                    data[10] = 0; // no modifiers held
                    data[11] = 0; // Caps Word off, Caps Lock off
                }
                break;
            }
            case 0x17: // LAYER_STATE_SET
                this.layerState = le32(data, 2);
                break;
            case 0x2b: { // DEFAULT_LAYER_SET: [layer] -> [status]
                if (length < 3) {
                    data[1] = SVAL_CMD_ERROR;
                    break;
                }
                const layer = data[2];
                if (layer >= LAYERS) {
                    data[2] = 1;
                    break;
                }
                s.defaultLayer = layer;
                this.changed();
                data[2] = 0;
                break;
            }
            case 0x2c: // POINTING_HARDWARE: no pointing module on either half
                if (length > 2) {
                    const out = data.subarray(2, length);
                    out.fill(0);
                    if (out.length >= 11) {
                        out[0] = 1; // format
                        // This half (the USB half: right), then the other (left).
                        // flags: reported | auto (the build drives whatever answers); built for none; none answered.
                        if (this.touchpad) {
                            // An Azoteq pad on each half (IQS550: product 40).
                            out.set([0x01 | 0x04 | 0x08, 5, 5, 0, 40], 1);
                            out.set([0x01 | 0x02 | 0x04 | 0x08, 5, 5, 0, 40], 6);
                        } else {
                            out.set([0x01 | 0x08, 0, 3, 0, 0], 1);
                            out.set([0x01 | 0x02 | 0x08, 0, 3, 0, 0], 6);
                        }
                    }
                }
                break;
            case 0x2d: { // POINTING_MOTION: format 0, no data; page 1 (DF 2D <reader> 01) is the touch page
                const page = length > 3 ? data[3] : 0;
                if (length > 2) data.subarray(2, length).fill(0);
                if (page === 1 && this.padGestures && this.touchpad && length >= 2 + 56) this.touchPage(data.subarray(2, length));
                break;
            }
            case 0x2f: // POINTING_CONTACTS (not advertised): format 0
                if (length > 2) data.subarray(2, length).fill(0);
                break;
            case 0x18: { // FRAGMENT_GET_HARDWARE: [count][21 ids]
                data[2] = FRAGMENT_INSTANCE_COUNT;
                for (let i = 0; i < FRAGMENT_MAX_INSTANCES; i++) {
                    data[3 + i] = POINTING_FRAGMENT_INSTANCES.includes(i) ? (this.touchpad ? POINTING_AZOTEQ_FRAGMENT_ID : POINTING_NONE_FRAGMENT_ID) : 0xff;
                }
                break;
            }
            case 0x19: // FRAGMENT_GET_SELECTIONS: [count][21 selections]
                data[2] = FRAGMENT_INSTANCE_COUNT;
                for (let i = 0; i < FRAGMENT_MAX_INSTANCES; i++) data[3 + i] = i < FRAGMENT_INSTANCE_COUNT ? s.fragments[i] : 0xff;
                break;
            case 0x1a: { // FRAGMENT_SET_SELECTIONS: [count][21] -> [status]
                if (length < 24) {
                    data[2] = 1;
                    break;
                }
                let count = data[2];
                if (count > FRAGMENT_MAX_INSTANCES) {
                    data[2] = 2;
                    break;
                }
                if (count > FRAGMENT_INSTANCE_COUNT) count = FRAGMENT_INSTANCE_COUNT;
                for (let i = 0; i < count; i++) s.fragments[i] = data[3 + i];
                this.changed();
                data[2] = 0;
                break;
            }
            case 0x21: // TABLE_SCAN
                this.tableScan(data);
                break;
            case 0x1e: // MACRO_BUFFER_SIZE
                put32(data, 2, this.macroBufferSize);
                break;
            case 0x1f: case 0x20: { // MACRO_BUFFER_GET / SET: [offset:4][count][data...]
                if (length < 7) {
                    data[1] = SVAL_CMD_ERROR;
                    break;
                }
                const offset = le32(data, 2);
                const count = data[6];
                const size = this.macroBufferSize;
                if (count > length - 7 || offset > size || count > size - offset) {
                    if (cmd === 0x1f) data[6] = 0;
                    else data[2] = 1;
                    break;
                }
                if (cmd === 0x1f) {
                    this.macroRead(offset, count, data.subarray(7));
                } else {
                    this.macroWrite(offset, data.subarray(7, 7 + count));
                    this.changed();
                    data[2] = 0;
                }
                break;
            }
            case 0x1b: // LABEL_GET
                this.labelGet(data, length);
                break;
            case 0x1c: // LABEL_SET
                this.labelSet(data, length);
                break;
            case 0x1d: // LABEL_CLEAR
                this.labelClear(data, length);
                break;
            case 0x3d: // FLICKER_LATCH
                if (!this.flickerLatch) {
                    data[1] = SVAL_CMD_ERROR;
                    break;
                }
                if (length > 3) this.flickerCommand(data.subarray(2), length - 2);
                break;
            case 0x3c: // TYPING_PAUSE
                if (!this.typingPause) {
                    data[1] = SVAL_CMD_ERROR;
                    break;
                }
                if (length > 3) this.typingPauseCommand(data.subarray(2), length - 2);
                break;
            default:
                // Unknown command (context layers 0x26-0x29 included: not modeled), and
                // SIDE (0x33), which only either-hand builds have
                data[1] = SVAL_CMD_ERROR;
        }
    }

    private tableCommand(data: Uint8Array, length: number, tableId: number, set: boolean, minLength: number): void {
        const table = TABLES[tableId];
        const bytes = table.bytes(this.state);
        const index = le16(data, 2);
        if (!set) {
            // [index:2] -> [index:2][entry]; an index past the table reads as zeros
            const entry = data.subarray(4, 4 + table.size);
            entry.fill(0);
            if (index < TABLE_ENTRIES) entry.set(bytes.subarray(index * table.size, (index + 1) * table.size));
            return;
        }
        if (length < minLength) {
            data[1] = SVAL_CMD_ERROR;
            return;
        }
        if (index >= TABLE_ENTRIES) {
            data[2] = 1;
            return;
        }
        bytes.set(data.subarray(4, 4 + table.size), index * table.size);
        this.changed();
        data[2] = 0;
    }

    private tableScan(data: Uint8Array): void {
        // [table][start:2] -> [table][found][index:2][entry (the largest entry's room)]
        const tableId = data[2];
        const table = TABLES[tableId];
        let i = le16(data, 3);
        let found = false;
        const entry = new Uint8Array(LEADER_SIZE);
        for (; ; i++) {
            entry.fill(0);
            if (!table || i >= TABLE_ENTRIES) break;
            entry.set(table.bytes(this.state).subarray(i * table.size, (i + 1) * table.size));
            if (table.used(entry)) {
                found = true;
                break;
            }
        }
        data[3] = found ? 1 : 0;
        data[4] = i & 0xff;
        data[5] = (i >> 8) & 0xff;
        if (found) data.set(entry, 6);
    }

    /** sval_get_label_array: the label slots of a type, or null for an unknown type. */
    private labelArray(type: number): Uint8Array | null {
        if (type === LABEL_TYPE_COMBO && !this.comboLabels) return null;
        return this.state.labels[type] ?? null;
    }

    private labelGet(data: Uint8Array, length: number): void {
        // [type][start:2] -> [type][found][index:2][label:16]
        if (length < 6 + LABEL_SIZE) {
            data[1] = SVAL_CMD_ERROR;
            return;
        }
        const labels = this.labelArray(data[2]);
        if (!labels) {
            data[1] = SVAL_CMD_ERROR;
            return;
        }
        const count = labels.length / LABEL_SIZE;
        let i = le16(data, 3);
        const empty = (n: number) => labels.subarray(n * LABEL_SIZE, (n + 1) * LABEL_SIZE).every((b) => b === 0);
        while (i < count && empty(i)) i++;
        data[3] = i < count ? 1 : 0;
        data[4] = i & 0xff;
        data[5] = (i >> 8) & 0xff;
        data.subarray(6, 6 + LABEL_SIZE).fill(0);
        if (i < count) data.set(labels.subarray(i * LABEL_SIZE, (i + 1) * LABEL_SIZE), 6);
    }

    private labelStatus(type: number, index: number): number {
        const labels = this.labelArray(type);
        if (!labels) return 0x01; // invalid type
        if (index >= labels.length / LABEL_SIZE) return 0x02; // index out of range
        return 0x00;
    }

    private labelSet(data: Uint8Array, length: number): void {
        // [type][index:2][label:16] -> [status]
        if (length < 5 + LABEL_SIZE) {
            data[1] = SVAL_CMD_ERROR;
            return;
        }
        const type = data[2];
        const index = le16(data, 3);
        const label = data.slice(5, 5 + LABEL_SIZE);
        if (!validLabel(label)) {
            data[2] = 0x03;
            return;
        }
        const status = this.labelStatus(type, index);
        if (status === 0) {
            this.labelArray(type)!.set(label, index * LABEL_SIZE);
            this.changed();
        }
        data[2] = status;
    }

    private labelClear(data: Uint8Array, length: number): void {
        // [type][index:2] -> [status]
        if (length < 5) {
            data[1] = SVAL_CMD_ERROR;
            return;
        }
        const type = data[2];
        const index = le16(data, 3);
        const status = this.labelStatus(type, index);
        if (status === 0) {
            this.labelArray(type)!.fill(0, index * LABEL_SIZE, (index + 1) * LABEL_SIZE);
            this.changed();
        }
        data[2] = status;
    }

    private qmkSettingsGet(qsid: number, out: Uint8Array): number {
        const s = this.state;
        if (qsid === 21) {
            if (out.length < 4) return 0xff;
            put32(out, 0, s.magic);
            return 0;
        }
        const d = SETTINGS.find((x) => x.qsid === qsid);
        if (!d) return 0xff;
        if (isBitSetting(qsid)) {
            out[0] = (s.qmkSettings[d.offset] >> d.bit) & 1;
            return 0;
        }
        if (d.size > out.length) return 0xff;
        out.set(s.qmkSettings.subarray(d.offset, d.offset + d.size));
        return 0;
    }

    private qmkSettingsSet(qsid: number, value: Uint8Array): number {
        const s = this.state;
        if (qsid === 21) {
            if (value.length < 4) return 0xff;
            s.magic = le32(value, 0) & 0x3ff;
            this.changed();
            return 0;
        }
        const d = SETTINGS.find((x) => x.qsid === qsid);
        if (!d) return 0xff;
        if (isBitSetting(qsid)) {
            if (value[0]) s.qmkSettings[d.offset] |= 1 << d.bit;
            else s.qmkSettings[d.offset] &= ~(1 << d.bit);
            this.changed();
            return 0;
        }
        if (d.size > value.length) return 0xff;
        s.qmkSettings.set(value.subarray(0, d.size), d.offset);
        this.changed();
        return 0;
    }

    /**
     * sval_reset(): the Sval tables, labels (combo names too) and fragment
     * selections cleared, tap dance terms back to 200, the keymap and macros reset.
     * The real board keeps showing its old labels and QMK settings until it
     * restarts; this simulation shows the result after that restart, except that
     * QMK settings stay as they were.
     */
    private reset(): void {
        const fresh = blankBoard();
        const s = this.state;
        s.tapDance = fresh.tapDance;
        s.combo = fresh.combo;
        s.keyOverride = fresh.keyOverride;
        s.altRepeatKey = fresh.altRepeatKey;
        s.leader = fresh.leader;
        s.labels = fresh.labels;
        s.fragments = fresh.fragments;
        s.macros.fill(0);
        if (this.factoryKeymap) s.keymap.set(this.factoryKeymap);
        this.changed();
    }
}

/** LABEL_SET's UTF-8 check (sval.c): status 0x03 when this returns false. */
export function validLabel(label: Uint8Array): boolean {
    let nullTail = false;
    let i = 0;
    while (i < LABEL_SIZE) {
        const c = label[i];
        if (c === 0) { nullTail = true; i++; continue; }
        if (nullTail) return false;
        if (c >= 0x01 && c <= 0x1f && c !== 0x09) return false;
        if (c === 0x7f) return false;
        if (c <= 0x7f) { i++; continue; }
        let cont: number;
        if (c >= 0xc2 && c <= 0xdf) cont = 1;
        else if (c >= 0xe0 && c <= 0xef) cont = 2;
        else if (c >= 0xf0 && c <= 0xf4) cont = 3;
        else return false;
        if (i + cont >= LABEL_SIZE) return false;
        for (let j = 1; j <= cont; j++) {
            const cb = label[i + j];
            if (cb < 0x80 || cb > 0xbf) return false;
        }
        if (c === 0xe0 && label[i + 1] < 0xa0) return false;
        if (c === 0xed && label[i + 1] > 0x9f) return false;
        if (c === 0xf0 && label[i + 1] < 0x90) return false;
        if (c === 0xf4 && label[i + 1] > 0x8f) return false;
        i += 1 + cont;
    }
    return true;
}
