// USB HID communication layer for Svil protocol
// Supports client ID wrapper (0xDD) for multi-client concurrent access
import type { USBSendOptions } from "../types/keyboard.types";
import { updaterTimers } from "./updater/timers";
import { BE16, LE16 } from "./utils";
import {
  DEFAULT_REPORT_LENGTH,
  WRAPPER_HEADER_BYTES,
  payloadCapacity,
  reportLength as deviceReportLength,
} from "./hid-report";

// Protocol prefixes
const WRAPPER_PREFIX = 0xdd;
const SVIL_PREFIX = 0xdf;
const VIA_PREFIX = 0xfe;

// Framing in front of the data of a chunked transfer, counted from the start of
// the report (wrapper included). The data room is the report length minus these.
// VIA get/set buffer: [wrapper:6][cmd][offset:2][size][data...]
export const VIA_BUFFER_HEADER_BYTES = WRAPPER_HEADER_BYTES + 4;
// Sval DEFINITION_CHUNK reply: [wrapper:6][cmd][offset:2][actual_size][data...]
export const SVIL_DEFINITION_HEADER_BYTES = WRAPPER_HEADER_BYTES + 4;
// Sval MACRO_BUFFER_GET reply / SET request: [wrapper:6][cmd][offset:4][count][data...]
export const SVIL_MACRO_BUFFER_HEADER_BYTES = WRAPPER_HEADER_BYTES + 6;

// Client ID constants
const NONCE_SIZE = 20;
const DEFAULT_TTL_SECS = 120;
// The firmware ages client IDs by the top 16 bits of its millisecond timer,
// i.e. in 65.536 s steps, so an ID advertised with a 120 s TTL can be rejected
// anywhere from ~65 s to ~131 s after issue. Renew well inside the floor.
const CLIENT_ID_RENEW_SECS = 50;
// Wrapper error frame: [0xDD][client_id:4][0xFF][error_code]
const CLIENT_ERROR_PROTOCOL = 0xff;
import { toHidOpenError } from "../utils/linux-hid-access";
import { assertSupportedSvilProto, UnsupportedFirmwareError, type UnsupportedFirmwareInfo } from "../utils/unsupported-firmware";
import { SVALBOARD_VIAL_UID } from "../constants/svalboard-vial";

// Unwrapped probes for identifying firmware that doesn't speak the wrapper. All read-only.
const PROBE_TIMEOUT_MS = 300;
const VIAL_GET_KEYBOARD_ID = [VIA_PREFIX, 0x00]; // -> [vial_proto:4 LE][uid:8 LE]
const VIA_GET_PROTOCOL_VERSION = [0x01];         // -> [0x01][version:2 BE]
// Svalboard's Vial firmware (v25.02 on) has its own 0xEE protocol
const SVAL_VIAL_GET_PROTO = [0xee, 0x01];        // -> "sval"[version:4 LE]
const SVAL_VIAL_GET_FIRMWARE = [0xee, 0x02];     // -> QMK_VERSION, NUL-terminated
const SVAL_MAGIC = [0x73, 0x76, 0x61, 0x6c];     // "sval"
const QMK_UNHANDLED = 0xff;                      // QMK's id_unhandled reply prefix

export const CLIENT_ERR_INVALID_ID = 0x01;
export const CLIENT_ERR_NO_IDS = 0x02;
export const CLIENT_ERR_UNKNOWN_PROTO = 0x03;

/** The keyboard answered a wrapped command with an error frame instead of a response. */
export class ClientIdRejectedError extends Error {
  constructor(public readonly code: number) {
    super(code === CLIENT_ERR_INVALID_ID ? "Keyboard rejected our client ID (expired or unknown)" : `Keyboard wrapper error ${code}`);
    this.name = "ClientIdRejectedError";
  }
}

// Sval protocol version 2 widened table indices (tap dance, combo, key override,
// alt-repeat key, leader, label) from one byte to two, for 256-entry tables.
export const SVIL_PROTO_WIDE_INDEX = 2;

/** Whether a keyboard speaking this Sval protocol version takes 2-byte table indices. */
export function svilHasWideIndex(version: number | undefined): boolean {
  return (version ?? 1) >= SVIL_PROTO_WIDE_INDEX;
}

/**
 * Index bytes for a Sval table GET/SET request.
 * v1: [index]; v2+: [index lo][index hi]
 */
export function svilIndexArgs(version: number | undefined, index: number): number[] {
  if (svilHasWideIndex(version)) return LE16(index);
  // A v1 index is one byte; a larger one would wrap and address the wrong entry
  if (index > 0xff) throw new RangeError(`Sval v1 index out of range: ${index}`);
  return [index];
}

/**
 * Offset of the entry within a Sval table GET response (wrapper and 0xDF stripped).
 * v1: [cmd_echo][index][entry...] -> 2; v2+: [cmd_echo][index lo][index hi][entry...] -> 3
 */
export function svilEntryOffset(version: number | undefined): number {
  return svilHasWideIndex(version) ? 3 : 2;
}

// Sval protocol version 3 added MACRO_BUFFER_* (32-bit offsets), since the macro buffer
// outgrew the 16-bit offsets of VIA's macro commands, and TABLE_SCAN.
export const SVIL_PROTO_MACRO_BUFFER = 3;
export const SVIL_PROTO_TABLE_SCAN = 3;

/** Whether a keyboard speaking this Sval protocol version has TABLE_SCAN (also v3). */
export function svilHasTableScan(version: number | undefined): boolean {
  return (version ?? 1) >= SVIL_PROTO_TABLE_SCAN;
}

/** Whether a keyboard speaking this Sval protocol version has the MACRO_BUFFER_* commands. */
export function svilHasMacroBuffer(version: number | undefined): boolean {
  return (version ?? 1) >= SVIL_PROTO_MACRO_BUFFER;
}

/** The keyboard answered a Sval write with a nonzero status (e.g. index out of range). */
export class SvilCommandRefusedError extends Error {
  constructor(public readonly cmd: number, public readonly status: number) {
    super(`Keyboard refused Sval command 0x${cmd.toString(16)} (status ${status})`);
    this.name = "SvilCommandRefusedError";
  }
}

/**
 * Check the status of a Sval write response: [cmd_echo][status], 0 = ok.
 * Throws SvilCommandRefusedError otherwise.
 */
export function checkSvilStatus(cmd: number, resp: Uint8Array): void {
  if (resp[1] !== 0) throw new SvilCommandRefusedError(cmd, resp[1]);
}

/** Whether a reply repeats our request from `from` on (client ID and nonce). */
function isOurRequest(response: Uint8Array, request: Uint8Array, from: number): boolean {
  for (let i = from; i < 5 + NONCE_SIZE; i++) {
    if (response[i] !== request[i]) return false;
  }
  return true;
}

/** A reply starting with the "sval" magic of Svalboard Vial's 0xEE protocol. */
function isSvalMagic(reply: Uint8Array): boolean {
  return SVAL_MAGIC.every((b, i) => reply[i] === b);
}

/** Vial's keyboard-ID reply: [vial_proto:4 LE][uid:8 LE], where vial_proto is a small number. */
function isVialKeyboardId(reply: Uint8Array): boolean {
  return reply[0] !== QMK_UNHANDLED && reply[0] !== VIA_PREFIX && reply[0] !== WRAPPER_PREFIX &&
    reply[1] === 0 && reply[2] === 0 && reply[3] === 0;
}

