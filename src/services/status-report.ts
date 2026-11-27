// Sval STATUS_REPORT (0x3F): the report the Output Status key types, as data
// (keyboards/svalboard/docs/protocol.md, "Status report"). Keybard shows it,
// so it reads right whatever keyboard layout the computer uses; the typed
// report only types right on QWERTY and QWERTZ layouts.
//
//   [0x3F][page][arg] -> [0x3F][page][format][...]
//   page 0: the state, 40 bytes from the page byte
//   page 1: the build text from byte [arg]: [total][offset][n][n bytes]

/** GET_INFO byte 22 (the fifth feature byte), bit 1. Bit 0 is app rules. */
export const SVIL_FLAG5_STATUS_REPORT = 0x02;
export const CMD_SVIL_STATUS_REPORT = 0x3f;
export const STATUS_PAGE_STATE = 0;
export const STATUS_PAGE_BUILD = 1;
const STATE_LEN = 40;

export const hasStatusReport = (featureFlags5: number | undefined | null): boolean =>
    ((featureFlags5 ?? 0) & SVIL_FLAG5_STATUS_REPORT) !== 0;

export interface BoardStatus {
    build: string;
    hostOs: number;
    macMode: boolean;
    left: { scroll: boolean; cpi: number; autoMouse: boolean };
    right: { scroll: boolean; cpi: number; autoMouse: boolean };
    axisLock: boolean;
    naturalScroll: boolean;
    autoMouse: boolean;
    /** null: no timeout. */
    autoMouseTimeoutMs: number | null;
    boostHeld: [number, number, number];
    boostToggled: [boolean, boolean, boolean];
    boostMult: number;
    hwRevB: boolean;
    opticalDebounce: boolean;
    storageReset: boolean;
    writeFailed: boolean;
    prewaitUs: number;
    postwaitUs: number;
    periodUs: number;
    idlePeriodMs: number;
    idleAfterMs: number;
    deepPeriodMs: number;
    deepAfterS: number;
    frameUs: number;
    ledUs: number;
    stage: number;
    idleFlags: number;
    deepMhz: number;
    clockMhz: number;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

/**
 * Page 0 of a reply after the wrapper (it starts at the command echo); null if it
 * isn't one (older firmware answers 0xFF, an unknown page format 0).
 */
export function parseStatusState(reply: Uint8Array | null | undefined): Omit<BoardStatus, "build"> | null {
    if (!reply || reply.length < 1 + STATE_LEN || reply[0] !== CMD_SVIL_STATUS_REPORT) return null;
    const p = reply.subarray(1);
    if (p[0] !== STATUS_PAGE_STATE || p[1] !== 1) return null;
    const a = p[2], b = p[3];
    return {
        hostOs: p[4],
        macMode: !!(a & 0x80),
        left: { scroll: !!(a & 0x01), cpi: u16(p, 5), autoMouse: !!(a & 0x20) },
        right: { scroll: !!(a & 0x02), cpi: u16(p, 7), autoMouse: !!(a & 0x40) },
        axisLock: !!(a & 0x04),
        naturalScroll: !!(a & 0x08),
        autoMouse: !!(a & 0x10),
        autoMouseTimeoutMs: b & 0x10 ? null : u16(p, 9),
        boostHeld: [p[11], p[12], p[13]],
        boostToggled: [!!(p[14] & 1), !!(p[14] & 2), !!(p[14] & 4)],
        boostMult: p[15],
        hwRevB: !!(b & 0x01),
        opticalDebounce: !!(b & 0x02),
        storageReset: !!(b & 0x04),
        writeFailed: !!(b & 0x08),
        prewaitUs: u16(p, 16),
        postwaitUs: u16(p, 18),
        periodUs: u16(p, 20),
        idlePeriodMs: u16(p, 22),
        idleAfterMs: u16(p, 24),
        deepPeriodMs: u16(p, 26),
        deepAfterS: u16(p, 28),
        frameUs: (u16(p, 30) | (u16(p, 32) << 16)) >>> 0,
        ledUs: u16(p, 34),
        stage: p[36],
        idleFlags: p[37],
        deepMhz: p[38],
        clockMhz: p[39],
    };
}

export interface BuildChunk {
    total: number;
    offset: number;
    bytes: Uint8Array;
}

/** A page 1 reply after the wrapper; null if it isn't one. */
export function parseStatusBuild(reply: Uint8Array | null | undefined): BuildChunk | null {
    if (!reply || reply.length < 6 || reply[0] !== CMD_SVIL_STATUS_REPORT) return null;
    const p = reply.subarray(1);
    if (p[0] !== STATUS_PAGE_BUILD || p[1] !== 1) return null;
    const n = Math.min(p[4], p.length - 5);
    return { total: p[2], offset: p[3], bytes: p.slice(5, 5 + n) };
}

/** Sends one STATUS_REPORT request and returns the reply after the wrapper. */
export type StatusSend = (page: number, arg: number) => Promise<Uint8Array | null>;

/** The whole report: the build text in chunks, then the state. Null if the board didn't answer. */
export async function readBoardStatus(send: StatusSend): Promise<BoardStatus | null> {
    const parts: number[] = [];
    for (let guard = 0; guard < 16; guard++) {
        const chunk = parseStatusBuild(await send(STATUS_PAGE_BUILD, parts.length));
        if (!chunk || chunk.offset !== parts.length) return null;
        parts.push(...chunk.bytes);
        if (chunk.bytes.length === 0 || parts.length >= chunk.total) break;
    }
    const state = parseStatusState(await send(STATUS_PAGE_STATE, 0));
    if (!state) return null;
    return { build: new TextDecoder().decode(new Uint8Array(parts)), ...state };
}

export const OS_NAMES: Record<number, string> = { 1: "Linux", 2: "Windows", 3: "macOS", 4: "iOS" };
const onOff = (v: boolean) => (v ? "On" : "Off");
const STAGES = ["Active", "Light idle", "Deep idle"];

export interface StatusRow {
    label: string;
    value: string;
}

export interface StatusGroup {
    title: string;
    rows: StatusRow[];
}

/**
 * The report as plain groups of rows: what the page shows and Copy writes. One
 * fact per row, so each value stays one short line in a narrow panel.
 */
export function statusGroups(s: BoardStatus): StatusGroup[] {
    const toggled = ["2x", "3x", "5x"].filter((_, i) => s.boostToggled[i]).map((x) => `${x} toggled`);
    const held = ["2x", "3x", "5x"].filter((_, i) => s.boostHeld[i] > 0).map((x) => `${x} held`);
    const boostKeys = [...toggled, ...held];
    const after = (v: number, unit: string) => (v === 0 ? "Never" : `After ${v} ${unit}`);
    const idle = [
        [0x01, "Pointer rest"], [0x02, "RGB dim"], [0x04, "CPU sleep"], [0x08, "Low clock"], [0x10, "Long naps"],
    ].filter(([bit]) => s.idleFlags & (bit as number)).map(([, name]) => name as string);
    const storage: StatusRow[] = [];
    if (s.storageReset) storage.push({ label: "Settings", value: "Reset: storage unreadable" });
    if (s.writeFailed) storage.push({ label: "Saving", value: "Fails until a restart" });
    return [
        { title: "Firmware", rows: [{ label: "Build", value: s.build || "Not reported" }, ...storage] },
        {
            title: "Pointing",
            rows: [
                { label: "Left CPI", value: String(s.left.cpi) },
                { label: "Left Scroll Mode", value: onOff(s.left.scroll) },
                { label: "Right CPI", value: String(s.right.cpi) },
                { label: "Right Scroll Mode", value: onOff(s.right.scroll) },
                { label: "Natural scroll", value: onOff(s.naturalScroll) },
                { label: "Axis scroll lock", value: s.axisLock && s.macMode ? "On, unused on Mac" : onOff(s.axisLock) },
                { label: "Boost", value: s.boostMult > 1 ? `${s.boostMult}x` : "Off" },
                ...(boostKeys.length ? [{ label: "Boost keys", value: boostKeys.join(", ") }] : []),
            ],
        },
        {
            title: "Auto Mouse",
            rows: [
                { label: "Auto Mouse", value: onOff(s.autoMouse) },
                { label: "Turned on by", value: s.left.autoMouse && s.right.autoMouse ? "Both pointers" : s.left.autoMouse ? "Left pointer" : s.right.autoMouse ? "Right pointer" : "Neither pointer" },
                { label: "Timeout", value: s.autoMouseTimeoutMs === null ? "None" : `${s.autoMouseTimeoutMs} ms` },
            ],
        },
        {
            title: "Computer",
            rows: [
                { label: "Detected OS", value: OS_NAMES[s.hostOs] ?? "Not known" },
                { label: "Mac mode", value: onOff(s.macMode) },
            ],
        },
        {
            title: "Scanning",
            rows: [
                { label: "Hardware revision", value: s.hwRevB ? "B (FlipFET)" : "A" },
                { label: "Wait before read", value: `${s.prewaitUs} µs` },
                { label: "Wait after read", value: `${s.postwaitUs} µs` },
                { label: "Optical debounce", value: onOff(s.opticalDebounce) },
                { label: "Scan period", value: s.periodUs ? `${s.periodUs} µs` : "Unpaced" },
                { label: "Measured frame", value: `${s.frameUs} µs` },
                { label: "LED on time", value: `${s.ledUs} µs` },
            ],
        },
        {
            title: "Power",
            rows: [
                { label: "Light idle", value: after(s.idleAfterMs, "ms") },
                { label: "Light idle frame", value: `${s.idlePeriodMs} ms` },
                { label: "Deep idle", value: after(s.deepAfterS, "s") },
                { label: "Deep idle frame", value: `${s.deepPeriodMs} ms` },
                { label: "Deep idle clock", value: `${s.deepMhz} MHz` },
                { label: "Power saving", value: idle.length ? idle.join(", ") : "None" },
                { label: "State now", value: STAGES[s.stage] ?? `Stage ${s.stage}` },
                { label: "Clock now", value: `${s.clockMhz} MHz` },
            ],
        },
    ];
}

/** What Keybard and support call it: the row, the dialog's title and the copied text's first line. */
export const STATUS_REPORT_NAME = "Status report";

/** Plain text for pasting into Discord: one line per row, a heading per group. */
export function statusText(s: BoardStatus): string {
    const lines = [`Svalboard ${STATUS_REPORT_NAME.toLowerCase()}`];
    for (const g of statusGroups(s)) {
        lines.push("", g.title);
        for (const r of g.rows) lines.push(`${r.label}: ${r.value}`);
    }
    return lines.join("\n");
}
