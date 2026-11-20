// The simulated Svalboard's stored settings: what a real board keeps in its
// EEPROM (keymap, macros, Sval tables, labels, QMK settings, custom values,
// fragment selections, identity name). Sizes come from the firmware build
// (svalboard/qmk keyboards/svalboard + modules/svalboard/core, combo-labels branch).
//
// Kept in localStorage under STORAGE_KEY, so the "board" keeps its settings
// across a page reload the way a real board does. wipeFakeBoard() forgets it;
// the next connect seeds it again.

export const ROWS = 10;
export const COLS = 6;
export const LAYERS = 16; // info.json dynamic_keymap.layer_count
export const MACRO_COUNT = 256; // config.h DYNAMIC_KEYMAP_MACRO_COUNT
export const TABLE_ENTRIES = 256; // sval.json "sval": every table has 256 entries
export const LABEL_SIZE = 16;
export const FRAGMENT_MAX_INSTANCES = 21;
export const QMK_SETTINGS_SIZE = 44;

// Entry sizes (sval.h)
export const TAP_DANCE_SIZE = 10;
export const COMBO_SIZE = 12;
export const KEY_OVERRIDE_SIZE = 12;
export const ALT_REPEAT_KEY_SIZE = 6;
export const LEADER_SIZE = 14;

// Combo names take the end of the 128 KB logical EEPROM: an 8-byte header and
// 16 bytes per combo (post_config.h), cut from the macro buffer's tail.
export const COMBO_LABEL_REGION_SIZE = 8 + TABLE_ENTRIES * LABEL_SIZE;
// The macro buffer runs from after the keymap to the end of the EEPROM: 106664
// bytes on firmware without combo names (the size Keybard's v3 tests use for a
// Svalboard), that less the combo-names region with them.
export const MACRO_BUFFER_SIZE_NO_COMBO_LABELS = 106664;
export const MACRO_BUFFER_SIZE = MACRO_BUFFER_SIZE_NO_COMBO_LABELS - COMBO_LABEL_REGION_SIZE;

/** Custom values on VIA channel 0 (svalboard.c enum sval_via_value_id), 2 bytes each. */
export const CUSTOM_VALUE_IDS = 51; // 0-50; 48 (optical debounce) is held by the firmware model

export const LABEL_TYPE_LAYER = 0;
export const LABEL_TYPE_TAP_DANCE = 1;
export const LABEL_TYPE_MACRO = 2;
export const LABEL_TYPE_COMBO = 3;

export interface FakeBoardState {
    /** Dynamic keymap, as stored: big-endian keycodes, layer by row by column. */
    keymap: Uint8Array;
    /** The whole macro buffer (as large as firmware without combo names has). */
    macros: Uint8Array;
    tapDance: Uint8Array;
    combo: Uint8Array;
    keyOverride: Uint8Array;
    altRepeatKey: Uint8Array;
    leader: Uint8Array;
    /** Labels by type (layer, tap dance, macro, combo), LABEL_SIZE bytes per slot. */
    labels: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    /** sval_qmk_settings_t, 44 bytes (sval_qmk_settings.c). */
    qmkSettings: Uint8Array;
    /** QMK keymap_config bits as the Magic setting (QSID 21) reads them. */
    magic: number;
    /** Fragment selections (option index per instance; 0xFF none). */
    fragments: Uint8Array;
    /** VIA custom values on channel 0, two bytes per value ID. */
    custom: Uint8Array;
    /** rgblight: [brightness, effect, speed, hue, sat]. */
    rgb: Uint8Array;
    identityName: string;
    /** The board's saved default layer (PDF / DEFAULT_LAYER_SET). */
    defaultLayer: number;
    /** GET_INFO storage flags bit 0 / bit 2, until the host clears them (0x2A). */
    storageFlags: number;
    /** The app rules record (settings area record 10): [format][count][0][0] and 64 rules of 24 bytes. */
    appRules: Uint8Array;
}

/** The app rules record (format 2, packed): header, rules and their text share it. */
export const APP_RULES_RECORD_BYTES = 1792;

export const STORAGE_KEY = "keybard.fakeBoard.v1";