/**
 * What the unwrapped probes found. "via-only": only the VIA protocol version was
 * answered (Svalboard QMK answers it too). "silent": nothing answered.
 */
type ProbedFirmware = UnsupportedFirmwareInfo | { kind: "via-only" } | { kind: "silent" };

/**
 * Firmware kind for a keyboard that has shown it doesn't speak the wrapper
 * (id_unhandled or an echo): there a VIA answer does mean some other QMK board.
 */
function knownNotSval(probed: ProbedFirmware): UnsupportedFirmwareInfo {
  if (probed.kind === "via-only") return { kind: "other-qmk" };
  if (probed.kind === "silent") return { kind: "unknown" };
  return probed;
}

/** A NUL-terminated string from a reply, or undefined if it isn't printable text. */
function printableString(bytes: Uint8Array): string | undefined {
  const end = bytes.indexOf(0);
  const text = new TextDecoder().decode(bytes.slice(0, end < 0 ? bytes.length : end)).trim();
  return text && /^[ -~]+$/.test(text) ? text : undefined;
}

// Generate cryptographically random nonce
function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_SIZE);
  crypto.getRandomValues(nonce);
  return nonce;
}

/** How long a late updater reply gets to arrive, after a timeout, before the next request goes out. */
const UPDATER_DRAIN_MS = 500;

export class SvilUSB {
  // VIA command constants (unchanged, used via wrapper)
  static readonly CMD_VIA_GET_PROTOCOL_VERSION = 0x01;
  static readonly CMD_VIA_GET_KEYBOARD_VALUE = 0x02;
  static readonly CMD_VIA_SET_KEYBOARD_VALUE = 0x03;
  static readonly CMD_VIA_GET_KEYCODE = 0x04;
  static readonly CMD_VIA_SET_KEYCODE = 0x05;
  static readonly CMD_VIA_LIGHTING_SET_VALUE = 0x07;
  static readonly CMD_VIA_LIGHTING_GET_VALUE = 0x08;
  static readonly CMD_VIA_LIGHTING_SAVE = 0x09;
  static readonly CMD_VIA_MACRO_GET_COUNT = 0x0c;
  static readonly CMD_VIA_MACRO_GET_BUFFER_SIZE = 0x0d;
  static readonly CMD_VIA_MACRO_GET_BUFFER = 0x0e;
  static readonly CMD_VIA_MACRO_SET_BUFFER = 0x0f;
  static readonly CMD_VIA_GET_LAYER_COUNT = 0x11;
  static readonly CMD_VIA_KEYMAP_GET_BUFFER = 0x12;
  static readonly CMD_VIA_KEYMAP_SET_BUFFER = 0x13;

  static readonly VIA_LAYOUT_OPTIONS = 0x02;
  static readonly VIA_SWITCH_MATRIX_STATE = 0x03;

  static readonly QMK_BACKLIGHT_BRIGHTNESS = 0x09;
  static readonly QMK_BACKLIGHT_EFFECT = 0x0a;
  static readonly QMK_RGBLIGHT_BRIGHTNESS = 0x80;
  static readonly QMK_RGBLIGHT_EFFECT = 0x81;
  static readonly QMK_RGBLIGHT_EFFECT_SPEED = 0x82;
  static readonly QMK_RGBLIGHT_COLOR = 0x83;

  // Svil command IDs (0xDF protocol)
  static readonly CMD_SVIL_GET_INFO = 0x00;
  static readonly CMD_SVIL_TAP_DANCE_GET = 0x01;
  static readonly CMD_SVIL_TAP_DANCE_SET = 0x02;
  static readonly CMD_SVIL_COMBO_GET = 0x03;
  static readonly CMD_SVIL_COMBO_SET = 0x04;
  static readonly CMD_SVIL_KEY_OVERRIDE_GET = 0x05;
  static readonly CMD_SVIL_KEY_OVERRIDE_SET = 0x06;
  static readonly CMD_SVIL_ALT_REPEAT_KEY_GET = 0x07;
  static readonly CMD_SVIL_ALT_REPEAT_KEY_SET = 0x08;
  static readonly CMD_SVIL_ONE_SHOT_GET = 0x09;
  static readonly CMD_SVIL_ONE_SHOT_SET = 0x0a;
  static readonly CMD_SVIL_SAVE = 0x0b;
  static readonly CMD_SVIL_RESET = 0x0c;
  static readonly CMD_SVIL_DEFINITION_SIZE = 0x0d;
  static readonly CMD_SVIL_DEFINITION_CHUNK = 0x0e;
  static readonly CMD_SVIL_QMK_SETTINGS_QUERY = 0x10;
  static readonly CMD_SVIL_QMK_SETTINGS_GET = 0x11;
  static readonly CMD_SVIL_QMK_SETTINGS_SET = 0x12;
  static readonly CMD_SVIL_QMK_SETTINGS_RESET = 0x13;
  static readonly CMD_SVIL_LEADER_GET = 0x14;
  static readonly CMD_SVIL_LEADER_SET = 0x15;
  static readonly CMD_SVIL_LAYER_STATE_GET = 0x16;
  static readonly CMD_SVIL_LAYER_STATE_SET = 0x17;
  static readonly CMD_SVIL_FRAGMENT_GET_HARDWARE = 0x18;
  static readonly CMD_SVIL_FRAGMENT_GET_SELECTIONS = 0x19;
  static readonly CMD_SVIL_FRAGMENT_SET_SELECTIONS = 0x1a;
  static readonly CMD_SVIL_LABEL_GET = 0x1b;
  static readonly CMD_SVIL_LABEL_SET = 0x1c;
  static readonly CMD_SVIL_LABEL_CLEAR = 0x1d;
  static readonly CMD_SVIL_MACRO_BUFFER_SIZE = 0x1e;
  static readonly CMD_SVIL_MACRO_BUFFER_GET = 0x1f;
  static readonly CMD_SVIL_MACRO_BUFFER_SET = 0x20;
  static readonly CMD_SVIL_TABLE_SCAN = 0x21;
  static readonly CMD_SVIL_STORAGE_RESET_CLEAR = 0x2a;
  static readonly CMD_SVIL_DEFAULT_LAYER_SET = 0x2b;
  static readonly CMD_SVIL_POINTING_HARDWARE = 0x2c; // each half's side and trackball sensor
  static readonly CMD_SVIL_POINTING_MOTION = 0x2d; // each hand's motion since the last read (read-and-clear)
  static readonly CMD_SVIL_POINTING_CONTACTS = 0x2f; // every touch contact on its pad (a snapshot; native touchpad)

  // Label types for CMD_SVIL_LABEL_*; every label is a fixed 16-byte, null-padded UTF-8 field
  static readonly SVIL_LABEL_TYPE_LAYER = 0;
  static readonly SVIL_LABEL_TYPE_TAP_DANCE = 1;
  static readonly SVIL_LABEL_TYPE_MACRO = 2;
  static readonly SVIL_LABEL_SIZE = 16;

