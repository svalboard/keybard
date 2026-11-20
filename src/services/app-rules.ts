// App rules: layer changes while a given app is in front on the computer.
//
// The board keeps up to 64 rules; Keybard Host tells it which app is in front, and the
// first rule with that app's ID applies: a default layer, a front layer (just above the
// default layer), and on/off masks over the user's layers (off wins). Nothing a rule does
// is saved; leaving the app restores everything.
//
// Discovery: GET_INFO byte 22 (the fifth feature byte), bit 0. Older firmware leaves it
// clear and answers 0x40 and 0x41 with the command byte 0xFF: Keybard then shows nothing.
// The wire format is in svalboard/qmk keyboards/svalboard/docs/protocol.md, "App rules".
import type { AppRule } from "@/types/keyboard.types";

/** GET_INFO byte 22 (feature_flags5) bit 0. */
export const SVIL_FLAG5_APP_RULES = 0x01;
export const hasAppRules = (flags5: number | undefined | null): boolean => ((flags5 ?? 0) & SVIL_FLAG5_APP_RULES) !== 0;

export const CMD_SVIL_APP_FOREGROUND = 0x40;
export const CMD_SVIL_APP_RULES = 0x41;

export const APP_RULES_INFO = 0;
export const APP_RULES_READ = 1;
export const APP_RULES_WRITE = 2;
export const APP_RULES_BEGIN = 3;
export const APP_RULES_COMMIT = 4;
export const APP_FOREGROUND_STATUS = 0;

export const APP_RULES_FORMAT = 2;
export const APP_RULES_MAX = 64;
/** A rule's fixed fields, before its text. */
export const APP_RULE_HEAD_BYTES = 12;
export const APP_RULES_HEADER_BYTES = 4;
/** The whole record: header, rules and their text share it. */
export const APP_RULES_RECORD_BYTES = 1792;
export const APP_RULES_CHUNK = 48;
/** At most this many UTF-8 bytes of a rule's text (its app key, or its site). */
export const APP_RULE_TEXT_MAX = 64;
/** Header byte 2: App Layers is off (no rule applies; the rules stay stored). */
export const APP_RULES_OFF = 0x01;
/** A rule's flags: the rule is off (matching skips it). Clear means on, so new rules are on. */
export const APP_RULE_OFF = 0x01;
/** A rule's flags: a website rule; its text is the bare site. */
export const APP_RULE_SITE = 0x02;
/** APP_FOREGROUND flags: App Layers is off. */
export const APP_FG_LAYERS_OFF = 0x08;
/** "None" for the default and front layers. */
export const APP_LAYER_NONE = 0xff;
/** The masks hold 16 layers. */
export const APP_MASK_LAYERS = 16;
/** The auto mouse layer belongs to Auto Mouse: the board ignores its mask bits, and Keybard never sets them. */
export const APP_MOUSE_LAYER = 15;
/** The mask bits a rule may use: every layer but the auto mouse layer. */
export const APP_MASK_USABLE = 0xffff & ~(1 << APP_MOUSE_LAYER);

/** Framing around a READ reply's data, counted from the start of the report: [wrapper:6][0x41][op][status][offset:2][len]. */
const READ_REPLY_HEADER_BYTES = 12;

export const APP_STATUS_OK = 0;
export const APP_STATUS_BAD = 1;
export const APP_STATUS_NOT_USB = 2;
export const APP_STATUS_SHORT = 3;
export const APP_STATUS_INVALID = 4;
export const APP_STATUS_NOT_SAVED = 5;

const STATUS_TEXT: Record<number, string> = {
    [APP_STATUS_BAD]: "the board refused the request",
    [APP_STATUS_NOT_USB]: "this half isn't the one with USB",
    [APP_STATUS_SHORT]: "the report was too short",
    [APP_STATUS_INVALID]: "the board found the rules invalid and kept its old ones",
    [APP_STATUS_NOT_SAVED]: "the board uses the new rules but couldn't save them; they are lost when it restarts",
};

