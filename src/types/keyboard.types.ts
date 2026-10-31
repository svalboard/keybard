// Type definitions for Svil keyboard configuration system
// Keyboard configuration and Sval protocol data.
import type { PointingHardwareReport } from "../utils/pointing-hardware";

export interface KeyboardInfo {
    via_proto?: number;
    svil_proto?: number;  // Svil protocol version
    vial_proto?: number;    // Present only on loaded .vil files
    kbid?: string;
    name?: string;          // Keyboard name from definition
    payload?: KeyboardPayload;
    rows: number;
    cols: number;
    layers?: number;
    custom_keycodes?: CustomKeycode[];
    keymap?: number[][];
    macros?: MacroEntry[];
    macro_count?: number;
    macros_size?: number;
    combos?: ComboEntry[];
    tapdances?: TapdanceEntry[];
    key_overrides?: KeyOverrideEntry[];
    alt_repeat_keys?: AltRepeatKeyEntry[];  // NEW: Svil feature
    leaders?: LeaderEntry[];                 // NEW: Svil feature
    one_shot?: OneShotSettings;              // NEW: Svil feature
    settings?: Record<number, number>;
    tapdance_count?: number;
    combo_count?: number;
    key_override_count?: number;
    alt_repeat_key_count?: number;           // NEW
    leader_count?: number;                   // NEW
    feature_flags2?: number;                 // Second feature byte, after the storage flags; zero on older firmware
    feature_flags3?: number;                 // Third feature byte (GET_INFO byte 20); zero on older firmware
    feature_flags?: number;                  // NEW: Svil feature flags
    keycode_version?: string;                // QMK keycode numbering the keycodes are in, e.g. "0.0.9"
    storage_reset?: boolean;                 // board reset its settings: its storage could not be read
    storage_build_reset?: boolean;           // board reset its settings on the first boot of a new firmware build (D39)
    pointing_hardware?: PointingHardwareReport; // connected boards: each half's side and trackball sensor (POINTING_HARDWARE)
    storage_write_failed?: boolean;          // board couldn't save a change since it started: changes will be lost on restart
    keycode_version_reported?: boolean;      // Connected boards: whether GET_INFO reported the numbering (vLaunch on)
    raw_keycode_count?: number;              // Loaded files: keycodes stored as numbers rather than names
    vial_import?: {                          // Loaded .vil files
        svalboard: boolean;                  // written by Svalboard's Vial firmware
        unassigned_custom_keycodes: number;  // USERnn positions Vial left unassigned (now KC_NO)
        foreign_custom_keycodes: number;     // USERnn from another keyboard's Vial firmware
    };

    // Fragment composition (modular layouts)
    fragments?: Record<string, FragmentDefinition>;  // Fragment definitions
    composition?: FragmentComposition;               // Layout composition
    fragmentState?: FragmentState;                   // Current fragment selections

    // Svalboard-specific
    sval_proto?: number;
    sval_firmware?: string;
    layer_colors?: Array<{ hue: number; sat: number; val: number }>;
    cosmetic?: {
        name?: string;
        layer?: Record<string, string>;
        layer_colors?: Record<string, string>;
        macros?: Record<string, string>;
        tapdances?: Record<string, string>;
        /** Combo names, keyed by combo index. Kept in Keybard (files and backups), never on the board. */
        combos?: Record<string, string>;
    };
    keylayout?: Record<string, any>; // Using any for now to match KLE output structure

    // VIA3 Custom UI menus (auto-generated settings panels)
    menus?: CustomUIMenuItem[];

    // VIA3 Custom values (loaded at connect time, used for export/import)
    custom_values?: CustomValueEntry[];
}

/**
 * A stored custom value entry (VIA3 dynamic menu value)
 * Stores raw bytes so multi-byte values survive round-trip without precision loss
 */
export interface CustomValueEntry {
    key: string;        // e.g. "id_left_dpi"
    channel: number;    // VIA channel (usually 0)
    valueId: number;    // Value index within channel
    data: number[];     // Raw bytes, little-endian
}

export interface KeyboardPayload {
    matrix: {
        rows: number;
        cols: number;
    };
    customKeycodes?: CustomKeycode[];
    layouts?: Record<string, KeyLayout>;
    lighting?: unknown;
}

export interface KeyLayout {
    col: number;
    color: string;
    decal: boolean;
    ghost: boolean;
    h: number;
    height2: number;
    labels: string[];
    nub: boolean;
    profile: string;
    rotation_angle: number;
    rotation_x: number;
    rotation_y: number;
    row: number;
    sb: string;
    sm: string;
    st: string;
    stepped: boolean;
    text: string;
    textColor: string;
    textSize: number[];
    align?: number;
    matrix?: number[];
    w: number;
    width2: number;
    x: number;
    x2: number;
    y: number;
    y2: number;
}

