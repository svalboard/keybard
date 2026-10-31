import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../../src/contexts/SettingsContext';
import { HARDWARE_OPEN_SETTING, SETTINGS_PAGE, SETTINGS_SHOWN_ELSEWHERE, blocksOnPage, sectionStateSetting, settingsOnPage, CONDITIONAL_SECTIONS } from '../../src/layout/SecondarySidebar/Panels/settings/layout';

describe('Settings page declaration', () => {
    const onPage = settingsOnPage();

    it('names only settings that exist, each once', () => {
        const names = new Set(SETTINGS.map((s) => s.name));
        for (const name of onPage) expect(names.has(name), name).toBe(true);
        expect(new Set(onPage).size).toBe(onPage.length);
    });

    it('never places board configuration on the page', () => {
        for (const name of onPage) {
            expect(SETTINGS.find((s) => s.name === name)?.scope, name).not.toBe('hardware');
        }
    });

    it('places every setting on the page or names its one home elsewhere, never both', () => {
        for (const def of SETTINGS) {
            const here = onPage.includes(def.name);
            const elsewhere = def.name in SETTINGS_SHOWN_ELSEWHERE;
            expect(here || elsewhere, `${def.name} needs a row in settings/layout.ts or an entry in SETTINGS_SHOWN_ELSEWHERE`).toBe(true);
            expect(here && elsewhere, def.name).toBe(false);
        }
    });

    it('leaves out the retired settings: binding editor placement, ball gloss and sparkle', () => {
        for (const name of ['combo-editor-placement', 'pointing-ball-gloss', 'pointing-sparkle']) {
            expect(onPage).not.toContain(name);
            expect(SETTINGS.find((s) => s.name === name), name).toBeUndefined();
        }
    });

    it('is seven cards, each with a chip, a summary and a sentence-case title', () => {
        expect(SETTINGS_PAGE.map((s) => s.title)).toEqual(['Hardware', 'Touchpad tuning', 'Firmware', 'Backups', 'Appearance and editing', 'Typing behavior', 'About']);
        expect(SETTINGS_PAGE.map((s) => s.chip)).toEqual(['Hardware', 'Touchpad', 'Firmware', 'Backups', 'Appearance', 'Typing', 'About']);
        for (const s of SETTINGS_PAGE) {
            expect(s.summary, s.id).not.toBe('');
            expect(s.title.slice(1), s.title).toBe(s.title.slice(1).toLowerCase());
        }
    });

    it('keeps Firmware to firmware, and backups, import and export in Backups', () => {
        const rows = (id: string) => SETTINGS_PAGE.find((s) => s.id === id)!.rows.map((r) => ('block' in r ? `block:${r.block}` : r.setting));
        expect(rows('firmware')).toEqual(['block:firmware']);
        expect(rows('backups')).toEqual(['block:backups', 'import', 'export']);
    });

    it('holds Hardware, Typing behavior and every block once', () => {
        expect([...blocksOnPage()].sort()).toEqual(['about', 'backups', 'board', 'firmware', 'hardware', 'touchpad', 'typing']);
    });

    it('shows Touchpad tuning only on some boards, beside Hardware', () => {
        expect([...CONDITIONAL_SECTIONS]).toEqual(['touchpad']);
        expect(SETTINGS_PAGE.findIndex((s) => s.id === 'touchpad')).toBe(SETTINGS_PAGE.findIndex((s) => s.id === 'hardware') + 1);
        expect(SETTINGS_PAGE.find((s) => s.id === 'touchpad')!.rows).toEqual([{ block: 'touchpad' }]);
    });

    it('opens only Hardware, and the one-line Touchpad tuning entry, on a first visit', () => {
        expect(SETTINGS_PAGE.filter((s) => s.defaultOpen).map((s) => s.id)).toEqual(['hardware', 'touchpad']);
    });

    it('remembers each card under its own setting, Hardware under the one it already used', () => {
        expect(sectionStateSetting('hardware')).toBe(HARDWARE_OPEN_SETTING);
        expect(HARDWARE_OPEN_SETTING).toBe('settings-hardware-open');
        const keys = SETTINGS_PAGE.map((s) => sectionStateSetting(s.id));
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of keys) expect(SETTINGS.find((d) => d.name === key), key).toBeUndefined();
    });
});
