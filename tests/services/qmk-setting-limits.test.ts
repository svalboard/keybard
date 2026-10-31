import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareImport } from '../../src/services/import-preflight';
import {
    MOUSEKEY_STEP_SIZE_QSID, QMK_SETTINGS, VARIABLE_LIMITS, parseSettingInput, settingRange,
} from '../../src/constants/qmk-settings';
import type { KeyboardInfo } from '../../src/types/keyboard.types';

const board = (overrides: Partial<KeyboardInfo> = {}): KeyboardInfo => ({
    rows: 1, cols: 2, layers: 1, keymap: [[4, 5]], svil_proto: 3,
    macros: [], macro_count: 0, macros_size: 64, combos: [], combo_count: 0,
    tapdances: [], tapdance_count: 0, key_overrides: [], key_override_count: 0,
    ...overrides,
});

// What QMK applies each setting to (quantum/mousekey.c, action.h tap.count).
const EIGHT_BIT = [10, 12, 13, 15, 16, 17]; // uint8_t mk_* variables
const TEN_MS_UNITS = [9, 14]; // stored in ms, applied as a uint8_t of 10 ms units
const TAP_COUNTS = [5, 20]; // compared with a 4-bit tap count that stops at 15

// The minimums before this change: none of them moves.
const MINIMUMS: Record<number, number> = { 5: 0, 9: 0, 10: 1, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0, 20: 0 };

describe('setting ranges stop at what the firmware variable holds', () => {
    it('cap each field at its variable: 255, 2550 ms in 10 ms units, 15 taps', () => {
        for (const qsid of EIGHT_BIT) expect(settingRange(qsid).max, `QSID ${qsid}`).toBe(255);
        for (const qsid of TEN_MS_UNITS) expect(settingRange(qsid).max, `QSID ${qsid}`).toBe(2550);
        for (const qsid of TAP_COUNTS) expect(settingRange(qsid).max, `QSID ${qsid}`).toBe(15);
        for (const [qsid, limit] of Object.entries(VARIABLE_LIMITS)) expect(settingRange(Number(qsid)).max, `QSID ${qsid}`).toBe(limit);
        expect(Object.keys(VARIABLE_LIMITS).map(Number).sort((a, b) => a - b)).toEqual([...EIGHT_BIT, ...TEN_MS_UNITS, ...TAP_COUNTS].sort((a, b) => a - b));
    });

    it('keep every minimum: fast settings stay allowed', () => {
        for (const [qsid, min] of Object.entries(MINIMUMS)) expect(settingRange(Number(qsid)).min, `QSID ${qsid}`).toBe(min);
    });

    it('no field allows a value its variable would wrap', () => {
        for (const tab of QMK_SETTINGS.tabs) {
            for (const field of tab.fields) {
                if (field.type !== 'integer' || field.hidden) continue;
                const applied = TEN_MS_UNITS.includes(field.qsid) ? Math.floor(field.max / 10) : field.max;
                const width = EIGHT_BIT.includes(field.qsid) || TEN_MS_UNITS.includes(field.qsid) ? 255 : TAP_COUNTS.includes(field.qsid) ? 15 : 65535;
                expect(applied, `${field.title} (QSID ${field.qsid})`).toBeLessThanOrEqual(width);
            }
        }
    });

    it('typed values hold at the edges instead of wrapping', () => {
        expect(parseSettingInput(10, '255', 20)).toBe(255);
        expect(parseSettingInput(10, '256', 20)).toBe(255); // wrapped to 0: the cursor moved every scan
        expect(parseSettingInput(10, '300', 20)).toBe(255); // wrapped to 44
        expect(parseSettingInput(10, '1', 20)).toBe(1);
        expect(parseSettingInput(9, '2550', 30)).toBe(2550);
        expect(parseSettingInput(9, '2560', 30)).toBe(2550); // wrapped to a delay of 0
        expect(parseSettingInput(14, '10000', 10)).toBe(2550);
        expect(parseSettingInput(15, '0', 80)).toBe(0); // the fastest wheel interval stays allowed
        expect(parseSettingInput(15, '256', 80)).toBe(255);
        expect(parseSettingInput(16, '1000', 8)).toBe(255);
        expect(parseSettingInput(20, '15', 5)).toBe(15);
        expect(parseSettingInput(20, '16', 5)).toBe(15);
        expect(parseSettingInput(5, '50', 5)).toBe(15);
    });
});

