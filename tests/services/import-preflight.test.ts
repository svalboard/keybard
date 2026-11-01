import { describe, it, expect, vi } from 'vitest';
import { prepareImport } from '../../src/services/import-preflight';
import { fileService } from '../../src/services/file.service';
import { usbInstance } from '../../src/services/usb.service';
import type { KeyboardInfo } from '../../src/types/keyboard.types';

const board = (overrides: Partial<KeyboardInfo> = {}): KeyboardInfo => ({
    rows: 1, cols: 2, layers: 2, keymap: [[4, 5], [6, 7]], svil_proto: 3,
    macros: [{ mid: 0, actions: [] }], macro_count: 1, macros_size: 64,
    combos: [], combo_count: 0, tapdances: [], tapdance_count: 0,
    key_overrides: [], key_override_count: 0, cosmetic: { layer: { '0': 'Base', '1': 'Old' } },
    ...overrides,
});

describe('import preflight', () => {
    it('never carries the touchpad mode (a per-computer choice, not layout)', () => {
        const menus = [{ label: 'Pointing Device', content: [
            { label: 'Touchpad Mode', type: 'dropdown', options: ['Automatic', 'Built-in gestures'], content: ['id_pad_touchpad_mode', 0, 59] },
            { label: 'Tap to Click', type: 'toggle', content: ['id_pad_tap', 0, 51] },
        ] }] as never;
        const current = board({ menus, custom_values: [{ key: 'id_pad_touchpad_mode', channel: 0, valueId: 59, data: [0] }, { key: 'id_pad_tap', channel: 0, valueId: 51, data: [1] }] });
        const file = board({ menus, custom_values: [{ key: 'id_pad_touchpad_mode', channel: 0, valueId: 59, data: [1] }, { key: 'id_pad_tap', channel: 0, valueId: 51, data: [0] }] });
        const review = prepareImport(file, current);
        expect(review.keyboard.custom_values?.find(v => v.key === 'id_pad_touchpad_mode')?.data).toEqual([0]);
        expect(review.keyboard.custom_values?.find(v => v.key === 'id_pad_tap')?.data).toEqual([0]);
        expect(review.unavailable ?? []).not.toContain('Touchpad Mode');
    });

    it('is read-only and preserves unimported layers while clearing explicitly blank labels', () => {
        const send = vi.spyOn(usbInstance, 'sendSvil');
        const current = board();
        const original = structuredClone(current);
        const review = prepareImport(board({ layers: 1, keymap: [[8, 9]], cosmetic: { layer: {} } }), current);
        expect(review.errors).toEqual([]);
        expect(review.keyboard.keymap).toEqual([[8, 9], [6, 7]]);
        expect(review.keyboard.cosmetic?.layer).toEqual({ '0': '', '1': 'Old' });
        expect(current).toEqual(original);
        expect(send).not.toHaveBeenCalled();
        send.mockRestore();
    });
    it('blocks matrix, layer, and table capacity mismatches', () => {
        const review = prepareImport(board({ cols: 3, layers: 3, macro_count: 2, macros: [{ mid: 0, actions: [] }, { mid: 1, actions: [] }] }), board());
        expect(review.errors.join(' ')).toMatch(/Matrix mismatch/);
        expect(review.errors.join(' ')).toMatch(/3 layers/);
        expect(review.errors.join(' ')).toMatch(/The file has 2 macros; this keyboard holds 1\./);
    });
    it('blocks oversized and unrepresentable macros before any writes', () => {
        const review = prepareImport(board({ macros: [{ mid: 0, actions: [['text', 'é'.repeat(100)]] }] }), board());
        expect(review.errors.join(' ')).toMatch(/non-ASCII/);
        expect(review.errors.join(' ')).toMatch(/macro buffer/);
    });
    it('reports unsupported settings and preserves the connected hardware definition', () => {
        const current = board({ settings: { 1: 4 }, name: 'Actual board' });
        const review = prepareImport(board({ settings: { 1: 5, 99: 9 }, custom_values: [{ key: 'unknown', channel: 1, valueId: 1, data: [1] }], name: 'File board' }), current);
        expect(review.keyboard.settings).toEqual({ 1: 5 });
        expect(review.keyboard.name).toBe('Actual board');
        expect(review.unavailable).toEqual(['QMK setting 99', 'Unknown']);
        expect(review.warnings).toEqual([]);
    });
    it('restores alt-repeat keys and leaders from the file and keeps entries beyond its tables', () => {
        const ark = (arkid: number, keycode: string, alt_keycode: string) => ({ arkid, keycode, alt_keycode, allowed_mods: 0, options: 8 });
        const leader = (ldrid: number, sequence: string[], output: string) => ({ ldrid, sequence, output, options: 0x8000 });
        const current = board({
            alt_repeat_keys: [ark(0, 'KC_A', 'KC_B'), ark(1, 'KC_C', 'KC_D')], alt_repeat_key_count: 2,
            leaders: [leader(0, ['KC_E'], 'KC_F'), leader(1, ['KC_G'], 'KC_H')], leader_count: 2,
        });
        const review = prepareImport(board({ alt_repeat_keys: [ark(0, 'KC_X', 'KC_Y')], leaders: [leader(0, ['KC_Q', 'KC_W'], 'KC_Z')] }), current);
        expect(review.errors).toEqual([]);
        expect(review.warnings.join(' ')).not.toMatch(/alt repeat keys|leaders/);
        expect(review.keyboard.alt_repeat_keys).toEqual([ark(0, 'KC_X', 'KC_Y'), ark(1, 'KC_C', 'KC_D')]);
        expect(review.keyboard.leaders).toEqual([leader(0, ['KC_Q', 'KC_W'], 'KC_Z'), leader(1, ['KC_G'], 'KC_H')]);
        expect(review.summary).toEqual(expect.arrayContaining(['1 alt-repeat keys', '1 leader sequences']));
    });
    it('keeps alt-repeat keys and leaders when the file has none', () => {
        const current = board({
            alt_repeat_keys: [{ arkid: 0, keycode: 'KC_A', alt_keycode: 'KC_B', allowed_mods: 0, options: 8 }], alt_repeat_key_count: 1,
            leaders: [{ ldrid: 0, sequence: ['KC_E'], output: 'KC_F', options: 0x8000 }], leader_count: 1,
        });
        const review = prepareImport(board(), current);
        expect(review.errors).toEqual([]);
        expect(review.keyboard.alt_repeat_keys).toEqual(current.alt_repeat_keys);
        expect(review.keyboard.leaders).toEqual(current.leaders);
    });
    it('blocks alt-repeat keys and leaders the keyboard cannot store', () => {
        const current = board({ alt_repeat_keys: [], alt_repeat_key_count: 1, leaders: [], leader_count: 1 });
        const review = prepareImport(board({
            alt_repeat_keys: [
                { arkid: 0, keycode: 'NOT_A_KEY', alt_keycode: 'KC_B', allowed_mods: 0, options: 8 },
                { arkid: 1, keycode: 'KC_A', alt_keycode: 'KC_B', allowed_mods: 256, options: 8 },
            ],
            leaders: [{ ldrid: 0, sequence: ['KC_A', 'KC_B', 'KC_C', 'KC_D', 'KC_E', 'KC_F'], output: 'KC_G', options: 70000 }],
        }), current);
        const errors = review.errors.join(' ');
        expect(errors).toMatch(/The file has 2 alt-repeat keys; this keyboard holds 1/);
        expect(errors).toMatch(/alt-repeat key contains an unrecognized keycode/);
        expect(errors).toMatch(/Alt-repeat key modifiers and options/);
        expect(errors).toMatch(/more than 5 keys/);
        expect(errors).toMatch(/Leader options/);
    });
    it('recognizes Vial version 1 without silently treating it as Sval', () => {
        const legacy = fileService.parseContent(JSON.stringify({ uid: 123, version: 1, vial_protocol: 6, layout: [[['KC_A', 'KC_B']]], macro: [], tap_dance: [[4,5,6,7,250]] }));
        expect(legacy.rows).toBe(1);
        expect(legacy.cols).toBe(2);
        expect(legacy.tapdances?.[0].tapping_term).toBe(250);
        expect(legacy.vial_proto).toBe(6);
        expect(legacy.vial_import?.svalboard).toBe(false);
    });
    it('rejects malformed matrices and raw kbi snapshots with useful errors', () => {
        expect(() => fileService.parseContent(JSON.stringify({ uid: 1, layout: [[['KC_A']], [['KC_A', 'KC_B']]] }))).toThrow(/rectangular/);
        expect(() => fileService.parseContent(JSON.stringify({ rows: 1, cols: 1, keymap: [[4]] }))).toThrow(/kbi/);
    });
});
