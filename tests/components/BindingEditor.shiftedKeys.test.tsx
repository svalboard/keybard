import { describe, it, expect } from 'vitest';
import { getKeyDisplayLabel, getKeyDisplayText } from '@/utils/key-display';
import { getHeaderIcons, getCenterContent } from '@/utils/key-icons';
import { shortKeyName } from '@/utils/combo-labels';
import { getKeyContents } from '@/utils/keys';
import type { KeyboardInfo } from '@/types/keyboard.types';

describe('Shifted symbol resolution in binding editors and panels', () => {
    const mockKeyboard = {
        cosmetic: {},
        combos: [
            {
                cmbid: 0,
                keys: ['LSFT(KC_COMMA)', 'KC_LT', 'LSFT(KC_DOT)', 'LSFT(KC_SLASH)'],
                output: 'LSFT(KC_COMMA)',
                options: 0,
            },
            {
                cmbid: 1,
                keys: ['KC_PLUS', 'LSFT(KC_EQUAL)', 'LSFT(KC_EQL)', 'KC_NO'],
                output: 'KC_PLUS',
                options: 0,
            },
        ],
    } as any as KeyboardInfo;

    it('resolves shifted symbol labels correctly via getKeyDisplayLabel', () => {
        const commaContents = getKeyContents(mockKeyboard, 'LSFT(KC_COMMA)');
        expect(getKeyDisplayLabel('LSFT(KC_COMMA)', commaContents, 'us')).toBe('<');

        const ltContents = getKeyContents(mockKeyboard, 'KC_LT');
        expect(getKeyDisplayLabel('KC_LT', ltContents, 'us')).toBe('<');

        const dotContents = getKeyContents(mockKeyboard, 'LSFT(KC_DOT)');
        expect(getKeyDisplayLabel('LSFT(KC_DOT)', dotContents, 'us')).toBe('>');

        const slashContents = getKeyContents(mockKeyboard, 'LSFT(KC_SLASH)');
        expect(getKeyDisplayLabel('LSFT(KC_SLASH)', slashContents, 'us')).toBe('?');

        const exlmContents = getKeyContents(mockKeyboard, 'LSFT(KC_1)');
        expect(getKeyDisplayLabel('LSFT(KC_1)', exlmContents, 'us')).toBe('!');

        // + symbol resolutions (KC_PLUS, LSFT(KC_EQUAL), LSFT(KC_EQL))
        const plusContents = getKeyContents(mockKeyboard, 'KC_PLUS');
        expect(getKeyDisplayLabel('KC_PLUS', plusContents, 'us')).toBe('+');

        const lsftEqualContents = getKeyContents(mockKeyboard, 'LSFT(KC_EQUAL)');
        expect(getKeyDisplayLabel('LSFT(KC_EQUAL)', lsftEqualContents, 'us')).toBe('+');

        const lsftEqlContents = getKeyContents(mockKeyboard, 'LSFT(KC_EQL)');
        expect(getKeyDisplayLabel('LSFT(KC_EQL)', lsftEqlContents, 'us')).toBe('+');

        // Letters keep their uppercase form
        const aContents = getKeyContents(mockKeyboard, 'LSFT(KC_A)');
        expect(getKeyDisplayLabel('LSFT(KC_A)', aContents, 'us')).toBe('A');
    });

    it('cleans shift badge for symbols and preserves it for letters in getKeyDisplayText', () => {
        const commaContents = getKeyContents(mockKeyboard, 'LSFT(KC_COMMA)');
        const commaText = getKeyDisplayText('LSFT(KC_COMMA)', '', commaContents, false, 'us');
        expect(commaText.displayLabel).toBe('<');
        expect(commaText.bottomStr).toBe(''); // Badge hidden because '<' already denotes Shift+,

        const plusContents = getKeyContents(mockKeyboard, 'LSFT(KC_EQUAL)');
        const plusText = getKeyDisplayText('LSFT(KC_EQUAL)', '', plusContents, false, 'us');
        expect(plusText.displayLabel).toBe('+');
        expect(plusText.bottomStr).toBe('');

        const plusAliasText = getKeyDisplayText('LSFT(KC_EQL)', '', getKeyContents(mockKeyboard, 'LSFT(KC_EQL)'), false, 'us');
        expect(plusAliasText.displayLabel).toBe('+');
        expect(plusAliasText.bottomStr).toBe('');

        const aContents = getKeyContents(mockKeyboard, 'LSFT(KC_A)');
        const aText = getKeyDisplayText('LSFT(KC_A)', '', aContents, false, 'us');
        expect(aText.displayLabel).toBe('A');
        expect(aText.bottomStr).toBe('LSFT'); // Badge retained for letter modifiers
    });

    it('resolves mouse button keys (e.g. Mouse 1) with mouse header icons and labels', () => {
        const btn1Contents = getKeyContents(mockKeyboard, 'KC_BTN1');
        expect(getKeyDisplayLabel('KC_BTN1', btn1Contents, 'us')).toBe('Mouse 1');

        const btn2Contents = getKeyContents(mockKeyboard, 'KC_BTN2');
        expect(getKeyDisplayLabel('KC_BTN2', btn2Contents, 'us')).toBe('Mouse 2');

        const msUpContents = getKeyContents(mockKeyboard, 'KC_MS_U');
        expect(getKeyDisplayLabel('KC_MS_U', msUpContents, 'us')).toBe('Mouse Up');

        // Header icons recognizes mouse from both label and keycode
        const headerWithLabel = getHeaderIcons('KC_BTN1', 'Mouse 1');
        expect(headerWithLabel.isMouse).toBe(true);
        expect(headerWithLabel.icons.length).toBe(1);

        const headerWithoutLabel = getHeaderIcons('KC_BTN1', '1');
        expect(headerWithoutLabel.isMouse).toBe(true);
        expect(headerWithoutLabel.icons.length).toBe(1);

        // Center content strips 'Mouse' and shows button number '1'
        const center = getCenterContent('Mouse 1', 'KC_BTN1', true);
        expect(center).toBe('1');

        // Short key name for combo readouts and labels
        expect(shortKeyName('KC_BTN1')).toBe('Mouse 1');
        expect(shortKeyName('KC_MS_BTN1')).toBe('Mouse 1');
    });
});