export interface CustomKeycode {
    name: string;
    title: string;
    shortName: string;
}

export interface MacroEntry {
    mid: number;
    actions: MacroAction[];
}

export type MacroAction = [string, string | number];

export interface ComboEntry {
    cmbid: number;
    keys: string[];
    output: string;
    options: number;    // custom_combo_term uint16, bit 15 = enabled
}

// Combo option bits
export const ComboOptions = {
    ENABLED: 1 << 15,
} as const;


export interface TapdanceEntry {
    idx: number; // Index in the list
    tap: string;
    hold: string;
    doubletap: string;
    taphold: string;
    tapping_term: number;
    enabled?: boolean; // Stored in bit 15 of tapping_term in protocol
}

export interface KeyOverrideEntry {
    koid: number;
    trigger: string;
    replacement: string;
    layers: number;
    trigger_mods: number;
    negative_mod_mask: number;
    suppressed_mods: number;
    options: number;
}


// Removed: QMKSettings interface (conflicted with qmk.d.ts)
// Keyboard settings values are now stored as Record<number, number> in KeyboardInfo.settings

export interface USBSendOptions {
    uint8?: boolean;
    uint16?: boolean;
    uint32?: boolean;
    index?: number;
    unpack?: string;
    bigendian?: boolean;
    slice?: number;
    bytes?: number;
    skipBytes?: number;  // Skip N bytes from start of payload before parsing (e.g., skip cmd echo)
    validateInput?: (data: Uint8Array) => boolean;
}

export interface KeyboardAPI {
    what: string;
    updateKey(layer: number, row: number, col: number, keymask: number): Promise<void>;
    updateMacros(kbinfo: KeyboardInfo): Promise<void>;
    updateTapdance(kbinfo: KeyboardInfo, tdid: number): Promise<void>;
    updateCombo(kbinfo: KeyboardInfo, cmbid: number): Promise<void>;
    updateKeyoverride(kbinfo: KeyboardInfo, koid: number): Promise<void>;
    updateQMKSetting(kbinfo: KeyboardInfo, qfield: string): Promise<void>;
}

export interface KeyContent {
    type?: string;
    str?: string;
    title?: string;
    top?: string;
    layertext?: string;
    tdid?: number;
    modids?: number;
    mods?: string;
    [key: string]: any; // Allow other properties for now until fully typed
}

// ============================================================================
// Sval protocol types
// ============================================================================

/**
 * Alt Repeat Key entry (6 bytes in firmware)
 * Allows remapping the repeat key to alternate keycodes
 */
export interface AltRepeatKeyEntry {
    arkid: number;              // Index
    keycode: string;            // Original keycode to match
    alt_keycode: string;        // Alternate keycode to send on repeat
    allowed_mods: number;       // Modifier mask for matching
    options: number;            // Option flags (bit 3 = enabled)
}

// Alt repeat key option bits
export const AltRepeatKeyOptions = {
    DEFAULT_TO_ALT: 1 << 0,
    BIDIRECTIONAL: 1 << 1,
    IGNORE_MOD_HANDEDNESS: 1 << 2,
    ENABLED: 1 << 3,
} as const;

/**
 * Leader key sequence entry (14 bytes in firmware)
 */
export interface LeaderEntry {
    ldrid: number;              // Index
    sequence: string[];         // Up to 5 keys in order
    output: string;             // Output keycode
    options: number;            // bit 15 = enabled
}

// Leader option bits
export const LeaderOptions = {
    ENABLED: 1 << 15,
} as const;

/**
 * One-shot key settings (3 bytes in firmware)
 */
export interface OneShotSettings {
    timeout: number;            // Timeout in ms (0 = disabled)
    tap_toggle: number;         // Number of taps to toggle (0 = disabled)
}

/**
 * Svil protocol info response
 */
export interface SvilProtocolInfo {
    protocol_version: number;   // 32-bit protocol version
    keyboard_uid: Uint8Array;   // 8-byte UID
    feature_flags: number;      // 8-bit feature flags
}

// Svil feature flags
export const SvilFeatureFlags = {
    CAPS_WORD: 1 << 0,
    LAYER_LOCK: 1 << 1,
    ONESHOT: 1 << 2,
    LEADER: 1 << 3,
} as const;

/**
 * Svil API interface (extends KeyboardAPI for new features)
 */
export interface SvilAPI extends KeyboardAPI {
    updateAltRepeatKey(kbinfo: KeyboardInfo, arkid: number): Promise<void>;
    updateLeader(kbinfo: KeyboardInfo, ldrid: number): Promise<void>;
    updateOneShot(kbinfo: KeyboardInfo): Promise<void>;
    saveSvil(): Promise<void>;
    resetSvil(): Promise<void>;
}

