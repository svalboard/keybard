/**
 * Settings that changed shape between firmware releases, carried across on
 * import and backup restore so a layout from either side lands as it ran.
 *
 * x4.3 (feat/timing-us-only) replaced two settings:
 *   - the scan speed preset (id_turbo_scan, VIA 9: an index into the turbo
 *     table) with the two waits in µs (id_scan_prewait_us / _postwait_us,
 *     VIA 13 / 14), which older firmware also had, where 0 meant "the preset";
 *   - the auto mouse layer timeout choice (id_automouse_timeout, VIA 5:
 *     200, 300, 400, 500, 800 ms or Infinite) with a time in ms
 *     (id_automouse_timeout_ms, VIA 49) and No Layer Timeout
 *     (id_automouse_no_timeout, VIA 50).
 *
 * Each conversion runs only when the connected board lacks the file's
 * setting and has the one it maps to; anything else passes through.
 */
import type { CustomUIMenuItem, CustomUIValueRef, CustomValueEntry } from '../types/keyboard.types';
import { customValueService } from './custom-value.service';
import { AUTOMOUSE_MS_KEY, AUTOMOUSE_NO_TIMEOUT_KEY, SCAN_POSTWAIT_KEY, SCAN_PREWAIT_KEY, TURBO_KEY, TURBO_US } from '../utils/scan-timing';

/** Older firmware's auto mouse layer timeout (VIA 5): an index into these, or Infinite. */
export const AUTOMOUSE_CHOICE_KEY = 'id_automouse_timeout';
/** sval_timing.c mh_timer_choices. */
export const AUTOMOUSE_CHOICES_MS = [200, 300, 400, 500, 800] as const;
/** The old choice that means Infinite (no timeout). */
export const AUTOMOUSE_NEVER_CHOICE = 5;

/** The firmware release that replaced these settings; its release notes explain the change. */
export const TIMING_US_RELEASE = 'x4.3';

/** A firmware release's page on GitHub. */
export function firmwareReleaseUrl(tag: string): string {
    return `https://github.com/svalboard/qmk/releases/tag/${encodeURIComponent(tag)}`;
}

/** One setting the import carried to its replacement, for a short note: "from → to". */
export interface SettingReplacement {
    from: string;
    to: string;
    /** The firmware release that made the change; none when no release did (a value no firmware could use). */
    release?: string;
}

export type BoardMenuRefs = Map<string, { item: CustomUIMenuItem; ref: CustomUIValueRef }>;

/** The board's menu items, by value key. */
export function boardMenuRefs(menus: CustomUIMenuItem[] | undefined): BoardMenuRefs {
    return new Map(customValueService.extractAllItemsWithRefs(menus ?? []).map(entry => [entry.ref.key, entry]));
}

/** The turbo index whose wait is nearest the mean of the two waits (the same time per row); a tie goes to the slower one. */
export function nearestTurboIndex(preUs: number, postUs: number): number {
    const mean = (preUs + postUs) / 2;
    return TURBO_US.reduce((best, us, i) => (Math.abs(us - mean) < Math.abs(TURBO_US[best] - mean) ? i : best), 0);
}

/** sval_timing.c nearest_choice(): the old choice nearest a time in ms; a tie goes to the shorter one. */
export function nearestAutomouseChoice(ms: number): number {
    return AUTOMOUSE_CHOICES_MS.reduce((best, c, i) => (Math.abs(c - ms) < Math.abs(AUTOMOUSE_CHOICES_MS[best] - ms) ? i : best), 0);
}

const intOf = (entry: CustomValueEntry): number => customValueService.bytesToInt(entry.data, entry.data.length);

const WAITS = 'Scan wait before / after read';
const AUTOMOUSE = 'Auto mouse timeout';
const NO_TIMEOUT = 'No layer timeout';
const choiceName = (choice: number) => `${AUTOMOUSE} (${choice === AUTOMOUSE_NEVER_CHOICE ? 'Infinite' : `${AUTOMOUSE_CHOICES_MS[choice]} ms`} choice)`;

/**
 * The file's custom values, with the settings that changed shape converted to
 * what this board has, and a line for each one converted.
 */
