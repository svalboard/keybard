import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { surfaceKeys } from '@/features/trainer/useSurfaceKeys';
import { keyService } from '@/services/key.service';
import { OverlaySurface } from '@/features/trainer/OverlaySurface';
import { DEFAULTS } from '@/features/trainer/core';
function keys(key: string, modifiers?: { shift: boolean; capsLock: boolean }) {
    const code = keyService.parse(key)!;
    return surfaceKeys({ rows: 10, cols: 6, keymap: [[code]],
        keylayout: { 0: { row: 0, col: 0, x: 0, y: 0, w: 1, h: 1 } } }, 0, 1, 'Both', 'us', modifiers);
}
describe('live overlay legends', () => {
    it.each([[false,false,'a'], [true,false,'A'], [false,true,'A'], [true,true,'a']] as const)(
        'Shift %s Caps %s gives %s', (shift,capsLock,expected) => expect(keys('KC_A', {shift,capsLock})[0].label).toBe(expected));
    it.each(Array.from({ length: 24 }, (_, i) => i + 1))('keeps F%s uppercase with every modifier state', n => {
        for (const modifiers of [undefined, {shift:false,capsLock:false}, {shift:true,capsLock:false}, {shift:false,capsLock:true}, {shift:true,capsLock:true}]) {
            expect(keys(`KC_F${n}`, modifiers)[0].legend?.displayLabel).toBe(`F${n}`);
        }
    });
    it.each(['LCTL(KC_F1)', 'LSFT_T(KC_F9)', 'LT3(KC_F24)'])('keeps wrapped function-key labels uppercase: %s', action => {
        expect(keys(action, {shift:false,capsLock:false})[0].legend?.displayLabel).toMatch(/^F(?:1|9|24)$/);
    });
    it('keeps static uppercase when state is unavailable', () => expect(keys('KC_A')[0].label).toBe('A'));
    it('shifts punctuation but Caps does not', () => {
        expect(keys('KC_SCOLON', {shift:true,capsLock:false})[0].label).toBe(':');
        expect(keys('KC_SCOLON', {shift:false,capsLock:true})[0].label).toBe(';');
        expect(keys('LSFT(KC_1)', {shift:true,capsLock:false})[0].label).toBe('!');
    });
    it('does not apply the hold modifier to a mod-tap tap', () => {
        expect(keys('LSFT_T(KC_A)', {shift:false,capsLock:false})[0].legend?.displayLabel).toBe('a');
    });
    it.each([['KC_ESC','Escape'],['KC_DELETE','Delete'],['KC_LSHIFT','Shift'],['KC_LCTRL','Control'],['KC_LALT','Alt'],['KC_CAPSLOCK','Caps']])(
        'normalizes %s', (key,label) => expect(keys(key)[0].label).toBe(label));
    it.each(['MO(3)', 'TG(3)', 'DF(3)', 'TO(3)', 'OSL(3)'])('renders the shared layer icon for %s', (action) => {
        const { container } = render(<OverlaySurface keys={keys(action)} appearance={DEFAULTS.appearance} changed={new Set()} held={new Set()} hidden={new Set()} effect="Off" duration={150} />);
        expect(container.querySelector('.trainer-legends svg path')).not.toBeNull();
        expect(container.querySelector('.trainer-key-center')?.textContent).toBe('3');
        expect(container.querySelector('.trainer-key-heading')?.textContent).toBeTruthy();
    });
    it.each(['TD(4)', 'M0', 'KC_UP', 'KC_MS_UP'])('renders shared icons for %s', action => {
        const { container } = render(<OverlaySurface keys={keys(action)} appearance={DEFAULTS.appearance} changed={new Set()} held={new Set()} hidden={new Set()} effect="Off" duration={150} />);
        expect(container.querySelector('.trainer-legends svg')).not.toBeNull();
    });
    it('hides icons as well as labels during practice', () => {
        const { container } = render(<OverlaySurface keys={keys('MO(3)')} appearance={DEFAULTS.appearance} changed={new Set()} held={new Set()} hidden={new Set([0])} effect="Off" duration={150} />);
        expect(container.querySelector('.trainer-legends > div')).toBeNull();
        expect(container.querySelector('foreignObject')).toBeNull();
        expect(container.querySelector('text')?.textContent).toBe('·');
    });
    it('keeps the layer-tap action separate from its tap legend', () => {
        const key = keys('LT3(KC_A)', {shift:true,capsLock:false})[0];
        expect(key.legend?.topLabel).toBe('LT3');
        expect(key.legend?.displayLabel).toBe('A');
    });
});