// ============================================================================
// Fragment Types (for modular keyboard layouts)
// ============================================================================

/**
 * Fragment definition from keyboard definition JSON
 * Defines a visual layout template that can be instantiated at positions
 */
export interface FragmentDefinition {
    id: number;                 // Numeric fragment ID (0-254), used in protocol
    description?: string;       // Human-readable name (e.g., "5-key finger cluster")
    kle: unknown[];            // KLE layout data for visual rendering ([] for a zero-key widget fragment)
    widget?: FragmentWidget;    // Zero-key fragment drawn as a widget (pointing module slot)
}

/**
 * A zero-key fragment drawn as a widget instead of keys. An instance whose every
 * option is a widget fragment is a widget instance: it never adds keys to the
 * layout, and only hardware detection (0x18) decides which option it shows.
 */
export interface FragmentWidget {
    kind: "pointing";
    module: "none" | "unknown" | "trackball" | "touchpad" | "trackpoint";
    sensor?: "pmw3360" | "pmw3389" | "azoteq" | "trackpoint";
    w: number;                  // Size in key units
    h: number;
}

/**
 * Fragment option for a selectable instance position
 */
export interface FragmentOption {
    fragment: string;           // Reference to fragment name in fragments section
    placement: {                // Visual positioning offset
        x: number;
        y: number;
    };
    matrix_map: [number, number][];  // Array of [row, col] pairs for matrix positions
    encoder_offset?: number;    // Offset for encoder indices
    default?: boolean;          // True if this is the default option
    allow_override?: boolean;   // Whether user can override hardware detection
}

/**
 * Instance in the composition - either fixed or selectable
 */
export interface FragmentInstance {
    id: string;                 // String ID (e.g., "left_pinky"), used in keymap files
    // Fixed instance (no user choice):
    fragment?: string;          // Direct fragment reference
    placement?: {               // Visual positioning
        x: number;
        y: number;
    };
    matrix_map?: [number, number][];  // Matrix positions
    encoder_offset?: number;    // Encoder index offset
    // Selectable instance (user can choose):
    fragment_options?: FragmentOption[];  // Available fragments for this position
    allow_override?: boolean;   // Whether user can override hardware detection (default: true)
    hardware_detect?: boolean;  // Firmware reports this position via 0x18
}

/**
 * Fragment composition from keyboard definition JSON
 */
export interface FragmentComposition {
    instances: FragmentInstance[];
}

/**
 * Current fragment selections state
 */
export interface FragmentState {
    // Hardware detection results from device (0x18 response)
    // Maps instance array index -> fragment ID (0-254, or 0xFF for no detection)
    hwDetection: Map<number, number>;

    // EEPROM selections from device (0x19 response)
    // Maps instance array index -> option index (0-254, or 0xFF for no selection)
    eepromSelections: Map<number, number>;

    // User selections in current session (from keymap file or UI)
    // Maps instance string ID -> fragment name
    userSelections: Map<string, string>;

    // The board's selections (0x19) were read on this connection. A write sends
    // every instance's selection, so without them it would reset the others.
    selectionsRead?: boolean;
}

// ============================================================================
// VIA3 Custom UI Types (for dynamic keyboard settings panels)
// ============================================================================

/**
 * Control types supported by VIA3 Custom UI
 */
export type CustomUIControlType = 'toggle' | 'range' | 'dropdown' | 'color' | 'keycode' | 'button' | 'link'; // link: app-provided, opens another view

/**
 * Custom UI menu item - can be a section (with nested content) or a control (leaf)
 * Follows VIA3 custom_ui specification
 */
export interface CustomUIMenuItem {
    label?: string;                              // Display label for section or control
    description?: string;                        // Short app-provided hover help
    type?: CustomUIControlType;                  // Control type (only for leaf nodes)
    options?: number[] | string[];               // [min, max] for range, or string[] for dropdown
    content?: (string | number)[] | CustomUIMenuItem[];  // Value ref [key, channel, id] or nested items
    showIf?: string;                             // Conditional visibility expression e.g. "{id_foo} == 1"
    /** App-provided: one plain line shown under a section's label. */
    note?: string;
    /** App-provided: the control is shown but grayed out and unusable while this is true (showIf syntax). */
    disabledIf?: string;
    /** App-provided: shown units per stored unit (1000 shows stored seconds as ms). Options stay in stored units. */
    displayScale?: number;
}

/**
 * Parsed value reference from content array
 */
export interface CustomUIValueRef {
    key: string;          // Human-readable key (e.g., "id_automouse_enable")
    channel: number;      // VIA channel (usually 0 for keyboard custom)
    valueId: number;      // Index within channel
    extraIndices?: number[];  // Additional indices for complex values (e.g., color h/s/v)
}
