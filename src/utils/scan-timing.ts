/**
 * Key scan timing: the two waits per row, in microseconds, are the only timing
 * controls. Firmware before feat/timing-us-only also had a turbo preset, and a
 * wait of 0 meant "use the preset"; Keybard never shows that. It shows the
 * waits the board runs, filling a 0 in from the preset table.
 */
export const SCAN_PREWAIT_KEY = "id_scan_prewait_us";
export const SCAN_POSTWAIT_KEY = "id_scan_postwait_us";
/** Older firmware's preset (VIA value 9). Never shown; read only to fill a 0 wait in. */
export const TURBO_KEY = "id_turbo_scan";
export const TIMING_KEYS = [SCAN_PREWAIT_KEY, SCAN_POSTWAIT_KEY] as const;

/** svalboard.c sval_turbo_us: the old turbo table, the same for both waits. */
export const TURBO_US = [90, 60, 45, 30, 25, 20, 15] as const;

/** The wait a board runs for a stored wait and turbo index (0 = the table, on older firmware). */
export function effectiveWaitUs(stored: number, turbo: number | undefined): number {
    if (stored > 0) return stored;
    const t = turbo !== undefined && turbo >= 0 && turbo < TURBO_US.length ? turbo : 0;
    return TURBO_US[t];
}

/** The values to show: each scan wait as the board runs it. Other values pass through. */
export function withEffectiveTiming(values: Map<string, number>): Map<string, number> {
    const turbo = values.get(TURBO_KEY);
    let out: Map<string, number> | null = null;
    for (const key of TIMING_KEYS) {
        const stored = values.get(key);
        if (stored === undefined || stored > 0) continue;
        out ??= new Map(values);
        out.set(key, effectiveWaitUs(stored, turbo));
    }
    return out ?? values;
}

/**
 * The writes for a changed wait. On older firmware the other wait may still be
 * 0 ("the preset"); it is written with the value it runs, so the board stops
 * depending on the preset and both waits stay what the panel shows.
 */
export function timingWrites(key: string, value: number, values: Map<string, number>): [string, number][] {
    const writes: [string, number][] = [[key, value]];
    const other = key === SCAN_PREWAIT_KEY ? SCAN_POSTWAIT_KEY : key === SCAN_POSTWAIT_KEY ? SCAN_PREWAIT_KEY : null;
    if (other) {
        const stored = values.get(other);
        if (stored === 0) writes.push([other, effectiveWaitUs(0, values.get(TURBO_KEY))]);
    }
    return writes;
}

/** Auto mouse layer timeout (firmware feat/timing-us-only: VIA 49 and 50). */
export const AUTOMOUSE_MS_KEY = "id_automouse_timeout_ms";
export const AUTOMOUSE_NO_TIMEOUT_KEY = "id_automouse_no_timeout";

/**
 * Values to read back from the board after a write of key, because the board
 * may store something else (clamped, rounded) or change them together.
 */
export function readBackKeys(key: string): string[] {
    if ((TIMING_KEYS as readonly string[]).includes(key)) return [...TIMING_KEYS];
    if (key === AUTOMOUSE_MS_KEY || key === AUTOMOUSE_NO_TIMEOUT_KEY) return [AUTOMOUSE_MS_KEY, AUTOMOUSE_NO_TIMEOUT_KEY];
    // The touchpad hold time: the board keeps the nearest of its hold times.
    if (key === "id_pad_hold_ms") return [key];
    return [];
}