const labelCounts = [LAYERS, TABLE_ENTRIES, MACRO_COUNT, TABLE_ENTRIES] as const;

/** A board straight after a firmware reset (sval_reset, sval_qmk_settings_reset, read_eeprom_kb defaults). */
export function blankBoard(): FakeBoardState {
    const tapDance = new Uint8Array(TABLE_ENTRIES * TAP_DANCE_SIZE);
    // Every tap dance slot keeps a usable term (SVAL_TAP_DANCE_DEFAULT_TERM), not enabled.
    for (let i = 0; i < TABLE_ENTRIES; i++) {
        tapDance[i * TAP_DANCE_SIZE + 8] = 200 & 0xff;
        tapDance[i * TAP_DANCE_SIZE + 9] = 200 >> 8;
    }
    const state: FakeBoardState = {
        keymap: new Uint8Array(LAYERS * ROWS * COLS * 2),
        macros: new Uint8Array(MACRO_BUFFER_SIZE_NO_COMBO_LABELS),
        tapDance,
        combo: new Uint8Array(TABLE_ENTRIES * COMBO_SIZE),
        keyOverride: new Uint8Array(TABLE_ENTRIES * KEY_OVERRIDE_SIZE),
        altRepeatKey: new Uint8Array(TABLE_ENTRIES * ALT_REPEAT_KEY_SIZE),
        leader: new Uint8Array(TABLE_ENTRIES * LEADER_SIZE),
        labels: labelCounts.map((n) => new Uint8Array(n * LABEL_SIZE)) as FakeBoardState["labels"],
        qmkSettings: defaultQmkSettings(),
        // keymap_config after sval_qmk_settings_reset: NKRO on (bit 7 as QSID 21 reads it)
        magic: 1 << 7,
        // Erased storage reads as option 0 everywhere (sval_reset zeroes the block)
        fragments: new Uint8Array(FRAGMENT_MAX_INSTANCES),
        custom: defaultCustomValues(),
        rgb: Uint8Array.from([255, 1, 0, 0, 0]),
        identityName: "",
        defaultLayer: 0,
        storageFlags: 0,
        // Never stored: all zeros, no rules.
        appRules: new Uint8Array(APP_RULES_RECORD_BYTES),
    };
    return state;
}

function put16(bytes: Uint8Array, offset: number, value: number) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
}

/** sval_qmk_settings_reset() with this board's config (Svalboard config.h, info.json). */
function defaultQmkSettings(): Uint8Array {
    const s = new Uint8Array(QMK_SETTINGS_SIZE);
    put16(s, 0, 175); // auto_shift_timeout
    put16(s, 2, 5000); // osk_timeout
    put16(s, 4, 30); // mousekey_delay (info.json mousekey.delay)
    put16(s, 6, 16); // mousekey_interval (QMK default)
    put16(s, 8, 1); // mousekey_move_delta (info.json)
    put16(s, 10, 15); // mousekey_max_speed (info.json)
    put16(s, 12, 40); // mousekey_time_to_max (info.json)
    put16(s, 14, 10); // mousekey_wheel_delay
    put16(s, 16, 80); // mousekey_wheel_interval
    put16(s, 18, 8); // mousekey_wheel_max_speed
    put16(s, 20, 40); // mousekey_wheel_time_to_max
    put16(s, 22, 50); // combo_term
    put16(s, 24, 200); // tapping_term
    s[26] = 0; // grave_esc_override
    s[27] = 0; // auto_shift
    s[28] = 5; // osk_tap_toggle
    s[29] = 0b1001; // tapping_v2: permissive hold + chordal hold (SVAL_DEFAULT_*)
    put16(s, 30, 10); // tap_code_delay
    put16(s, 32, 80); // tap_hold_caps_delay
    s[34] = 5; // tapping_toggle
    put16(s, 36, 200); // quick_tap_term = TAPPING_TERM
    put16(s, 38, 0); // flow_tap_term
    put16(s, 40, 300); // leader_timeout (SVAL_DEFAULT_LEADER_TIMEOUT)
    s[42] = 1; // leader_options: per-key timing (SVAL_DEFAULT_LEADER_PER_KEY_TIMING)
    return s;
}