/** The board answered an app rules request with a nonzero status. */
export class AppRulesError extends Error {
    constructor(public readonly op: number, public readonly status: number) {
        super(`App rules: ${STATUS_TEXT[status] ?? `status ${status}`}`);
        this.name = "AppRulesError";
    }
}

/** What carries the requests: SvilUSB, or a test double. */
export interface AppRulesLink {
    reportLength?: number;
    sendSvil(cmd: number, args: number[], options: { uint8: true }): Promise<Uint8Array>;
}

// ---- app IDs ------------------------------------------------------------------

/** The key as the board hashes it: spaces and tabs dropped at both ends, ASCII A-Z lowered. */
export function canonicalAppKey(key: string): string {
    return key.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The 4-byte app ID the board stores for an app key: FNV-1a 32 over the canonical key's
 * UTF-8 bytes. A result of 0 is sent as 1; an empty key is 0, "no app".
 */
export function appId(key: string): number {
    const k = canonicalAppKey(key);
    if (!k) return 0;
    let h = 0x811c9dc5;
    for (const b of new TextEncoder().encode(k)) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h === 0 ? 1 : h >>> 0;
}

export const appIdHex = (id: number): string => (id >>> 0).toString(16).toUpperCase().padStart(8, "0");

// ---- website rules ----------------------------------------------------------------
//
// A rule for a website rather than a program: its app key is `site:<site>` (`site:onshape.com`),
// hashed like any other. The board stores the whole site as the rule's text, with the website
// flag, so Keybard Host knows the board has website rules. It matches the browser's address by hashing
// the host name and each name above it against the rules' IDs (only on Windows for now).
// A site matches its host name and every host under it. Keybard Host normalizes and matches
// the same way (companion/overlay-host/keybard_host/site_rules.py): keep the two in step.

export const SITE_PREFIX = "site:";

/** Whether an app key names a website (`site:...`). */
export const isSiteKey = (key: string | undefined | null): boolean =>
    !!key && canonicalAppKey(key).startsWith(SITE_PREFIX);

/**
 * A site as typed ("https://www.Onshape.com/documents", "*.onshape.com:443") as the bare name it
 * matches ("onshape.com"): no scheme, user, port, path, `www.`, `*.` or trailing dot; ASCII
 * lowercased (an IDN stays as typed, punycode or not). "" when nothing is left.
 */
export function normalizeSite(text: string): string {
    let t = text.replace(/^[ \t]+|[ \t]+$/g, "");
    if (t.slice(0, SITE_PREFIX.length).toLowerCase() === SITE_PREFIX) t = t.slice(SITE_PREFIX.length).replace(/^[ \t]+/, "");
    t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    t = t.split(/[/?#\\]/, 1)[0];
    t = t.slice(t.lastIndexOf("@") + 1);
    t = t.replace(/:\d*$/, "");
    t = canonicalAppKey(t);
    while (t.startsWith("*.")) t = t.slice(2);
    t = t.replace(/^\.+|\.+$/g, "").replace(/^\*+/, "");
    if (t.startsWith("www.") && t.split(".").length > 2) t = t.slice(4);
    return t.replace(/^\.+|\.+$/g, "");
}

/** The app key of a website rule: `site:onshape.com`, "" for no site. */
export const siteKey = (site: string): string => {
    const s = normalizeSite(site);
    return s ? SITE_PREFIX + s : "";
};

/** Why a site can't be a rule's, or null when it can (or is still empty). */
export function siteProblem(site: string): string | null {
    const s = normalizeSite(site);
    if (!s) return null;
    if (/[\s,;]/.test(s)) return "A site is one name, without spaces.";
    return null;
}

/** Which addresses a website rule matches, in one short line, or null for no site yet. */
export function siteMatches(site: string): string | null {
    const s = normalizeSite(site);
    if (!s || siteProblem(site)) return null;
    return `Matches ${s} and every address under it.`;
}

/** The site a rule read from the board is for, or null: its ID must be the hash of `site:` + its text. */
export function siteOfRule(rule: Pick<AppRule, "appId" | "text">): string | null {
    const s = normalizeSite(rule.text ?? "");
    return s && rule.appId >>> 0 === appId(SITE_PREFIX + s) ? s : null;
}

/** A website rule as the editor sets it from what was typed: the text is the site, and a site that doesn't fit has no ID yet. */
export function withSite<T extends AppRule>(rule: T, typed: string): T {
    const s = normalizeSite(typed);
    const ok = !!s && siteProblem(typed) === null;
    return { ...rule, key: SITE_PREFIX + typed, appId: ok ? appId(SITE_PREFIX + s) : 0, text: s, flags: rule.flags | APP_RULE_SITE };
}

/** A program rule as the editor sets it from what was typed: the text is the key, trimmed. */
export function withApp<T extends AppRule>(rule: T, typed: string): T {
    return { ...rule, key: typed, appId: appId(typed), text: typed.replace(/^[ \t]+|[ \t]+$/g, ""), flags: rule.flags & ~APP_RULE_SITE };
}

/** Whether a rule is on (its off flag clear). */
export const ruleOn = (rule: Pick<AppRule, "flags">): boolean => (rule.flags & APP_RULE_OFF) === 0;
export const withRuleOn = <T extends AppRule>(rule: T, on: boolean): T => ({ ...rule, flags: on ? rule.flags & ~APP_RULE_OFF : rule.flags | APP_RULE_OFF });

/** Text cut to at most `max` UTF-8 bytes, never inside a character. */
export function truncateUtf8(text: string, max = APP_RULE_TEXT_MAX): string {
    const enc = new TextEncoder();
    if (enc.encode(text).length <= max) return text;
    let out = "";
    let used = 0;
    for (const ch of text) {
        const n = enc.encode(ch).length;
        if (used + n > max) break;
        out += ch;
        used += n;
    }
    return out;
}

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

// ---- the record ----------------------------------------------------------------

const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const layerOrNull = (v: number): number | null => (v === APP_LAYER_NONE ? null : v);

/** What a record holds: the rules, and whether App Layers is on. */
export interface AppRulesRecord {
    rules: AppRule[];
    enabled: boolean;
}

/** Bytes a rule takes in the record: its fixed fields and its text. */
export const ruleBytes = (rule: Pick<AppRule, "text">): number => APP_RULE_HEAD_BYTES + Math.min(utf8Length(rule.text ?? ""), APP_RULE_TEXT_MAX);
/** Bytes the header and the rules take; the board holds APP_RULES_RECORD_BYTES. */
export const recordUsed = (rules: readonly Pick<AppRule, "text">[]): number =>
    APP_RULES_HEADER_BYTES + rules.reduce((n, r) => n + ruleBytes(r), 0);

/**
 * The record (format 2): [2][count][flags][0], then each rule packed: app ID u32, default layer,
 * front layer, on mask u16, off mask u16, flags, text length, text. A record never stored (all
 * zeros) has no rules and App Layers on.
 */
export function parseRecord(bytes: Uint8Array): AppRulesRecord {
    if (bytes.length < APP_RULES_HEADER_BYTES) throw new Error("App rules: the record is too short");
    const format = bytes[0];
    const count = bytes[1];
    if (format === 0 && count === 0) return { rules: [], enabled: true };
    if (format === 1) return { rules: parseRecordV1(bytes), enabled: true };
    if (format !== APP_RULES_FORMAT) throw new Error(`App rules: unknown record format ${format}`);
    if (count > APP_RULES_MAX) throw new Error(`App rules: ${count} rules is more than ${APP_RULES_MAX}`);
    const rules: AppRule[] = [];
    let o = APP_RULES_HEADER_BYTES;
    for (let i = 0; i < count; i++) {
        if (o + APP_RULE_HEAD_BYTES > bytes.length) throw new Error("App rules: the record is shorter than its rules");
        const n = bytes[o + 11];
        if (n > APP_RULE_TEXT_MAX || o + APP_RULE_HEAD_BYTES + n > bytes.length) throw new Error("App rules: the record is shorter than its rules");
        rules.push({
            appId: le32(bytes, o),
            defaultLayer: layerOrNull(bytes[o + 4]),
            frontLayer: layerOrNull(bytes[o + 5]),
            onMask: le16(bytes, o + 6) & APP_MASK_USABLE,
            offMask: le16(bytes, o + 8) & APP_MASK_USABLE,
            flags: bytes[o + 10],
            text: new TextDecoder().decode(bytes.subarray(o + APP_RULE_HEAD_BYTES, o + APP_RULE_HEAD_BYTES + n)),
        });
        o += APP_RULE_HEAD_BYTES + n;
    }
    return { rules, enabled: (bytes[2] & APP_RULES_OFF) === 0 };
}

/** Format 1 (the first app rules firmware): 24-byte rules, each with a 13-byte label. */
export const APP_RULE_V1_BYTES = 24;
const V1_LABEL_BYTES = 13;

/**
 * The rules of a format 1 record, as format 2 rules: the label becomes the text, and a label that
 * names a site (its ID is the site's, or it is a long site's end, "…lboard.com") marks a website
 * rule. Each keeps its ID, so a site cut short still matches. App Layers was always on.
 */
export function parseRecordV1(bytes: Uint8Array): AppRule[] {
    const count = bytes[1];
    if (count > APP_RULES_MAX) throw new Error(`App rules: ${count} rules is more than ${APP_RULES_MAX}`);
    if (bytes.length < APP_RULES_HEADER_BYTES + count * APP_RULE_V1_BYTES) throw new Error("App rules: the record is shorter than its count");
    return Array.from({ length: count }, (_, i) => {
        const o = APP_RULES_HEADER_BYTES + i * APP_RULE_V1_BYTES;
        const raw = bytes.subarray(o + 11, o + 11 + V1_LABEL_BYTES);
        const end = raw.indexOf(0);
        const label = new TextDecoder().decode(end < 0 ? raw : raw.subarray(0, end));
        const id = le32(bytes, o);
        const site = normalizeSite(label);
        const isSite = !!label && ((!!site && appId(SITE_PREFIX + site) === id) || label.startsWith("…"));
        return {
            appId: id,
            defaultLayer: layerOrNull(bytes[o + 4]),
            frontLayer: layerOrNull(bytes[o + 5]),
            onMask: le16(bytes, o + 6) & APP_MASK_USABLE,
            offMask: le16(bytes, o + 8) & APP_MASK_USABLE,
            flags: (bytes[o + 10] & APP_RULE_OFF) | (isSite ? APP_RULE_SITE : 0),
            text: isSite && !label.startsWith("…") ? site : label,
        };
    });
}

function putLayer(v: number | null | undefined): number {
    return v === null || v === undefined || !Number.isInteger(v) || v < 0 || v >= APP_LAYER_NONE ? APP_LAYER_NONE : v;
}

/** The header and the rules, packed. Throws when they don't fit the board's record. */
export function serializeRecord(rules: readonly AppRule[], enabled = true): Uint8Array {
    if (rules.length > APP_RULES_MAX) throw new Error(`App rules: at most ${APP_RULES_MAX} rules`);
    const texts = rules.map((r) => new TextEncoder().encode(truncateUtf8(r.text ?? "")));
    const total = APP_RULES_HEADER_BYTES + texts.reduce((n, t) => n + APP_RULE_HEAD_BYTES + t.length, 0);
    if (total > APP_RULES_RECORD_BYTES) throw new Error(`App rules: ${total} bytes is more than the board's ${APP_RULES_RECORD_BYTES}`);
    const out = new Uint8Array(total);
    out[0] = APP_RULES_FORMAT;
    out[1] = rules.length;
    out[2] = enabled ? 0 : APP_RULES_OFF;
    let o = APP_RULES_HEADER_BYTES;
    rules.forEach((r, i) => {
        const id = r.appId >>> 0;
        out[o] = id & 0xff; out[o + 1] = (id >>> 8) & 0xff; out[o + 2] = (id >>> 16) & 0xff; out[o + 3] = id >>> 24;
        out[o + 4] = putLayer(r.defaultLayer);
        out[o + 5] = putLayer(r.frontLayer);
        const on = r.onMask & APP_MASK_USABLE, off = r.offMask & APP_MASK_USABLE;
        out[o + 6] = on & 0xff; out[o + 7] = on >> 8;
        out[o + 8] = off & 0xff; out[o + 9] = off >> 8;
        out[o + 10] = r.flags & (APP_RULE_OFF | APP_RULE_SITE);
        out[o + 11] = texts[i].length;
        out.set(texts[i], o + APP_RULE_HEAD_BYTES);
        o += APP_RULE_HEAD_BYTES + texts[i].length;
    });
    return out;
}

/** What the board stores of a rule (Keybard's own `key` left out), for comparing. */
export const ruleWire = (r: AppRule) => [r.appId >>> 0, putLayer(r.defaultLayer), putLayer(r.frontLayer), r.onMask & APP_MASK_USABLE, r.offMask & APP_MASK_USABLE, r.flags & (APP_RULE_OFF | APP_RULE_SITE), truncateUtf8(r.text ?? "")];
export const sameRules = (a: readonly AppRule[] | undefined, b: readonly AppRule[] | undefined): boolean =>
    JSON.stringify((a ?? []).map(ruleWire)) === JSON.stringify((b ?? []).map(ruleWire));

// ---- per-layer state of a rule's masks ------------------------------------------

export type MaskState = "neutral" | "on" | "off";

export function maskState(rule: Pick<AppRule, "onMask" | "offMask">, layer: number): MaskState {
    if ((rule.offMask >> layer) & 1) return "off";
    if ((rule.onMask >> layer) & 1) return "on";
    return "neutral";
}

/** The next state on a click: neutral, on, off (struck through), neutral. */
export function cycleMask<T extends Pick<AppRule, "onMask" | "offMask">>(rule: T, layer: number): T {
    if (layer < 0 || layer >= APP_MASK_LAYERS || layer === APP_MOUSE_LAYER) return rule;
    const bit = 1 << layer;
    const state = maskState(rule, layer);
    if (state === "neutral") return { ...rule, onMask: (rule.onMask | bit) & 0xffff, offMask: rule.offMask & ~bit & 0xffff };
    if (state === "on") return { ...rule, onMask: rule.onMask & ~bit & 0xffff, offMask: (rule.offMask | bit) & 0xffff };
    return { ...rule, onMask: rule.onMask & ~bit & 0xffff, offMask: rule.offMask & ~bit & 0xffff };
}

// ---- the requests ----------------------------------------------------------------

export interface AppRulesInfo {
    format: number;
    max: number;
    /** A rule's fixed bytes (12). */
    ruleHeadBytes: number;
    count: number;
    recordBytes: number;
    chunk: number;
    layers: number;
    /** Bytes the header and rules use now. */
    used: number;
    textMax: number;
    /** Header byte 2: bit 0 App Layers off. */
    headerFlags: number;
}

/** The reply's status, after checking it answers this request. Throws on 0xFF (no such command) or a nonzero status. */
function checked(cmd: number, op: number, resp: Uint8Array): Uint8Array {
    if (resp[0] !== cmd) throw new Error(`App rules: the board doesn't know command 0x${cmd.toString(16)}`);
    if (resp[1] !== op) throw new Error(`App rules: reply to op ${resp[1]}, expected ${op}`);
    if (resp[2] !== APP_STATUS_OK) throw new AppRulesError(op, resp[2]);
    return resp;
}

/** Data bytes per READ or WRITE: 48, or what a smaller report holds. */
export function chunkSize(link: { reportLength?: number }, boardChunk = APP_RULES_CHUNK): number {
    return Math.max(1, Math.min(boardChunk || APP_RULES_CHUNK, APP_RULES_CHUNK, (link.reportLength || 32) - READ_REPLY_HEADER_BYTES));
}

export async function readAppRulesInfo(link: AppRulesLink): Promise<AppRulesInfo> {
    const r = checked(CMD_SVIL_APP_RULES, APP_RULES_INFO, await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_INFO], { uint8: true }));
    return { format: r[3], max: r[4], ruleHeadBytes: r[5], count: r[6], recordBytes: le16(r, 7), chunk: r[9], layers: r[10], used: le16(r, 11), textMax: r[13], headerFlags: r[14] ?? 0 };
}

/** The rules in use: INFO, then READ of the header and the rules (the bytes used), a chunk at a time. */
export async function readAppRules(link: AppRulesLink): Promise<AppRulesRecord & { info: AppRulesInfo }> {
    const info = await readAppRulesInfo(link);
    // Format 1 boards: read their rules (so a layout backup keeps them across a firmware update).
    const v1 = info.format === 1 && info.ruleHeadBytes === APP_RULE_V1_BYTES;
    if (!v1 && (info.format !== APP_RULES_FORMAT || info.ruleHeadBytes !== APP_RULE_HEAD_BYTES)) {
        throw new Error(`App rules: unknown record format ${info.format} (${info.ruleHeadBytes}-byte rules)`);
    }
    const chunk = chunkSize(link, info.chunk);
    const total = v1
        ? Math.min(info.recordBytes || 1540, APP_RULES_HEADER_BYTES + Math.min(info.count, APP_RULES_MAX) * APP_RULE_V1_BYTES)
        : Math.min(info.recordBytes || APP_RULES_RECORD_BYTES, Math.max(APP_RULES_HEADER_BYTES, info.used));
    const bytes = new Uint8Array(total);
    for (let off = 0; off < total; off += chunk) {
        const len = Math.min(chunk, total - off);
        const r = checked(CMD_SVIL_APP_RULES, APP_RULES_READ,
            await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_READ, off & 0xff, off >> 8, len], { uint8: true }));
        if (le16(r, 3) !== off || r[5] !== len) throw new Error(`App rules: READ answered offset ${le16(r, 3)} length ${r[5]}, asked ${off} ${len}`);
        bytes.set(r.subarray(6, 6 + len), off);
    }
    return { ...(v1 ? { rules: parseRecordV1(bytes), enabled: true } : parseRecord(bytes)), info };
}

