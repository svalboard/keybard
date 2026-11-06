import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BasicKeyboards from '../../src/layout/SecondarySidebar/Panels/BasicKeyboards';
import { getSelectedKeymapKeycode } from '../../src/hooks/useModifierSide';
import type { KeyboardInfo } from '../../src/types/keyboard.types';

const layoutSettings = {
    keyVariant: 'default' as 'small' | 'medium' | 'default',
    layoutMode: 'sidebar' as 'sidebar' | 'bottombar',
    internationalLayout: 'us',
    setInternationalLayout: vi.fn(),
};
const assignKeycode = vi.fn();
const binding: { selectedTarget: any } = { selectedTarget: null };

const keyboard: KeyboardInfo = {
    rows: 4,
    cols: 6,
    keymap: [[0x04, 0x1104, 0x0204, 0x0038, 0, 0]],
    combos: [
        {
            cmbid: 0,
            keys: ['KC_A', 'KC_SLASH', 'KC_NO', 'KC_NO'],
            output: 'KC_3',
            options: 0,
        },
        {
            cmbid: 1,
            keys: ['KC_A', 'LCTL(KC_SLASH)', 'KC_NO', 'KC_NO'],
            output: 'KC_3',
            options: 0,
        },
        {
            cmbid: 2,
            keys: ['KC_A', 'RCTL(KC_SLASH)', 'KC_NO', 'KC_NO'],
            output: 'KC_3',
            options: 0,
        },
    ],
    tapdances: [
        {
            idx: 0,
            tap: 'KC_SLASH',
            hold: 'KC_NO',
            doubletap: 'KC_NO',
            taphold: 'KC_NO',
            tapping_term: 200,
        },
    ],
};

vi.mock('@/contexts/LayoutSettingsContext', () => ({ useLayoutSettings: () => layoutSettings }));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard }) }));
vi.mock('@/contexts/LayerContext', () => ({ useLayer: () => ({ selectedLayer: 0 }) }));
vi.mock('@/contexts/KeyBindingContext', () => ({
    useKeyBinding: () => ({ assignKeycode, isBinding: true, selectedTarget: binding.selectedTarget }),
}));
vi.mock('@/components/Key', () => ({
    Key: ({ keycode, onClick, label }: { keycode: string; onClick?: () => void; label?: string }) => (
        <button type="button" data-testid="key" data-keycode={keycode} data-label={label} onClick={onClick}>
            {keycode}
        </button>
    ),
}));

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

describe('BasicKeyboards: Combo slot selection and Mod-Tap button', () => {
    beforeEach(() => {
        layoutSettings.layoutMode = 'sidebar';
        binding.selectedTarget = null;
        assignKeycode.mockClear();
    });

    it('getSelectedKeymapKeycode resolves keycodes from combo slots', () => {
        // combo 0, slot 1 is 'KC_SLASH' (0x0038)
        const code0 = getSelectedKeymapKeycode(keyboard, { type: 'combo', comboId: 0, comboSlot: 1 });
        expect(code0).toBe(0x0038);

        // combo 1, slot 1 is 'LCTL(KC_SLASH)' (0x0138)
        const code1 = getSelectedKeymapKeycode(keyboard, { type: 'combo', comboId: 1, comboSlot: 1 });
        expect(code1).toBe(0x0138);

        // combo 0, slot 4 is output 'KC_3' (0x0020)
        const codeOutput = getSelectedKeymapKeycode(keyboard, { type: 'combo', comboId: 0, comboSlot: 4 });
        expect(codeOutput).toBe(0x0020);

        // tapdance 0, tap slot is 'KC_SLASH' (0x0038)
        const codeTd = getSelectedKeymapKeycode(keyboard, { type: 'tapdance', tapdanceId: 0, tapdanceSlot: 'tap' });
        expect(codeTd).toBe(0x0038);
    });

    it('populates the Mod-Tap button with the combo slot existing character (e.g. /)', () => {
        // Select combo 0, slot 1 which has 'KC_SLASH'
        binding.selectedTarget = { type: 'combo', comboId: 0, comboSlot: 1 };
        render(<BasicKeyboards />);

        // Activate Ctrl modifier
        fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));

        // The Mod-Tap key should now be LCTL_T(KC_SLASH) instead of LCTL_T(KC_NO)
        const modTapKey = screen.getAllByTestId('key').find((el) => el.getAttribute('data-keycode') === 'LCTL_T(KC_SLASH)');
        expect(modTapKey).toBeDefined();

        // Clicking the Mod-Tap key assigns LCTL_T(KC_SLASH)
        fireEvent.click(modTapKey!);
        expect(assignKeycode).toHaveBeenCalledWith('LCTL_T(KC_SLASH)');
    });

    it('decomposes existing modifier in combo slot (e.g. LCTL(KC_SLASH)) to extract base keycode', () => {
        // Select combo 1, slot 1 which already has 'LCTL(KC_SLASH)'
        binding.selectedTarget = { type: 'combo', comboId: 1, comboSlot: 1 };
        render(<BasicKeyboards />);

        // Activate Ctrl modifier
        fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));

        // The Mod-Tap key should extract the base keycode 'KC_SLASH' and build LCTL_T(KC_SLASH)
        const modTapKey = screen.getAllByTestId('key').find((el) => el.getAttribute('data-keycode') === 'LCTL_T(KC_SLASH)');
        expect(modTapKey).toBeDefined();

        fireEvent.click(modTapKey!);
        expect(assignKeycode).toHaveBeenCalledWith('LCTL_T(KC_SLASH)');
    });

    it('follows right-hand modifier in combo slot (e.g. RCTL(KC_SLASH)) and builds RCTL_T(KC_SLASH)', () => {
        // Select combo 2, slot 1 which has 'RCTL(KC_SLASH)'
        binding.selectedTarget = { type: 'combo', comboId: 2, comboSlot: 1 };
        render(<BasicKeyboards />);

        // Modifier side toggle should automatically switch to 'R'
        const rToggle = screen.getByRole('button', { name: 'R' });
        expect(rToggle).toHaveAttribute('aria-pressed', 'true');

        // Activate Ctrl modifier
        fireEvent.click(screen.getByRole('button', { name: /^ctrl$/i }));

        // Mod-Tap button should build RCTL_T(KC_SLASH)
        const modTapKey = screen.getAllByTestId('key').find((el) => el.getAttribute('data-keycode') === 'RCTL_T(KC_SLASH)');
        expect(modTapKey).toBeDefined();

        fireEvent.click(modTapKey!);
        expect(assignKeycode).toHaveBeenCalledWith('RCTL_T(KC_SLASH)');
    });
});
