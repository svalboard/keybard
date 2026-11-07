import type { KeyboardInfo } from '@/types/keyboard.types';
import { getKeyDisplayText } from '@/utils/key-display';
import { keyService } from '@/services/key.service';
import { getLabelForKeycode } from '@/components/Keyboards/layouts';
import { getKeyLabel } from '@/utils/layers';
import { altgrOnlyLegend, dualLegendFor, hasAltGr, type DualLegend, type LegendOptions } from '@/lib/shiftedLegends';
import { geometry, resolveBinding } from './core';

/** What Keybard's Settings decide about legends, sent by Keybard: Shifted Key Symbols and AltGr Symbols. Both off when absent (an older Overlay app sends neither). */
export type SurfaceLegendOptions = Pick<LegendOptions, 'shifted' | 'altgr'>;
export function surfaceKeys(board: KeyboardInfo & { trainerLabels?: Record<string, string> }, active: number, defaults: number, hands: string, layoutId = 'us', modifiers?: { shift: boolean; capsLock: boolean } | null, legends: SurfaceLegendOptions = {}) {
    const wantShifted = legends.shifted === true, wantAltGr = legends.altgr === true;
    if (!board.keymap?.length) return [];
    return geometry(board).filter(k => hands === 'Both' || k.hand === hands).map(k => {
        const binding = resolveBinding(board.keymap!, k.id, active, defaults);
        const keycode = keyService.stringify(binding.code);
        const { label: defaultLabel, keyContents } = getKeyLabel(board, binding.code);
        const label = getLabelForKeycode(keycode, layoutId) || defaultLabel;
        const text = getKeyDisplayText(keycode, label, keyContents, false, layoutId);
        let letter = text.displayLabel;
        const baseCode = ['modmask', 'modtap', 'layerhold'].includes(keyContents?.type || '') ? binding.code & 0xff : binding.code;
        const base = keyService.stringify(baseCode);
        if (modifiers) {
            // Only character-producing bindings follow the host state. Behavior IDs are not letters.
            const plain = getLabelForKeycode(base, layoutId);
            const assignedShift = keyContents?.type === 'modmask' && !!(binding.code & 0x0200);
            const shifted = modifiers.shift || assignedShift;
            if (plain?.length === 1 && baseCode >= 4 && baseCode <= 56) {
                letter = shifted ? getLabelForKeycode(`LSFT(${base})`, layoutId) || plain : plain;
                if (plain.toLowerCase() !== plain.toUpperCase()) {
                    letter = shifted !== modifiers.capsLock ? plain.toUpperCase() : plain.toLowerCase();
                }
            }
        } else if (/^[a-z]$/.test(letter)) letter = letter.toUpperCase();
        // Function-key names are labels, never case-sensitive character output.
        if (/^KC_F(?:[1-9]|1[0-9]|2[0-4])$/.test(base)) letter = base.slice(3);
        const names: Record<string, string> = { esc: 'Escape', escape: 'Escape', del: 'Delete', delete: 'Delete',
            shift: 'Shift', lsft: 'Shift', rsft: 'Shift', lshift: 'Shift', rshift: 'Shift', 'l shift': 'Shift', 'r shift': 'Shift',
            ctrl: 'Control', control: 'Control', lctl: 'Control', rctl: 'Control', lctrl: 'Control', rctrl: 'Control', 'l ctrl': 'Control', 'r ctrl': 'Control',
            alt: 'Alt', lalt: 'Alt', ralt: 'Alt', 'l alt': 'Alt', 'r alt': 'Alt', 'l gui': 'gui', 'r gui': 'gui', caps: 'Caps', capslock: 'Caps', 'caps lock': 'Caps',
            enter: 'Enter', tab: 'Tab', space: 'Space', backsp: 'Backspace', bspc: 'Backspace', backspace: 'Backspace' };
        letter = names[letter.toLowerCase()] || letter;
        // Host-only behavior definitions can supply details absent from the editor snapshot.
        const deviceLabel = board.trainerLabels?.[String(binding.code)];
        const needsDeviceLabel = (keycode.startsWith('TD(') && !board.tapdances?.length) ||
            ((binding.code >= 0x7e00 && binding.code <= 0x7fff) && !board.custom_keycodes?.length);
        // The keycap grid and the AltGr character, from the same code Keybard's keys use. A key typing
        // its shifted symbol (Shift held on this board, or Shift assigned to the key) keeps one legend.
        const assignedShiftKey = keyContents?.type === 'modmask' && !!(binding.code & 0x0200);
        let dual: DualLegend | null = modifiers?.shift || assignedShiftKey ? null : dualLegendFor(keycode, label, keyContents, layoutId, { shifted: wantShifted, altgr: wantAltGr });
        // A letter's capital (top left) follows the case the other letters draw (lowercase unless Shift or Caps Lock).
        if (dual?.letter && dual.shifted && letter === letter.toLowerCase() && letter !== letter.toUpperCase()) dual = { ...dual, shifted: dual.shifted.toLowerCase() };
        // With AltGr Symbols on, RALT(KC_2) shows the character it types, and KC_RALT is labeled AltGr.
        const altgrOnly = wantAltGr ? altgrOnlyLegend(keycode, keyContents, layoutId) : null;
        const isAltGrKey = wantAltGr && keycode === 'KC_RALT' && hasAltGr(layoutId);
        if (altgrOnly) { text.bottomStr = ''; letter = altgrOnly; }
        if (isAltGrKey) { text.topLabel = ''; text.bottomStr = ''; letter = 'AltGr'; }
        return { ...k, ...binding, legend: { keycode, keyContents, ...text, ...(dual ? { dual } : {}), displayLabel: needsDeviceLabel && deviceLabel && keyContents?.type !== 'tapdance' ? deviceLabel : letter }, label: needsDeviceLabel && deviceLabel ? deviceLabel :
            [text.topLabel, letter, text.bottomStr].filter(Boolean).join('\n') };
    });
}