/** Thrown when writing to a board with the first record format. */
export const OLD_FORMAT_TEXT = "Update the firmware to edit App Layers";

/** Save the rules and the App Layers switch: BEGIN, WRITE the header and the rules, COMMIT. Resolves to the board's count. */
export async function writeAppRules(link: AppRulesLink, rules: readonly AppRule[], enabled = true, boardChunk = APP_RULES_CHUNK): Promise<number> {
    const bytes = serializeRecord(rules, enabled);
    if ((await readAppRulesInfo(link)).format !== APP_RULES_FORMAT) throw new Error(`App rules: ${OLD_FORMAT_TEXT}`);
    const chunk = chunkSize(link, boardChunk);
    checked(CMD_SVIL_APP_RULES, APP_RULES_BEGIN, await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_BEGIN], { uint8: true }));
    for (let off = 0; off < bytes.length; off += chunk) {
        const part = Array.from(bytes.subarray(off, off + chunk));
        checked(CMD_SVIL_APP_RULES, APP_RULES_WRITE,
            await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_WRITE, off & 0xff, off >> 8, part.length, ...part], { uint8: true }));
    }
    const r = checked(CMD_SVIL_APP_RULES, APP_RULES_COMMIT, await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_COMMIT], { uint8: true }));
    return r[3];
}