describe('step size', () => {
    it('is hidden: QMK builds it in, so no screen shows a number the board ignores', () => {
        const field = QMK_SETTINGS.tabs.flatMap((tab) => tab.fields).find((f) => f.qsid === MOUSEKEY_STEP_SIZE_QSID);
        expect(field?.type).toBe('integer');
        expect(field?.type === 'integer' && field.hidden).toBe(true);
    });
});

describe('importing a value above the limit', () => {
    const settings = { 5: 5, 9: 30, 10: 20, 12: 15, 13: 40, 14: 10, 15: 80, 16: 8, 17: 40, 20: 5, 6: 5000 };

    it('holds it at the limit and lists it in the replaced-settings note, with no release', () => {
        const file = board({ settings: { 10: 300, 15: 256, 9: 10000, 14: 2560, 12: 255, 13: 1000, 16: 256, 17: 65535, 20: 100, 5: 50, 6: 5000 } });
        const review = prepareImport(file, board({ settings }));
        expect(review.errors).toEqual([]);
        expect(review.keyboard.settings).toMatchObject({ 10: 255, 15: 255, 9: 2550, 14: 2550, 12: 255, 13: 255, 16: 255, 17: 255, 20: 15, 5: 15 });
        expect(review.replaced.map((r) => r.to).sort()).toEqual(['15', '15', '255', '255', '255', '255', '255', '2550', '2550']);
        expect(review.replaced.every((r) => r.release === undefined)).toBe(true);
        expect(review.replaced).toContainEqual({ from: 'Time between cursor movements in milliseconds: 300', to: '255' });
        // 12 was already at the limit: not listed.
        expect(review.replaced.some((r) => r.from.startsWith('Maximum cursor speed'))).toBe(false);
    });

    it('keeps values at or under the limit, including 0 where it works', () => {
        const file = board({ settings: { 10: 255, 15: 0, 9: 2550, 20: 15, 5: 0 } });
        const review = prepareImport(file, board({ settings }));
        expect(review.keyboard.settings).toMatchObject({ 10: 255, 15: 0, 9: 2550, 20: 15, 5: 0 });
        expect(review.replaced).toEqual([]);
    });

    it('gives the one-shot block the held tap toggle too', () => {
        const file = board({ settings: { 5: 40, 6: 3000 } });
        const review = prepareImport(file, board({ settings, one_shot: { timeout: 5000, tap_toggle: 5 } }));
        expect(review.keyboard.one_shot).toEqual({ timeout: 3000, tap_toggle: 15 });
    });
});

describe('default layouts', () => {
    const files = ['src/default-layouts/sval-default.svil', 'src/default-layouts/sval-alt-alphas.svil', 'src/default-layouts/sval-num-sym-layers.svil', 'public/old-sval-default.svil'];
    it.each(files)('%s writes the step size the board builds with, and every value in range', (file) => {
        const settings = JSON.parse(readFileSync(resolve(__dirname, '../..', file), 'utf8')).settings as Record<string, number>;
        expect(settings[MOUSEKEY_STEP_SIZE_QSID]).toBe(1); // svalboard/qmk keyboards/svalboard/info.json mousekey.move_delta
        for (const [qsid, value] of Object.entries(settings)) {
            const { min, max } = settingRange(Number(qsid));
            expect(value, `QSID ${qsid}`).toBeGreaterThanOrEqual(min);
            expect(value, `QSID ${qsid}`).toBeLessThanOrEqual(max);
        }
        // The board's mouse key defaults (info.json, QMK): delay 30, interval 20, max speed 15, time to max 40, wheel 10 / 80 / 8 / 40.
        expect([9, 10, 12, 13, 14, 15, 16, 17].map((q) => settings[q])).toEqual([30, 20, 15, 40, 10, 80, 8, 40]);
    });
});
