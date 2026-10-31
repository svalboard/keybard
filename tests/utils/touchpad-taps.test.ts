import { describe, expect, it } from 'vitest';
import type { CustomUIMenuItem, KeyboardInfo } from '@/types/keyboard.types';
import { selectPointingMenu } from '@/utils/pointing-menu';
import { readBackKeys } from '@/utils/scan-timing';
import {
    boardHasTouchpad, hasPadGestures, PAD_HOLD_DEFAULT_MS, PAD_HOLD_MS, PAD_HOLD_MS_KEY, PAD_KEYS, SVIL_FLAG3_PAD_GESTURES,
    TOUCHPAD_NOTE, TOUCHPAD_SECTION_LABEL, withTouchpadTaps,
} from '@/utils/touchpad-taps';

const pointing = (channel: number): CustomUIMenuItem => ({
    label: 'Pointing Device',
    content: [
        { label: 'Left Pointer', content: [{ label: 'DPI', type: 'dropdown', options: ['200'], content: ['id_left_dpi', channel, 0] }] },
        { label: 'Auto Mouse', content: [{ label: 'Enable Auto Mouse', type: 'toggle', content: ['id_automouse_enable', channel, 4] }] },
        { label: 'Scroll Settings', content: [{ label: 'Natural Scroll', type: 'toggle', content: ['id_natural_scroll', channel, 7] }] },
        { label: 'Advanced', content: [{ label: 'Scan Pre-wait (us)', type: 'range', options: [1, 1000], content: ['id_scan_prewait_us', channel, 13] }] },
    ],
});
const colors: CustomUIMenuItem = { label: 'Layer Colors', content: [{ label: '0', type: 'color', content: ['id_layer0_color', 0, 32] }] };

function keys(items: CustomUIMenuItem[]): string[] {
    return items.flatMap(item => (typeof item.content?.[0] === 'string' ? [item.content[0] as string] : keys((item.content ?? []) as CustomUIMenuItem[])));
}

describe('touchpad tap setting', () => {
    it('reads the capability from GET_INFO byte 20 bit 4', () => {
        expect(SVIL_FLAG3_PAD_GESTURES).toBe(0x10);
        expect(hasPadGestures(0x1d)).toBe(true);
        expect(hasPadGestures(0x0d)).toBe(false);
        expect(hasPadGestures(undefined)).toBe(false);
    });

    it('leaves the menus alone on firmware without the setting', () => {
        const menus = [pointing(0), colors];
        expect(withTouchpadTaps(menus, 0x0d)).toBe(menus);
        expect(withTouchpadTaps(menus, undefined)).toBe(menus);
    });

    it('adds a Touchpad section before Scroll Settings, on the menu channel', () => {
        for (const channel of [0, 1]) {
            const menus = [pointing(channel), colors];
            const out = withTouchpadTaps(menus, 0x10);
            expect(out).not.toBe(menus);
            expect(out[1]).toBe(colors);
            const sections = (out[0].content as CustomUIMenuItem[]).map(item => item.label);
            expect(sections).toEqual(['Left Pointer', 'Auto Mouse', TOUCHPAD_SECTION_LABEL, 'Scroll Settings', 'Advanced']);
            const section = (out[0].content as CustomUIMenuItem[])[2];
            expect(section.note).toBe(TOUCHPAD_NOTE);
            const refs = keys([section]);
            expect(refs).toEqual([...PAD_KEYS]);
            const flat = JSON.stringify(section);
            for (const id of [51, 52, 53, 54]) expect(flat).toContain(`,${channel},${id}]`);
            // The original menu is unchanged.
            expect(keys([menus[0]])).not.toContain('id_pad_tap');
        }
    });

    it('does not add the section twice', () => {
        const once = withTouchpadTaps([pointing(0)], 0x10);
        expect(withTouchpadTaps(once, 0x10)).toBe(once);
    });

    it('needs a pointing menu', () => {
        const menus = [colors];
        expect(withTouchpadTaps(menus, 0x10)).toBe(menus);
    });

    it('hides the switches without a touchpad, and drops the empty section', () => {
        const menu = withTouchpadTaps([pointing(0)], 0x10)[0];
        const items = menu.content as CustomUIMenuItem[];
        const hidden = selectPointingMenu(items, 'pointing', new Set(PAD_KEYS));
        expect(hidden.map(item => item.label)).not.toContain(TOUCHPAD_SECTION_LABEL);
        expect(keys(hidden)).not.toContain('id_pad_tap');
        const shown = selectPointingMenu(items, 'pointing');
        expect(shown.map(item => item.label)).toContain(TOUCHPAD_SECTION_LABEL);
        // Never in the developer tuning section.
        expect(keys(selectPointingMenu(items, 'developer'))).not.toContain('id_pad_tap');
    });

    it('holds for 300 ms by default, and grays the hold time out while press and hold is off', () => {
        expect(PAD_HOLD_DEFAULT_MS).toBe(300);
        expect(PAD_HOLD_MS).toContain(20);
        const section = (withTouchpadTaps([pointing(0)], 0x10)[0].content as CustomUIMenuItem[])[2];
        const hold = (section.content as CustomUIMenuItem[]).find(item => item.content?.[0] === PAD_HOLD_MS_KEY)!;
        expect(hold.showIf).toBeUndefined();
        expect(hold.disabledIf).toBe('{id_pad_hold} == 0');
    });

    it('reads the hold time back after a write', () => {
        expect(readBackKeys(PAD_HOLD_MS_KEY)).toEqual([PAD_HOLD_MS_KEY]);
        expect(readBackKeys('id_pad_tap')).toEqual([]);
    });

    it('finds a touchpad from 0x2C or a late 0x18 find', () => {
        const half = (detected: string) => ({ usb: true, side: 'right', builtFor: 'azoteq', detected, sensorStarted: true, auto: true, productId: 0, inverseProductId: 40 });
        expect(boardHasTouchpad(null)).toBe(false);
        expect(boardHasTouchpad({ pointing_hardware: { halves: [half('azoteq')] } } as unknown as KeyboardInfo)).toBe(true);
        expect(boardHasTouchpad({ pointing_hardware: { halves: [half('pmw3389')] } } as unknown as KeyboardInfo)).toBe(false);
        expect(boardHasTouchpad({ fragmentState: { hwDetection: new Map([[19, 4], [20, 7]]) } } as unknown as KeyboardInfo)).toBe(true);
        expect(boardHasTouchpad({ fragmentState: { hwDetection: { 19: 4, 20: 5 } } } as unknown as KeyboardInfo)).toBe(false);
    });
});