  // Svalboard-specific constants
  static readonly SVAL_GET_LEFT_DPI = 0x00;
  static readonly SVAL_GET_RIGHT_DPI = 0x00;
  static readonly SVAL_GET_LEFT_SCROLL = 0x00;
  static readonly SVAL_GET_RIGHT_SCROLL = 0x00;
  static readonly SVAL_GET_AUTOMOUSE = 0x00;
  static readonly SVAL_GET_AUTOMOUSE_MS = 0x00;

  static readonly SVAL_SET_LEFT_DPI = 0x00;
  static readonly SVAL_SET_RIGHT_DPI = 0x00;
  static readonly SVAL_SET_LEFT_SCROLL = 0x00;
  static readonly SVAL_SET_RIGHT_SCROLL = 0x00;
  static readonly SVAL_SET_AUTOMOUSE = 0x00;
  static readonly SVAL_SET_AUTOMOUSE_MS = 0x00;

  private device?: HIDDevice;
  private queue: Promise<void> = Promise.resolve();
  private listener: (data: ArrayBuffer, ev: HIDInputReportEvent) => void =
    () => { };

  // Client ID management
  private clientId: number = 0;
  private clientTtl: number = DEFAULT_TTL_SECS;
  private clientIdExpiry: number = 0;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private bootstrapPromise?: Promise<void>; // Prevent concurrent bootstraps
  private bootstrapped = false; // This connection has had a client ID before

  // Sval protocol version of the connected keyboard, from CMD_SVIL_GET_INFO
  // (set while connecting). Assume version 1 until the keyboard says otherwise.
  public svilProtocolVersion: number = 1;

  // Raw HID report length of the open device, from its report descriptor
  // (32 bytes on today's firmware, 64 on newer builds). Every report we send is
  // this long, and chunked transfers size their data from it.
  public reportLength: number = DEFAULT_REPORT_LENGTH;

  public onDisconnect?: () => void;

  // The firmware updater (src/services/updater) follows client ID changes and
  // disconnects without taking over onDisconnect, which KeyboardContext owns.
  private clientRenewedListeners = new Set<(id: number, old: number) => void>();
  private disconnectListeners = new Set<() => void>();

  private handleDisconnect = (event: HIDConnectionEvent) => {
    if (this.device && event.device === this.device) {
      console.log("Device disconnected:", event.device.productName);
      if (this.onDisconnect) this.onDisconnect();
      for (const listener of [...this.disconnectListeners]) listener();
      this.close();
    }
  };

  /** Called after every new client ID, with the new and the old ID. Returns an unsubscribe. */
  onClientRenewed(listener: (id: number, old: number) => void): () => void {
    this.clientRenewedListeners.add(listener);
    return () => { this.clientRenewedListeners.delete(listener); };
  }

  /** Called when the open device goes away. Returns an unsubscribe. */
  addDisconnectListener(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }

  /** Whether a device is open. */
  isOpen(): boolean {
    return !!this.device;
  }

  /** The client ID wrapped commands carry now (0 before the first bootstrap). */
  currentClientId(): number {
    return this.clientId;
  }

  /** Bootstrap a client ID if there's none or it's due; returns it. */
  async ensureClient(): Promise<number> {
    await this.ensureClientId();
    return this.clientId;
  }

  /** Drop the current client ID and take a fresh one now; returns it. */
  async renewClient(): Promise<number> {
    if (!this.bootstrapPromise) {
      this.clientId = 0;
      this.clientIdExpiry = 0;
    }
    await this.ensureClientId();
    return this.clientId;
  }