/** read_eeprom_kb() defaults (svalboard.c), as channel-0 custom values. */
function defaultCustomValues(): Uint8Array {
    const c = new Uint8Array(CUSTOM_VALUE_IDS * 2);
    const set = (id: number, lo: number, hi = 0) => { c[id * 2] = lo; c[id * 2 + 1] = hi; };
    set(0, 3); // left DPI index
    set(1, 1); // left scroll
    set(2, 3); // right DPI index
    set(3, 0); // right scroll
    set(4, 1); // auto mouse
    set(5, 3); // auto mouse timeout index
    set(6, 15); // auto mouse threshold
    set(7, 0); // natural scroll
    set(8, 1); // axis lock
    set(9, 0); // turbo scan
    set(10, 7); // auto mouse decay
    set(11, 1); // left pointer activates
    set(12, 1); // right pointer activates
    for (let id = 25; id <= 29; id++) set(id, 0); // idle toggles: SVAL_IDLE_FLAGS_DEFAULT is 0 (every power-saving mode is opt-in)
    // Layer colors, [hue, sat] (svalboard.c defaults)
    const colors = [0x55ff, 0x15ff, 0x95ff, 0x0bb0, 0x2bff, 0x80ff, 0x00ff, 0x00ff, 0xeaff, 0xbfff, 0x0bb0, 0x6aff, 0x80ff, 0x80ff, 0x2bff, 0xd5ff];
    colors.forEach((hs, layer) => set(32 + layer, hs >> 8, hs & 0xff));
    return c;
}

// ---- persistence ----------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function fromBase64(text: string, length: number): Uint8Array {
    const out = new Uint8Array(length);
    const raw = atob(text);
    for (let i = 0; i < raw.length && i < length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

/** Bytes up to the last nonzero one: an almost empty macro buffer stays small. */
function trimmed(bytes: Uint8Array): Uint8Array {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return bytes.subarray(0, end);
}

type Stored = Record<string, string | number>;

const binaryFields = ["keymap", "macros", "tapDance", "combo", "keyOverride", "altRepeatKey", "leader", "qmkSettings", "fragments", "custom", "rgb", "appRules"] as const;

export function serializeBoard(state: FakeBoardState): string {
    const out: Stored = { v: 1, magic: state.magic, identityName: state.identityName, defaultLayer: state.defaultLayer, storageFlags: state.storageFlags };
    for (const field of binaryFields) out[field] = toBase64(trimmed(state[field]));
    state.labels.forEach((l, i) => { out[`labels${i}`] = toBase64(trimmed(l)); });
    return JSON.stringify(out);
}

export function deserializeBoard(text: string): FakeBoardState | null {
    try {
        const stored = JSON.parse(text) as Stored;
        if (stored.v !== 1) return null;
        const state = blankBoard();
        for (const field of binaryFields) {
            if (typeof stored[field] === "string") state[field] = fromBase64(stored[field] as string, state[field].length);
        }
        state.labels = state.labels.map((l, i) => typeof stored[`labels${i}`] === "string" ? fromBase64(stored[`labels${i}`] as string, l.length) : l) as FakeBoardState["labels"];
        state.magic = Number(stored.magic) >>> 0;
        state.identityName = String(stored.identityName ?? "");
        state.defaultLayer = Number(stored.defaultLayer) || 0;
        state.storageFlags = Number(stored.storageFlags) || 0;
        return state;
    } catch {
        return null;
    }
}

function storage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

export function loadStoredBoard(): FakeBoardState | null {
    const text = storage()?.getItem(STORAGE_KEY);
    return text ? deserializeBoard(text) : null;
}

export function storeBoard(state: FakeBoardState): void {
    try {
        storage()?.setItem(STORAGE_KEY, serializeBoard(state));
    } catch (e) {
        console.warn("[fake board] Could not save the simulated board's settings:", e);
    }
}

/** Forget the simulated board's settings; the next connect starts from the seeded board again. */
export function wipeFakeBoard(): void {
    try {
        storage()?.removeItem(STORAGE_KEY);
    } catch {
        // nothing stored
    }
}
