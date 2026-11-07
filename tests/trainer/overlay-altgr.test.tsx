import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { surfaceKeys, type SurfaceLegendOptions } from '@/features/trainer/useSurfaceKeys';
import { keyService } from '@/services/key.service';
import { OverlaySurface } from '@/features/trainer/OverlaySurface';
import { DEFAULTS } from '@/features/trainer/core';
import { dualLegendFor } from '@/lib/shiftedLegends';

function draw(key: string, layout: string, legends: SurfaceLegendOptions, shift = false, capitals = false) {
    const code = keyService.parse(key)!;
    const keys = surfaceKeys({ rows: 10, cols: 6, keymap: [[code]],
        keylayout: { 0: { row: 0, col: 0, x: 0, y: 0, w: 1, h: 1 } } }, 0, 1, 'Both', layout, { shift, capsLock: false }, legends);
    const { container } = render(<OverlaySurface keys={keys} appearance={DEFAULTS.appearance} changed={new Set()} held={new Set()}
        hidden={new Set()} effect="Off" duration={150} capitals={capitals} />);
    const legend = (name: string) => container.querySelector(`[data-legend="${name}"]`)?.textContent;
    return { container, shifted: legend('shifted'), base: legend('base'), altgr: legend('altgr'), center: container.querySelector('.trainer-key-center')?.textContent };
}

describe('overlay keycap legends follow Keybard settings', () => {
    it('keeps one centered legend with both settings off, as before', () => {
        const k = draw('KC_2', 'german', {});
        expect(k.center).toBe('2');
        expect(k.shifted).toBeUndefined();
    });

    it('shows the shifted symbol top left and the base bottom left on a German 2', () => {
        const k = draw('KC_2', 'german', { shifted: true });
        expect([k.shifted, k.base, k.altgr]).toEqual(['"', '2', undefined]);
    });

    it('adds the AltGr character bottom right with AltGr Symbols on', () => {
        const k = draw('KC_2', 'german', { shifted: true, altgr: true });
        expect([k.shifted, k.base, k.altgr]).toEqual(['"', '2', '²']);
    });

    it('draws the same legends as Keybard\'s own keys (one function decides)', () => {
        const dual = dualLegendFor('KC_2', '2', undefined, 'german', { shifted: true, altgr: true })!;
        const k = draw('KC_2', 'german', { shifted: true, altgr: true });
        expect([k.shifted, k.base, k.altgr]).toEqual([dual.shifted, dual.base, dual.altgr]);
    });

    it('shows a letter with an AltGr character top left in the letter case in use, AltGr bottom right (Q is @)', () => {
        const k = draw('KC_Q', 'german', { shifted: true, altgr: true });
        expect([k.shifted, k.base, k.altgr]).toEqual(['q', undefined, '@']);
    });

    it('draws the capital of a letter in the case of the other letters', () => {
        expect(draw('KC_Q', 'german', { shifted: true, altgr: true }, false, false).shifted).toBe('q');
        expect(draw('KC_Q', 'german', { shifted: true, altgr: true }, false, true).shifted).toBe('Q');
    });

    it('leaves letters without an AltGr character centered', () => {
        expect(draw('KC_A', 'german', { shifted: true, altgr: true }).center).toBe('a');
    });

    it('shows no AltGr character on a layout without an AltGr level', () => {
        expect(draw('KC_2', 'us', { shifted: true, altgr: true }).altgr).toBeUndefined();
    });

    it('keeps one legend while Shift is held on the board', () => {
        const k = draw('KC_2', 'german', { shifted: true, altgr: true }, true);
        expect(k.base).toBeUndefined();
    });

    it('labels the key AltGr and shows what RALT(KC_2) types, with AltGr Symbols on', () => {
        expect(draw('KC_RALT', 'german', { altgr: true }).center).toBe('AltGr');
        expect(draw('RALT(KC_2)', 'german', { altgr: true }).center).toBe('²');
        expect(draw('KC_RALT', 'german', {}).center).not.toBe('AltGr');
    });
});