export interface AppForegroundStatus {
    /** The app in front, 0 for none (or expired). */
    appId: number;
    msLeft: number;
    /** The rule that applies, null for none. */
    rule: number | null;
    frontLayer: number | null;
    onMask: number;
    offMask: number;
    /** The board's default layer state now (the rule's while one holds it). */
    defaultState: number;
    /** The user's own layer state (what 0x16 reports). */
    userLayers: number;
    /** The layers keys use now, the default layer apart: the user's, with the rule's applied. */
    layers: number;
    flags: number;
    /** App Layers is on (flags bit 3 clear). */
    enabled: boolean;
}

/** APP_FOREGROUND STATUS: which app is in front and which rule applies now. */
export async function readAppForeground(link: AppRulesLink): Promise<AppForegroundStatus> {
    const r = checked(CMD_SVIL_APP_FOREGROUND, APP_FOREGROUND_STATUS,
        await link.sendSvil(CMD_SVIL_APP_FOREGROUND, [APP_FOREGROUND_STATUS], { uint8: true }));
    return {
        appId: le32(r, 3),
        msLeft: le16(r, 7),
        rule: r[9] === 0xff ? null : r[9],
        frontLayer: r[10] === 0xff ? null : r[10],
        onMask: le16(r, 11),
        offMask: le16(r, 13),
        defaultState: le32(r, 19),
        userLayers: le32(r, 23),
        layers: le32(r, 27),
        flags: r[31] ?? 0,
        enabled: ((r[31] ?? 0) & APP_FG_LAYERS_OFF) === 0,
    };
}