export function migrateCustomValues(entries: CustomValueEntry[], board: BoardMenuRefs): { values: CustomValueEntry[]; replaced: SettingReplacement[] } {
    const replaced: SettingReplacement[] = [];
    const note = (from: string, to: string) => replaced.push({ from, to, release: TIMING_US_RELEASE });
    const values = new Map(entries.map(entry => [entry.key, entry]));
    const has = (key: string) => board.has(key);
    const inFile = (key: string) => values.has(key);
    const num = (key: string) => (values.has(key) ? intOf(values.get(key)!) : undefined);
    const put = (key: string, value: number) => {
        const { item, ref } = board.get(key)!;
        values.set(key, { key, channel: ref.channel, valueId: ref.valueId, data: customValueService.intToBytes(value, customValueService.getByteWidth(item)) });
    };

    // An older layout on newer firmware: the preset fills in each wait that was 0. A wait set in the file wins.
    if (inFile(TURBO_KEY) && !has(TURBO_KEY) && has(SCAN_PREWAIT_KEY) && has(SCAN_POSTWAIT_KEY)) {
        const stored = num(TURBO_KEY)!;
        const turbo = stored >= 0 && stored < TURBO_US.length ? stored : 0;
        const us = TURBO_US[turbo];
        for (const key of [SCAN_PREWAIT_KEY, SCAN_POSTWAIT_KEY]) if (!((num(key) ?? 0) > 0)) put(key, us);
        values.delete(TURBO_KEY);
        note(`Scan speed (preset ${turbo})`, `${WAITS} (${num(SCAN_PREWAIT_KEY)} / ${num(SCAN_POSTWAIT_KEY)} µs)`);
    }

    // An older layout on newer firmware: the old choice becomes a time, or No Layer Timeout.
    if (inFile(AUTOMOUSE_CHOICE_KEY) && !has(AUTOMOUSE_CHOICE_KEY) && has(AUTOMOUSE_MS_KEY) && has(AUTOMOUSE_NO_TIMEOUT_KEY)) {
        const choice = num(AUTOMOUSE_CHOICE_KEY)!;
        if (choice === AUTOMOUSE_NEVER_CHOICE) {
            // The time stays as the board (or the file) has it, for when the timeout is turned back on.
            if (!inFile(AUTOMOUSE_NO_TIMEOUT_KEY)) put(AUTOMOUSE_NO_TIMEOUT_KEY, 1);
            note(choiceName(choice), `${NO_TIMEOUT}: on`);
        } else if (choice >= 0 && choice < AUTOMOUSE_CHOICES_MS.length) {
            if (!((num(AUTOMOUSE_MS_KEY) ?? 0) > 0)) put(AUTOMOUSE_MS_KEY, AUTOMOUSE_CHOICES_MS[choice]);
            if (!inFile(AUTOMOUSE_NO_TIMEOUT_KEY)) put(AUTOMOUSE_NO_TIMEOUT_KEY, 0);
            note(choiceName(choice), `${AUTOMOUSE}: ${num(AUTOMOUSE_MS_KEY)} ms`);
        }
        values.delete(AUTOMOUSE_CHOICE_KEY);
    }

    // A newer layout on older firmware: the time becomes the nearest old choice, or Infinite.
    if ((inFile(AUTOMOUSE_MS_KEY) || inFile(AUTOMOUSE_NO_TIMEOUT_KEY)) && !has(AUTOMOUSE_MS_KEY) && !has(AUTOMOUSE_NO_TIMEOUT_KEY) && has(AUTOMOUSE_CHOICE_KEY)) {
        if (!inFile(AUTOMOUSE_CHOICE_KEY)) {
            const ms = num(AUTOMOUSE_MS_KEY) ?? 0;
            if (num(AUTOMOUSE_NO_TIMEOUT_KEY)) {
                put(AUTOMOUSE_CHOICE_KEY, AUTOMOUSE_NEVER_CHOICE);
                note(`${NO_TIMEOUT}: on`, choiceName(AUTOMOUSE_NEVER_CHOICE));
            } else if (ms > 0) {
                put(AUTOMOUSE_CHOICE_KEY, nearestAutomouseChoice(ms));
                note(`${AUTOMOUSE}: ${ms} ms`, choiceName(nearestAutomouseChoice(ms)));
            }
        }
        values.delete(AUTOMOUSE_MS_KEY);
        values.delete(AUTOMOUSE_NO_TIMEOUT_KEY);
    }

    // A newer layout on older firmware: the waits carry over as they are, and the preset is set to the nearest one.
    if (!inFile(TURBO_KEY) && has(TURBO_KEY) && (inFile(SCAN_PREWAIT_KEY) || inFile(SCAN_POSTWAIT_KEY))) {
        const pre = num(SCAN_PREWAIT_KEY) ?? 0, post = num(SCAN_POSTWAIT_KEY) ?? 0;
        const turbo = nearestTurboIndex(pre || post, post || pre);
        if (pre > 0 || post > 0) put(TURBO_KEY, turbo);
        // Firmware with the preset alone: the preset is all of the timing it takes. Where
        // the waits carry over, they are the timing, and the preset changes nothing to note.
        if ((pre > 0 || post > 0) && (!has(SCAN_PREWAIT_KEY) || !has(SCAN_POSTWAIT_KEY))) {
            note(`${WAITS} (${pre || post} / ${post || pre} µs)`, `Scan speed (preset ${turbo}, ${TURBO_US[turbo]} µs)`);
        }
        if (!has(SCAN_PREWAIT_KEY)) values.delete(SCAN_PREWAIT_KEY);
        if (!has(SCAN_POSTWAIT_KEY)) values.delete(SCAN_POSTWAIT_KEY);
    }

    return { values: [...values.values()], replaced };
}