  /**
   * One wrapped VIA request for the firmware updater, with no retry of any kind:
   * a rejected client ID throws ClientIdRejectedError, so the updater can take a
   * new ID and REBIND its session before it sends anything else. Resolves with
   * the whole reply report, the first one for this client whose bytes 6..
   * repeat payload[0..echo).
   */
  async sendUpdaterReport(payload: number[], echo = 3, timeoutMs = 1000): Promise<Uint8Array> {
    if (!this.device) throw new Error("USB device not connected");
    await this.ensureClientId();
    const clientId = this.clientId;
    const message = this.buildWrappedMessage(VIA_PREFIX, payload);
    const operation = this.queue.then(() => new Promise<Uint8Array>((resolve, reject) => {
      if (!this.device) { reject(new Error("USB device not connected")); return; }
      // The reply timeout runs on the update's timers: a background tab clamps the page's
      // timers (to a minute, after a while), and a late timeout holds the queue that long.
      const timers = updaterTimers();
      const timeoutId = timers.setTimeout(() => reject(new Error("USB Command Timeout")), timeoutMs);
      this.listener = (data: ArrayBuffer) => {
        const u8 = new Uint8Array(data);
        if (u8[0] !== WRAPPER_PREFIX) return;
        const respClientId = (u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24)) >>> 0;
        if (respClientId !== clientId >>> 0) return;
        if (u8[5] === CLIENT_ERROR_PROTOCOL) {
          timers.clearTimeout(timeoutId);
          reject(new ClientIdRejectedError(u8[6]));
          return;
        }
        if (u8[5] !== VIA_PREFIX) return;
        for (let i = 0; i < echo; i++) if (u8[6 + i] !== payload[i]) return;
        timers.clearTimeout(timeoutId);
        resolve(new Uint8Array(u8));
      };
      this.device.sendReport(0, message as BufferSource).catch((err) => {
        timers.clearTimeout(timeoutId);
        reject(err);
      });
    }));
    // After a timeout the board may still answer that request. Its late reply carries the same
    // op as the next request's (INFO page 0 and page 1 can't be told apart by the echo), so hold
    // the next request back and let the timed-out listener swallow the straggler.
    this.queue = operation.then(() => undefined).catch((error) => {
      if (!(error instanceof Error) || !/timeout/i.test(error.message)) return undefined;
      return new Promise<void>((resolve) => updaterTimers().setTimeout(resolve, UPDATER_DRAIN_MS));
    });
    return operation;
  }

  async open(filters: HIDDeviceFilter[]): Promise<boolean> {
    const device = await SvilUSB.requestDevice(filters);
    return device ? this.openDevice(device) : false;
  }

  /** Show the browser's device chooser; null when the user picks nothing. */
  static async requestDevice(filters: HIDDeviceFilter[]): Promise<HIDDevice | null> {
    const devices = await navigator.hid.requestDevice({ filters });
    return devices.length === 1 ? devices[0] : null;
  }

  /** Whether this connection currently has the given device open. */
  hasDevice(device: HIDDevice): boolean {
    return this.device === device;
  }

  /**
   * Check that a device runs firmware Keybard can use before anything switches
   * over to it: bootstrap a client ID (which identifies Vial and other non-Sval
   * firmware) and read the Sval protocol version. It runs on its own short-lived
   * connection, so whatever is being edited now (a connected board or an offline
   * draft) is untouched. Throws UnsupportedFirmwareError, or the open error.
   */
  static async checkFirmware(device: HIDDevice): Promise<void> {
    const probe = new SvilUSB();
    try {
      await probe.openDevice(device);
      const info = await probe.sendSvil(SvilUSB.CMD_SVIL_GET_INFO, [], { uint8: true }) as Uint8Array;
      // [cmd_echo][protocol_version:4]...
      assertSupportedSvilProto(info[1] | (info[2] << 8) | (info[3] << 16) | (info[4] << 24));
    } finally {
      await probe.close().catch(() => undefined);
    }
  }

  /**
   * Open a device this origin already has permission for (one returned by
   * navigator.hid.getDevices()). No chooser is shown; the permission was granted
   * by the user in an earlier session.
   */
  async openDevice(device: HIDDevice): Promise<boolean> {
    this.device = device;
    this.bootstrapped = false;
    this.reportLength = deviceReportLength(device);
    if (!this.device.opened) {
      try {
        await this.device.open();
      } catch (error) {
        throw toHidOpenError(error, device);
      }
    }
    await this.initListener();
    navigator.hid.addEventListener("disconnect", this.handleDisconnect);

    // Don't bootstrap here - do it lazily on first command
    // This helps debug connection issues
    console.log(`USB device opened: ${this.device.productName} (${this.reportLength}-byte reports)`);

    return true;
  }

  /**
   * Check if the device is a Svil keyboard by checking serial number
   * TODO: Implement proper detection by checking "viable:" prefix in USB serial
   */
  isSvilDevice(): boolean {
    // For now, assume svil if connected
    // Real detection would check USB serial string for "viable:" prefix
    return true;
  }

  /**
   * Ensure we have a valid client ID, bootstrapping if needed
   */
  private async ensureClientId(): Promise<void> {
    // Single flight: every caller that finds the lease stale shares one bootstrap.
    const stale = this.clientId === 0 || Date.now() >= this.clientIdExpiry;
    if (stale && !this.bootstrapPromise) {
      console.log("Bootstrapping client ID...");
      this.bootstrapPromise = this.bootstrapClientId().finally(() => {
        this.bootstrapPromise = undefined;
      });
    }
    if (this.bootstrapPromise) {
      await this.bootstrapPromise;
    }
  }

  /** Current lease, for diagnostics and tests. */
  getClientLease(): { clientId: number; expiresAt: number } {
    return { clientId: this.clientId, expiresAt: this.clientIdExpiry };
  }

  /**
   * Bootstrap a client ID from the keyboard
   * Request: [0xDD][0x00000000][nonce:20]
   * Response: [0xDD][0x00000000][nonce:20][new_client_id:4][ttl:2]
   */
  private async bootstrapClientId(): Promise<void> {
    if (!this.device) throw new Error("USB device not connected");

    const nonce = generateNonce();

    const message = new Uint8Array(this.reportLength);
    message[0] = WRAPPER_PREFIX;
    // Client ID = 0 (bootstrap)
    message[1] = 0;
    message[2] = 0;
    message[3] = 0;
    message[4] = 0;
    // Nonce
    message.set(nonce, 5);

    console.log("Bootstrap request:", Array.from(message.slice(0, 5 + NONCE_SIZE)).map(b => b.toString(16).padStart(2, '0')).join(' '));

    // Send bootstrap request and wait for OUR response (might get other clients' responses first).
    // A fresh connection that gets no answer probes the board once and, if it
    // answers unwrapped VIA, tries the bootstrap again before giving up.
    for (let round = 0; ; round++) {
      if (await this.bootstrapRound(message, nonce)) return;

      // Nothing answered. On a board that has answered before, that's a hiccup.
      if (this.bootstrapped) throw new Error("Bootstrap failed after all retries");

      // Silence is never Vial (Vial firmware answers every packet), so only
      // report a firmware kind the probes positively identify.
      const probed = await this.identifyFirmware();
      if (probed.kind === "via-only" && round === 0) {
        console.warn("Keyboard answers VIA but not the bootstrap yet; retrying");
        continue;
      }
      if (probed.kind === "via-only" || probed.kind === "silent") {
        throw new UnsupportedFirmwareError({ kind: "no-response" });
      }
      throw new UnsupportedFirmwareError(probed);
    }
  }

  /**
   * Send the bootstrap request up to 5 times. Returns true once we hold a client
   * ID, false if nothing answered; throws UnsupportedFirmwareError when the
   * keyboard shows it doesn't speak the wrapper (id_unhandled or an echo).
   */
  private async bootstrapRound(message: Uint8Array, nonce: Uint8Array): Promise<boolean> {
    const maxAttempts = 5;
    const maxReadsPerAttempt = 50;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Send the bootstrap request
      await this.device!.sendReport(0, message as BufferSource);

      // Read responses until we find ours or timeout
      for (let read = 0; read < maxReadsPerAttempt; read++) {
        const response = await this.readWithTimeout(500);
        if (!response) {
          console.log("Bootstrap read timeout, retrying send...");
          break; // Timeout - retry the send
        }

        console.log("Bootstrap response:", Array.from(response.slice(0, 31)).map(b => b.toString(16).padStart(2, '0')).join(' '));

        // QMK without the wrapper answers [0xFF][rest of our request] (id_unhandled)
        if (response[0] === QMK_UNHANDLED && isOurRequest(response, message, 1)) {
          console.warn("Bootstrap request unhandled: not Sval firmware");
          throw new UnsupportedFirmwareError(knownNotSval(await this.identifyFirmware()));
        }

        // Validate wrapper prefix
        if (response[0] !== WRAPPER_PREFIX) {
          console.log("Unexpected response prefix, reading again...");
          continue;
        }

        // Check if client ID is 0 (bootstrap response)
        const respClientId = response[1] | (response[2] << 8) | (response[3] << 16) | (response[4] << 24);
        if (respClientId !== 0) {
          console.log(`Discarding response for client 0x${respClientId.toString(16)}, reading again...`);
          continue;
        }

        // Verify nonce echo (bytes 5-24)
        let nonceMatch = true;
        for (let i = 0; i < NONCE_SIZE; i++) {
          if (response[5 + i] !== nonce[i]) {
            nonceMatch = false;
            break;
          }
        }
        if (!nonceMatch) {
          console.log("Nonce mismatch (another client's response), reading again...");
          continue;
        }

        // Extract client ID (bytes 25-28, little-endian)
        const newClientId = response[25] |
          (response[26] << 8) |
          (response[27] << 16) |
          (response[28] << 24);

        // Extract TTL (bytes 29-30, little-endian)
        const ttl = response[29] | (response[30] << 8);

        if (newClientId === 0) {
          // Our request came back unchanged: Svalboard's Vial firmware echoes
          // every packet it doesn't know, so later commands would "answer" with
          // our own requests. Sval firmware always sends a non-zero TTL.
          if (ttl === 0) {
            console.warn("Bootstrap request echoed back: not Sval firmware");
            throw new UnsupportedFirmwareError(knownNotSval(await this.identifyFirmware()));
          }
          // Sval firmware can hand out ID 0 (timer high half and counter both 0)
          // but rejects it as a client ID. Ask again.
          console.log("Got client ID 0, which the keyboard won't accept; asking again...");
          break;
        }

        // Check for error
        if (newClientId === 0xFFFFFFFF) {
          const errorCode = response[29];
          throw new Error(`Bootstrap failed with error code ${errorCode}`);
        }

        const previousClientId = this.clientId;
        this.clientId = newClientId;
        this.clientTtl = ttl;

        // Renew at 90% of the advertised TTL, but never later than the firmware's
        // coarse expiry floor (see CLIENT_ID_RENEW_SECS).
        this.clientIdExpiry = Date.now() + Math.min(this.clientTtl * 900, CLIENT_ID_RENEW_SECS * 1000);

        // Schedule renewal
        this.scheduleRenewal();

        this.bootstrapped = true;
        console.log(`Svil client ID bootstrapped: 0x${this.clientId.toString(16)}, TTL: ${this.clientTtl}s`);
        for (const listener of [...this.clientRenewedListeners]) {
          try { listener(this.clientId, previousClientId); } catch (e) { console.error("Client ID listener failed:", e); }
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Work out what a keyboard that didn't take the client-ID bootstrap is running,
   * with unwrapped read-only requests, so the error can say what to do.
   * "via-only" means only the VIA protocol request was answered, which current
   * Svalboard QMK does too; "silent" means nothing answered.
   */
  private async identifyFirmware(): Promise<ProbedFirmware> {
    // Svalboard Vial firmware v25.02 and later: "sval" protocol, with its QMK version
    const proto = await this.probe(SVAL_VIAL_GET_PROTO, isSvalMagic);
    if (proto && isSvalMagic(proto)) {
      const version = await this.probe(SVAL_VIAL_GET_FIRMWARE, r => !isSvalMagic(r) && printableString(r) !== undefined);
      return { kind: "svalboard-vial", reportedVersion: version ? printableString(version) : undefined };
    }
    // Any Vial firmware reports its keyboard UID; Svalboard's is known
    const id = await this.probe(VIAL_GET_KEYBOARD_ID, isVialKeyboardId);
    if (id && isVialKeyboardId(id)) {
      const uid = id.slice(4, 12).reduce((acc, b, i) => acc | (BigInt(b) << BigInt(8 * i)), 0n);
      return { kind: uid === SVALBOARD_VIAL_UID ? "svalboard-vial" : "other-qmk" };
    }
    // VIA answers this: Vial, plain VIA and Svalboard QMK alike
    const isViaVersion = (r: Uint8Array) => r[0] === VIA_GET_PROTOCOL_VERSION[0];
    const via = await this.probe(VIA_GET_PROTOCOL_VERSION, isViaVersion);
    if (via && isViaVersion(via)) return { kind: "via-only" };
    return { kind: "silent" };
  }

  /**
   * Send one unwrapped request and return its reply: one that `fits` the expected
   * answer, or the keyboard's id_unhandled [0xFF][request] or echo of it. Anything
   * else (wrapped traffic, a late reply to an earlier request) is skipped.
   */
  private async probe(request: number[], fits: (reply: Uint8Array) => boolean): Promise<Uint8Array | null> {
    if (!this.device) return null;
    const message = new Uint8Array(this.reportLength);
    message.set(request);
    try {
      await this.device.sendReport(0, message as BufferSource);
    } catch (e) {
      console.warn("Firmware probe failed to send:", e);
      return null;
    }
    const answersRequest = (r: Uint8Array) =>
      request.every((b, i) => r[i] === b) ||
      (r[0] === QMK_UNHANDLED && request.every((b, i) => r[i + 1] === b));
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    for (let left = PROBE_TIMEOUT_MS; left > 0; left = deadline - Date.now()) {
      const response = await this.readWithTimeout(left);
      if (!response) return null;
      if (response[0] === WRAPPER_PREFIX) continue;
      if (fits(response) || answersRequest(response)) return response;
      console.log("Skipping a reply that doesn't answer this probe");
    }
    return null;
  }

  /**
   * Read a single HID report with timeout
   */
  private readWithTimeout(timeoutMs: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.device?.removeEventListener("inputreport", handler);
        resolve(null);
      }, timeoutMs);

      const handler = (ev: HIDInputReportEvent) => {
        clearTimeout(timeoutId);
        this.device?.removeEventListener("inputreport", handler);
        resolve(new Uint8Array(ev.data.buffer));
      };

      this.device?.addEventListener("inputreport", handler);
    });
  }

  /**
   * Schedule client ID renewal before expiry
   */
  private scheduleRenewal(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
    }

    const renewIn = this.clientIdExpiry - Date.now();
    if (renewIn > 0) {
      // Goes through ensureClientId so a renewal never races a command's own
      // bootstrap. Timers can fire late in a background tab; the lazy check in
      // ensureClientId covers that, and the error-frame retry in send() covers
      // the keyboard having already dropped the ID.
      this.renewalTimer = setTimeout(async () => {
        try {
          this.clientIdExpiry = 0;
          await this.ensureClientId();
        } catch (e) {
          console.error("Failed to renew client ID:", e);
        }
      }, renewIn + 5);
    }
  }

  getDeviceName(): string | null {
    return this.device?.productName || null;
  }

  async close(): Promise<void> {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = undefined;
    }
    this.clientId = 0;
    this.clientIdExpiry = 0;
    this.bootstrapped = false;
    this.svilProtocolVersion = 1;
    this.reportLength = DEFAULT_REPORT_LENGTH;

    if (this.device) {
      if (this.handleEvent) {
        this.device.removeEventListener("inputreport", this.handleEvent);
        this.handleEvent = undefined;
      }
      await this.device.close();
      this.device = undefined;
    }
    navigator.hid.removeEventListener("disconnect", this.handleDisconnect);
  }

  private handleEvent?: (ev: HIDInputReportEvent) => void;

  private async initListener(): Promise<void> {
    if (!this.device) return;
    const handleEvent = (ev: HIDInputReportEvent) => {
      if (this.listener) {
        const buffer = ev.data.buffer as ArrayBuffer;
        this.listener(buffer, ev);
      }
    };
    this.handleEvent = handleEvent;
    this.device.addEventListener("inputreport", handleEvent);
  }

  /**
   * Build wrapped message with client ID
   * Format: [0xDD][client_id:4][protocol][payload...]
   */
  private buildWrappedMessage(protocol: number, payload: number[]): Uint8Array {
    const message = new Uint8Array(this.reportLength);
    message[0] = WRAPPER_PREFIX;
    // Client ID (little-endian)
    message[1] = this.clientId & 0xff;
    message[2] = (this.clientId >> 8) & 0xff;
    message[3] = (this.clientId >> 16) & 0xff;
    message[4] = (this.clientId >> 24) & 0xff;
    // Protocol
    message[5] = protocol;
    // Payload
    for (let i = 0; i < payload.length && i < this.reportLength - WRAPPER_HEADER_BYTES; i++) {
      message[6 + i] = payload[i];
    }
    return message;
  }

  /**
   * Parse wrapped response, stripping wrapper header
   * Input: [0xDD][client_id:4][protocol][payload...]
   * Output: payload starting after protocol byte
   */
  private parseWrappedResponse(data: ArrayBuffer, options: USBSendOptions): Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[] {
    const u8 = new Uint8Array(data);

    // Verify wrapper prefix
    if (u8[0] !== WRAPPER_PREFIX) {
      throw new Error("Invalid response wrapper prefix");
    }

    // Verify client ID matches
    const responseClientId = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
    if (responseClientId !== this.clientId) {
      throw new Error("Response client ID mismatch");
    }

    // Extract payload (skip wrapper header + protocol byte = 6 bytes)
    const payloadBuffer = data.slice(6);
    return this.parseResponse(payloadBuffer, options);
  }

  // Overload signatures for send() - sends VIA commands via wrapper
  async send(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index: number }): Promise<number | bigint>;
  async send(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index?: undefined }): Promise<(number | bigint)[]>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index: number }): Promise<number>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index?: undefined }): Promise<Uint8Array>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index: number }): Promise<number>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index?: undefined }): Promise<Uint16Array>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index: number }): Promise<number>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index?: undefined }): Promise<Uint32Array>;
  async send(cmd: number, args: number[], options?: USBSendOptions): Promise<Uint8Array>;

  /**
   * Send VIA command via wrapper
   * Wraps: [0xDD][client_id:4][0xFE][via_cmd][args...]
   */
  async send(
    cmd: number,
    args: number[],
    options: USBSendOptions = {}
  ): Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]> {
    try {
      return await this.sendOnce(cmd, args, options);
    } catch (e) {
      if (e instanceof ClientIdRejectedError && e.code === CLIENT_ERR_INVALID_ID) {
        // The keyboard no longer knows our client ID. Take a fresh one and
        // retry the command once, transparently to the caller.
        console.warn("Keyboard rejected our client ID; re-bootstrapping and retrying");
        this.clientId = 0;
        this.clientIdExpiry = 0;
        return await this.sendOnce(cmd, args, options);
      }
      throw e;
    }
  }

  private async sendOnce(
    cmd: number,
    args: number[],
    options: USBSendOptions = {}
  ): Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]> {
    if (!this.device) throw new Error("USB device not connected");

    // Ensure we have a valid client ID
    await this.ensureClientId();

    // Build VIA command payload
    const payload = [cmd, ...args];
    const message = this.buildWrappedMessage(VIA_PREFIX, payload);

    // Queue the operations to prevent listener collision
    const operation = this.queue.then(async () => {
      return new Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          console.warn("USB Command Timed out waiting for valid response:", cmd);
          reject(new Error("USB Command Timeout"));
        }, 1000);

        this.listener = (data: ArrayBuffer) => {
          const u8 = new Uint8Array(data);

          // Validation: check wrapper prefix and client ID
          if (u8[0] !== WRAPPER_PREFIX) return;
          const respClientId = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
          if (respClientId !== this.clientId) return;
          // Error frame addressed to us: the keyboard refused the command.
          if (u8[5] === CLIENT_ERROR_PROTOCOL) {
            clearTimeout(timeoutId);
            reject(new ClientIdRejectedError(u8[6]));
            return;
          }

          // Additional validation if provided
          if (options.validateInput) {
            // Pass unwrapped data to validator
            const unwrapped = new Uint8Array(data.slice(6));
            if (!options.validateInput(unwrapped)) {
              return;
            }
          }

          clearTimeout(timeoutId);
          try {
            const result = this.parseWrappedResponse(data, options);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        };

        this.device!.sendReport(0, message as BufferSource).catch(err => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });
    });

    this.queue = operation.then(() => undefined).catch(() => undefined);
    return operation;
  }

  // Overload signatures for sendSvil()
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index: number }): Promise<number | bigint>;
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index?: undefined }): Promise<(number | bigint)[]>;
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index: number }): Promise<number>;
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index?: undefined }): Promise<Uint8Array>;
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index: number }): Promise<number>;
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index?: undefined }): Promise<Uint16Array>;
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index: number }): Promise<number>;
  async sendSvil(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index?: undefined }): Promise<Uint32Array>;
  async sendSvil(cmd: number, args: number[], options?: USBSendOptions): Promise<Uint8Array>;

  /**
   * Send Svil command via wrapper
   * Wraps: [0xDD][client_id:4][0xDF][svil_cmd][args...]
   */
  async sendSvil(
    cmd: number,
    args: number[],
    options: USBSendOptions = {}
  ): Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]> {
    if (!this.device) throw new Error("USB device not connected");

    // Ensure we have a valid client ID
    await this.ensureClientId();

    // Build Svil command payload
    const payload = [cmd, ...args];
    const message = this.buildWrappedMessage(SVIL_PREFIX, payload);

    // Queue the operations
    const operation = this.queue.then(async () => {
      return new Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          console.warn("Svil Command Timed out:", cmd);
          reject(new Error("USB Command Timeout"));
        }, 1000);

        this.listener = (data: ArrayBuffer) => {
          const u8 = new Uint8Array(data);

          // Validation: check wrapper prefix and client ID
          if (u8[0] !== WRAPPER_PREFIX) return;
          const respClientId = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
          if (respClientId !== this.clientId) return;

          // Check for error response (protocol byte = 0xFF)
          if (u8[5] === 0xFF) {
            clearTimeout(timeoutId);
            const errorCode = u8[6];
            reject(new Error(`Svil protocol error: code ${errorCode}`));
            return;
          }

          // Additional validation if provided
          if (options.validateInput) {
            const unwrapped = new Uint8Array(data.slice(6));
            if (!options.validateInput(unwrapped)) {
              return;
            }
          }

          clearTimeout(timeoutId);
          try {
            const result = this.parseWrappedResponse(data, options);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        };

        this.device!.sendReport(0, message as BufferSource).catch(err => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });
    });

    this.queue = operation.then(() => undefined).catch(() => undefined);
    return operation;
  }

  // Overload signatures for type safety
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { unpack: string; index: number }): number | bigint;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { unpack: string; index?: undefined }): (number | bigint)[];
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint8: true; index: number }): number;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint8: true; index?: undefined }): Uint8Array;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint16: true; index: number }): number;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint16: true; index?: undefined }): Uint16Array;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint32: true; index: number }): number;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint32: true; index?: undefined }): Uint32Array;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions): Uint8Array;

  private parseResponse(data: ArrayBuffer, options: USBSendOptions): Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[] {
    const skipBytes = options.skipBytes || 0;
    const dv = new DataView(data);
    const u8 = new Uint8Array(data);

    if (options.unpack) {
      // For unpack, create a new DataView starting at skipBytes offset
      const offsetDv = skipBytes > 0 ? new DataView(data, skipBytes) : dv;
      const unpacked = this.unpackData(offsetDv, options.unpack);
      if (options.index !== undefined) {
        return unpacked[options.index];
      }
      return unpacked;
    }

    if (options.uint8) {
      if (options.index !== undefined) {
        return u8[skipBytes + options.index];
      }
      return skipBytes > 0 ? u8.slice(skipBytes) : u8;
    }

    if (options.uint16) {
      const littleEndian = !options.bigendian;
      if (options.index !== undefined) {
        // index is a byte offset, not an element index
        return dv.getUint16(skipBytes + options.index, littleEndian);
      }
      // Read uint16 values using DataView to handle odd byte offsets
      const numValues = Math.floor((data.byteLength - skipBytes) / 2);
      const values: number[] = [];
      for (let i = 0; i < numValues; i++) {
        values.push(dv.getUint16(skipBytes + i * 2, littleEndian));
      }
      let u16Array = new Uint16Array(values);
      if (options.slice !== undefined) {
        u16Array = u16Array.slice(options.slice);
      }
      return u16Array;
    }

    if (options.uint32) {
      const littleEndian = !options.bigendian;
      if (options.index !== undefined) {
        // index is a byte offset, not an element index
        return dv.getUint32(skipBytes + options.index, littleEndian);
      }
      // Read uint32 values using DataView to handle odd byte offsets
      const numValues = Math.floor((data.byteLength - skipBytes) / 4);
      const values: number[] = [];
      for (let i = 0; i < numValues; i++) {
        values.push(dv.getUint32(skipBytes + i * 4, littleEndian));
      }
      return new Uint32Array(values);
    }

    return skipBytes > 0 ? u8.slice(skipBytes) : u8;
  }

  private unpackData(dv: DataView, format: string): (number | bigint)[] {
    const results: (number | bigint)[] = [];
    let offset = 0;
    let littleEndian = true;

    if (format.includes("<")) littleEndian = true;
    if (format.includes(">")) littleEndian = false;

    const formatChars = format.replace(/[<>]/g, "");

    for (const char of formatChars) {
      switch (char) {
        case "B":
          results.push(dv.getUint8(offset));
          offset += 1;
          break;
        case "H":
          results.push(dv.getUint16(offset, littleEndian));
          offset += 2;
          break;
        case "I":
          results.push(dv.getUint32(offset, littleEndian));
          offset += 4;
          break;
        case "Q":
          results.push(dv.getBigUint64(offset, littleEndian));
          offset += 8;
          break;
      }
    }

    return results;
  }

  async getViaBuffer(
    cmd: number,
    size: number,
    options: USBSendOptions = {},
    checkComplete?: (data: number[] | Uint8Array) => boolean
  ): Promise<number[] | Uint8Array> {
    // The firmware's reply to a wrapped VIA command loses its last 6 bytes to the
    // wrapper, so a chunk is the report length minus wrapper and VIA header
    // (22 bytes at 32, 54 at 64).
    const chunksize = payloadCapacity(this, VIA_BUFFER_HEADER_BYTES);
    const bytes = options.bytes || 1;
    const alldata: number[] = [];
    let offset = 0;

    while (offset < size) {
      let sz = chunksize;
      if (sz > size - offset) {
        sz = size - offset;
      }

      const args = [...BE16(offset), sz];
      const data = await this.send(cmd, args, options) as Uint8Array;

      if (sz < chunksize) {
        const sliceSize = Math.floor(sz / bytes);
        alldata.push(...Array.from(data).slice(0, sliceSize));
      } else {
        if (Array.isArray(data)) {
          alldata.push(...data);
        } else {
          alldata.push(...Array.from(data));
        }
      }

      if (checkComplete && checkComplete(alldata)) {
        break;
      }

      offset += chunksize;
    }

    if (options.uint16) {
      return alldata;
    }

    return new Uint8Array(alldata);
  }

  /**
   * Get keyboard definition via Svil protocol
   * Uses CMD_SVIL_DEFINITION_SIZE and CMD_SVIL_DEFINITION_CHUNK
   */
  async getSvilDefinition(): Promise<Uint8Array> {
    // Get definition size
    // Response format after wrapper stripped: [cmd_echo][size0][size1][size2][size3]
    const sizeResp = await this.sendSvil(
      SvilUSB.CMD_SVIL_DEFINITION_SIZE,
      [],
      { uint32: true, index: 1 } // Skip cmd_echo
    );
    const size = sizeResp as number;

    // Fetch definition in chunks, as large as the report allows. The firmware may
    // clamp a chunk below what was asked (it caps them at 22 bytes today), so a
    // short chunk is not the end; only the definition size or an empty chunk is.
    const chunkSize = payloadCapacity(this, SVIL_DEFINITION_HEADER_BYTES);
    const alldata: number[] = [];
    let offset = 0;

    while (offset < size) {
      const requestSize = Math.min(chunkSize, size - offset);
      const resp = await this.sendSvil(
        SvilUSB.CMD_SVIL_DEFINITION_CHUNK,
        [...LE16(offset), requestSize],
        { uint8: true }
      );

      const data = resp as Uint8Array;
      // Response format after wrapper stripped: [cmd_echo][offset_lo][offset_hi][actual_size][data...]
      const actualSize = Math.min(data[3], requestSize); // Skip cmd_echo
      for (let i = 0; i < actualSize; i++) {
        alldata.push(data[4 + i]); // Skip cmd_echo + header
      }

      offset += actualSize;
      if (actualSize === 0) break; // End of data
    }

    return new Uint8Array(alldata);
  }

  async pushViaBuffer(
    cmd: number,
    size: number,
    data: ArrayBuffer
  ): Promise<void> {
    const buffer = new Uint8Array(data);
    let offset = 0;
    let chunkOffset = 0;
    // Same chunk size as getViaBuffer
    const chunkSize = payloadCapacity(this, VIA_BUFFER_HEADER_BYTES);

    while (offset < size) {
      const chunk = new Uint8Array(chunkSize);
      for (let i = 0; i < chunk.length && offset < size; i++) {
        chunk[i] = buffer[offset++];
      }

      await this.send(cmd, [...LE16(chunkOffset), ...chunk], {});
      chunkOffset += chunk.length;
    }
  }

  // Overload signatures for getSvilEntries()
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { unpack: string; index: number }): Promise<(number | bigint)[]>;
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { unpack: string; index?: undefined }): Promise<(number | bigint)[][]>;
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { uint8: true; index: number }): Promise<number[]>;
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { uint8: true; index?: undefined }): Promise<Uint8Array[]>;
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { uint16: true; index: number }): Promise<number[]>;
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { uint16: true; index?: undefined }): Promise<Uint16Array[]>;
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { uint32: true; index: number }): Promise<number[]>;
  async getSvilEntries(getCmd: number, count: number, options: USBSendOptions & { uint32: true; index?: undefined }): Promise<Uint32Array[]>;
  async getSvilEntries(getCmd: number, count: number, options?: USBSendOptions): Promise<Uint8Array[]>;

  /**
   * Get multiple entries using Svil protocol
   */
  async getSvilEntries(
    getCmd: number,
    count: number,
    options: USBSendOptions = {}
  ): Promise<(Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[])[]> {
    const entries: (Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[])[] = [];
    for (let i = 0; i < count; i++) {
      const data = await this.sendSvil(getCmd, svilIndexArgs(this.svilProtocolVersion, i), options);
      entries.push(data);
    }
    return entries;
  }

  // VIA Custom Value Protocol (0x07/0x08/0x09)
  // Channels: 0 = keyboard-specific, 1 = QMK backlight, 2 = QMK rgblight

  /**
   * Get a custom value from the keyboard using VIA custom value protocol.
   * Packet: [0x08][channel][value_id]
   * Response: [0x08][channel][value_id][data...]
   */
  async customValueGet(channel: number, valueId: number, size: number = 2): Promise<Uint8Array> {
    const resp = await this.send(
      SvilUSB.CMD_VIA_LIGHTING_GET_VALUE,
      [channel, valueId],
      {
        uint8: true,
        skipBytes: 3, // Skip cmd_echo, channel, value_id
        // Only resolve on the report that echoes THIS request. Without this,
        // the listener accepts any wrapper/clientId-matched report, so a stray or
        // duplicated report (common on the first connect after a reboot, when the
        // WebHID buffer holds a leftover reply) can be consumed by the wrong
        // customValueGet in the sequential read loop, shifting every subsequent
        // read by one slot and showing a neighboring value's data (e.g. right-hand
        // DPI reading as 1200 when the device holds 400).
        validateInput: (u) =>
          u[0] === SvilUSB.CMD_VIA_LIGHTING_GET_VALUE &&
          u[1] === channel &&
          u[2] === valueId,
      }
    );
    return (resp as Uint8Array).slice(0, size);
  }

  /**
   * Set a custom value on the keyboard using VIA custom value protocol.
   * Packet: [0x07][channel][value_id][data...]
   */
  async customValueSet(channel: number, valueId: number, data: number[]): Promise<void> {
    console.log(`customValueSet: channel=${channel}, valueId=${valueId}, data=[${data.join(', ')}]`);
    await this.send(
      SvilUSB.CMD_VIA_LIGHTING_SET_VALUE,
      [channel, valueId, ...data],
      {}
    );
  }

  /**
   * Save custom values to EEPROM using VIA custom value protocol.
   * Packet: [0x09][channel]
   */
  async customValueSave(channel: number): Promise<void> {
    await this.send(
      SvilUSB.CMD_VIA_LIGHTING_SAVE,
      [channel],
      {}
    );
  }

  // Layer Color convenience methods (channel 0, value_ids 32-47)
  // Color format: 2 bytes [hue, sat] (0-255 range, QMK HSV)

  static readonly LAYER_COLOR_VALUE_ID_BASE = 32;
  static readonly LAYER_COLOR_CHANNEL = 0;

  /**
   * Get layer color from keyboard.
   * Returns HSV (hue, sat) - value/brightness controlled separately.
   */
  async getLayerColor(layer: number): Promise<{ hue: number; sat: number }> {
    const valueId = SvilUSB.LAYER_COLOR_VALUE_ID_BASE + layer;
    const data = await this.customValueGet(SvilUSB.LAYER_COLOR_CHANNEL, valueId, 2);
    return { hue: data[0], sat: data[1] };
  }

  /**
   * Set layer color on keyboard.
   * Takes HSV values (0-255 range).
   */
  async setLayerColor(layer: number, hue: number, sat: number, save = true): Promise<void> {
    const valueId = SvilUSB.LAYER_COLOR_VALUE_ID_BASE + layer;
    console.log(`setLayerColor: layer=${layer}, valueId=${valueId}, hue=${hue}, sat=${sat}`);
    await this.customValueSet(SvilUSB.LAYER_COLOR_CHANNEL, valueId, [hue, sat]);
    if (save) await this.customValueSave(SvilUSB.LAYER_COLOR_CHANNEL);
  }

  // LED brightness: QMK's own rgblight brightness on VIA's lighting channel, the
  // value RGB_VAI/RGB_VAD change. It applies to every layer. 0-255; the firmware
  // scales it to RGBLIGHT_LIMIT_VAL.

  static readonly RGBLIGHT_CHANNEL = 2;
  static readonly RGBLIGHT_BRIGHTNESS_ID = 1;

  async getLedBrightness(): Promise<number> {
    const data = await this.customValueGet(SvilUSB.RGBLIGHT_CHANNEL, SvilUSB.RGBLIGHT_BRIGHTNESS_ID, 1);
    return data[0];
  }

  /** With save false the board shows the brightness but keeps the stored one, for live previews. */
  async setLedBrightness(val: number, save = true): Promise<void> {
    await this.customValueSet(SvilUSB.RGBLIGHT_CHANNEL, SvilUSB.RGBLIGHT_BRIGHTNESS_ID, [val]);
    if (save) await this.customValueSave(SvilUSB.RGBLIGHT_CHANNEL);
  }

  /**
   * Get all layer colors (for initial sync).
   * Returns array of 16 HSV values.
   */
  async getAllLayerColors(): Promise<Array<{ hue: number; sat: number }>> {
    const colors: Array<{ hue: number; sat: number }> = [];
    for (let i = 0; i < 16; i++) {
      try {
        const color = await this.getLayerColor(i);
        colors.push(color);
      } catch {
        colors.push({ hue: 0, sat: 0 });
      }
    }
    return colors;
  }
}