// ---- layout files (.svil) ----------------------------------------------------------

/** A rule as a .svil file keeps it: the app key too, when Keybard knows it. */
export interface SvilAppRule {
    app_id: number;
    key?: string;
    /** The rule's text as the board stores it (the app key, or the site). Older files: `label`. */
    text?: string;
    label?: string;
    default_layer: number | null;
    front_layer: number | null;
    on_mask: number;
    off_mask: number;
    flags?: number;
}

export const appRulesToSvil = (rules: readonly AppRule[]): SvilAppRule[] => rules.map((r) => ({
    app_id: r.appId >>> 0,
    ...(r.key?.trim() ? { key: r.key.trim() } : {}),
    text: truncateUtf8(r.text ?? ""),
    default_layer: r.defaultLayer,
    front_layer: r.frontLayer,
    on_mask: r.onMask & 0xffff,
    off_mask: r.offMask & 0xffff,
    flags: r.flags & (APP_RULE_OFF | APP_RULE_SITE),
}));

const fileLayer = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < APP_LAYER_NONE ? v : null);
const fileMask = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v & APP_MASK_USABLE : 0);

/**
 * Rules from a file: at most 64, and only as many as fit the board's record; a key in the file
 * gives the ID (an ID that disagrees loses). A rule without flags is on. Null when absent.
 */
export function appRulesFromSvil(value: unknown): AppRule[] | null {
    if (!Array.isArray(value)) return null;
    const out: AppRule[] = [];
    for (const e of value.slice(0, APP_RULES_MAX)) {
        if (!e || typeof e !== "object") continue;
        const f = e as Record<string, unknown>;
        const typed = typeof f.key === "string" && f.key.trim() ? f.key.trim() : undefined;
        // A website rule's key is normalized, and its text is its site (Keybard Host reads it).
        const site = typed && isSiteKey(typed) ? normalizeSite(typed) : null;
        const fitted = site && siteProblem(site) === null ? site : null;
        const key = site !== null ? (fitted ? SITE_PREFIX + fitted : undefined) : typed;
        const id = key ? appId(key) : (typeof f.app_id === "number" && site === null ? f.app_id >>> 0 : 0);
        const fileText = typeof f.text === "string" ? f.text : typeof f.label === "string" ? f.label : "";
        // A key says whether it's a site; without one, the file's own website flag does.
        const fileFlags = typeof f.flags === "number" ? f.flags : 0;
        const flags = (fileFlags & APP_RULE_OFF) | ((typed ? site !== null : (fileFlags & APP_RULE_SITE) !== 0) ? APP_RULE_SITE : 0);
        const rule: AppRule = {
            appId: id,
            defaultLayer: fileLayer(f.default_layer),
            frontLayer: fileLayer(f.front_layer),
            onMask: fileMask(f.on_mask),
            offMask: fileMask(f.off_mask),
            flags,
            text: truncateUtf8(site !== null ? site : key ?? fileText),
            ...(key ? { key } : {}),
        };
        if (recordUsed([...out, rule]) > APP_RULES_RECORD_BYTES) break;
        out.push(rule);
    }
    return out;
}

/** The App Layers switch from a file: absent means on. */
export const appLayersEnabledFromSvil = (value: unknown): boolean => value !== false;