// Export singleton instance
export const usbInstance = new SvilUSB();

/** A Sval table: its TABLE_SCAN id, per-index GET command and entry size in bytes. */
export interface SvilTable {
  scanId: number;
  getCmd: number;
  entrySize: number;
}

export const SVIL_TABLE_TAP_DANCE: SvilTable = { scanId: 0, getCmd: SvilUSB.CMD_SVIL_TAP_DANCE_GET, entrySize: 10 };
export const SVIL_TABLE_COMBO: SvilTable = { scanId: 1, getCmd: SvilUSB.CMD_SVIL_COMBO_GET, entrySize: 12 };
export const SVIL_TABLE_KEY_OVERRIDE: SvilTable = { scanId: 2, getCmd: SvilUSB.CMD_SVIL_KEY_OVERRIDE_GET, entrySize: 12 };
export const SVIL_TABLE_ALT_REPEAT_KEY: SvilTable = { scanId: 3, getCmd: SvilUSB.CMD_SVIL_ALT_REPEAT_KEY_GET, entrySize: 6 };
export const SVIL_TABLE_LEADER: SvilTable = { scanId: 4, getCmd: SvilUSB.CMD_SVIL_LEADER_GET, entrySize: 14 };

/**
 * Read a whole Sval table as raw entries, one entrySize-byte array per index.
 *
 * v3+: TABLE_SCAN returns the next entry in use at or after a start index.
 *   Request:  [table][start lo][start hi]
 *   Response: [cmd_echo][table][found][index lo][index hi][entry...]
 *   Scan from index + 1 until found = 0. Entries never returned are unused and
 *   read as all zero (even if, say, a tap dance kept a nonzero term).
 * Older firmware: one GET per index (see svilIndexArgs / svilEntryOffset).
 */
export async function readSvilTable(usb: SvilUSB, table: SvilTable, count: number): Promise<Uint8Array[]> {
  const proto = usb.svilProtocolVersion;
  const entries: Uint8Array[] = [];
  for (let i = 0; i < count; i++) entries.push(new Uint8Array(table.entrySize));

  if (svilHasTableScan(proto)) {
    let start = 0;
    while (start < count) {
      const data = await usb.sendSvil(
        SvilUSB.CMD_SVIL_TABLE_SCAN,
        [table.scanId, ...LE16(start)],
        { uint8: true }
      ) as Uint8Array;

      if (!data[2]) break; // found = 0: nothing else in use
      const index = data[3] | (data[4] << 8);
      if (index < start || index >= count) break; // Never loop on a keyboard that answers backwards
      entries[index].set(data.subarray(5, 5 + table.entrySize));
      start = index + 1;
    }
    return entries;
  }

  const o = svilEntryOffset(proto);
  for (let i = 0; i < count; i++) {
    const data = await usb.sendSvil(table.getCmd, svilIndexArgs(proto, i), { uint8: true }) as Uint8Array;
    entries[i].set(data.subarray(o, o + table.entrySize));
  }
  return entries;
}
