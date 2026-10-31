import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPanel from '../../src/layout/SecondarySidebar/Panels/SettingsPanel';
import { SETTINGS } from '../../src/contexts/SettingsContext';
import { SETTINGS_PAGE } from '../../src/layout/SecondarySidebar/Panels/settings/layout';
import { highlightParts, searchSettings } from '../../src/layout/SecondarySidebar/Panels/settings/search';

const state = vi.hoisted(() => ({ stored: {} as Record<string, string | number | boolean> }));
vi.mock('../../src/layout/SecondarySidebar/Panels/ClustersPanel', () => ({ default: () => <p>Hardware rows</p> }));
vi.mock('../../src/layout/SecondarySidebar/Panels/TypingBehaviorPanel', () => ({ default: () => <p>Typing behavior rows</p> }));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard: null, isConnected: true }) }));
vi.mock('@/contexts/LayoutSettingsContext', () => ({ useLayoutSettings: () => ({ layoutMode: 'sidebar' }) }));
vi.mock('@/contexts/PanelsContext', () => ({ usePanels: () => ({ setActivePanel: vi.fn() }) }));
vi.mock('@/App', () => ({ useNavigation: () => ({ navigateTo: vi.fn() }) }));
vi.mock('@/hooks/useLayoutImport', () => ({ useLayoutImport: () => ({}) }));
vi.mock('@/contexts/SettingsContext', async (orig) => {
    const actual = await orig<typeof import('../../src/contexts/SettingsContext')>();
    const lookup = (name: string) => actual.SETTINGS.find((s) => s.name === name);
    return {
        ...actual,
        useSettings: () => ({
            getSetting: (name: string, fallback: unknown) => state.stored[name] ?? fallback,
            updateSetting: (name: string, value: string | number | boolean) => { state.stored[name] = value; },
            getSettingDefinition: lookup,
        }),
    };
});
vi.mock('../../src/layout/SecondarySidebar/Panels/BoardIdentitySection', () => ({ default: () => <p>Board identity</p> }));
vi.mock('../../src/layout/SecondarySidebar/Panels/BackupsSection', () => ({
    default: () => <p>Backup list</p>,
}));
vi.mock('../../src/layout/SecondarySidebar/Panels/settings/FirmwareRow', () => ({ default: () => <p>Firmware status</p> }));
vi.mock('../../src/components/ExportDialog', () => ({ default: () => null }));

beforeEach(() => { state.stored = {}; });

const lookup = (name: string) => SETTINGS.find((s) => s.name === name);
const sectionTitles = () => screen.queryAllByRole('heading', { level: 4 }).map((h) => h.textContent);
const search = () => screen.getByRole('textbox', { name: 'Search settings' });
const type = (value: string) => fireEvent.change(search(), { target: { value } });

describe('Settings search', () => {
    it('finds the theme for "dark", highlights it, and hides everything else', () => {
        render(<SettingsPanel />);
        type('dark');
        expect(sectionTitles()).toEqual(['Appearance and editing']);
        const appearance = screen.getByRole('region', { name: 'Appearance and editing' });
        expect(within(appearance).getByRole('combobox', { name: 'Theme' })).toBeVisible();
        expect(within(appearance).queryByRole('combobox', { name: 'Key size' })).toBeNull();
        expect(within(appearance).getByText('dark', { selector: 'mark' })).toBeVisible();
        expect(screen.queryByRole('heading', { level: 3, name: 'This keyboard' })).toBeNull();
    });

    it('finds Firmware for "update"', () => {
        render(<SettingsPanel />);
        type('update');
        expect(sectionTitles()).toEqual(['Firmware']);
        expect(screen.getByText('Firmware status')).toBeVisible();
        expect(screen.queryByText('Backup list')).toBeNull();
    });

    it('finds Backups for "restore", and opens the backups list', () => {
        render(<SettingsPanel />);
        expect(screen.queryByText('Backup list')).toBeNull();
        type('restore');
        expect(sectionTitles()).toEqual(['Backups']);
        expect(screen.getByText('Backup list')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Import layout' })).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Export layout' })).toBeNull();
    });

    it('shows the whole section when its title matches, with the match marked', () => {
        render(<SettingsPanel />);
        type('backup');
        expect(sectionTitles()).toEqual(['Backups']);
        expect(screen.getByRole('button', { name: 'Export layout' })).toBeVisible();
        expect(screen.getByText('Backup list')).toBeVisible();
        expect(screen.queryByText('Firmware status')).toBeNull();
        expect(screen.getByRole('heading', { level: 4 }).querySelector('mark')?.textContent).toBe('Backup');
    });

    it('opens a collapsed section it finds a match in', () => {
        render(<SettingsPanel />);
        expect(screen.queryByRole('button', { name: 'Scan Lab' })).toBeNull();
        type('scan');
        expect(sectionTitles()).toEqual(['About']);
        expect(screen.getByRole('button', { name: 'Scan Lab' })).toBeVisible();
        expect(state.stored['settings-about-open']).toBeUndefined();
    });

    it('says when nothing matched, and clears from there', () => {
        render(<SettingsPanel />);
        type('zzzz');
        expect(sectionTitles()).toEqual([]);
        expect(screen.getByRole('status')).toHaveTextContent('Nothing in Settings matches “zzzz”.');
        fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Clear search' }));
        expect(search()).toHaveValue('');
        expect(sectionTitles()).toHaveLength(6);
    });

    it('clears on Esc', () => {
        render(<SettingsPanel />);
        type('editing');
        expect(sectionTitles()).toEqual(['Appearance and editing']);
        fireEvent.keyDown(search(), { key: 'Escape' });
        expect(search()).toHaveValue('');
        expect(sectionTitles()).toHaveLength(6);
    });

    it('focuses the field on "/" or Ctrl+F inside Settings, without taking "/" from a text field', () => {
        render(<SettingsPanel />);
        const chip = within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Hardware' });
        chip.focus();
        const slash = fireEvent.keyDown(chip, { key: '/' });
        expect(slash).toBe(false); // default prevented
        expect(search()).toHaveFocus();
        chip.focus();
        fireEvent.keyDown(chip, { key: 'f', ctrlKey: true });
        expect(search()).toHaveFocus();
        expect(fireEvent.keyDown(search(), { key: '/' })).toBe(true);
    });

    it('leaves keys outside Settings alone', () => {
        render(<><button type="button">Elsewhere</button><SettingsPanel /></>);
        const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
        elsewhere.focus();
        expect(fireEvent.keyDown(elsewhere, { key: '/' })).toBe(true);
        expect(elsewhere).toHaveFocus();
    });

    it('dims chips with no match, and a chip clears the search to jump', () => {
        Element.prototype.scrollIntoView = vi.fn();
        render(<SettingsPanel />);
        type('dark');
        const nav = screen.getByRole('navigation', { name: 'Settings sections' });
        expect(within(nav).getByRole('button', { name: 'Firmware' })).toHaveClass('opacity-50');
        expect(within(nav).getByRole('button', { name: 'Appearance' })).not.toHaveClass('opacity-50');
        fireEvent.click(within(nav).getByRole('button', { name: 'About' }));
        expect(search()).toHaveValue('');
        expect(sectionTitles()).toHaveLength(6);
    });
});

describe('searchSettings', () => {
    it('returns null for an empty query', () => {
        expect(searchSettings(SETTINGS_PAGE, '   ', lookup)).toBeNull();
    });

    it('needs every word, found in the row or its section', () => {
        const hits = searchSettings(SETTINGS_PAGE, 'combo colors', lookup)!;
        expect([...hits.keys()]).toEqual(['appearance']);
        expect([...hits.get('appearance')!.rows]).toEqual(['colorblind-combo-colors']);
        expect(searchSettings(SETTINGS_PAGE, 'appearance size', lookup)!.get('appearance')!.rows.has('key-size')).toBe(true);
    });

    it('finds option names and synonyms', () => {
        expect([...searchSettings(SETTINGS_PAGE, 'azerty', lookup)!.keys()]).toEqual(['appearance']);
        expect([...searchSettings(SETTINGS_PAGE, 'discord', lookup)!.keys()]).toEqual(['about']);
    });
});

describe('Hardware and Typing behavior in search', () => {
    it.each(['trackball', 'cluster', 'ball color', 'fragments'])('finds Hardware for "%s"', (q) => {
        render(<SettingsPanel />);
        type(q);
        expect(sectionTitles()).toContain('Hardware');
        expect(screen.getByText('Hardware rows')).toBeVisible();
    });

    it.each(['tapping term', 'auto shift', 'permissive hold', 'grave escape', 'one shot'])('finds and opens Typing behavior for "%s"', (q) => {
        render(<SettingsPanel />);
        expect(screen.queryByText('Typing behavior rows')).toBeNull();
        type(q);
        expect(sectionTitles()).toContain('Typing behavior');
        expect(screen.getByText('Typing behavior rows')).toBeVisible();
    });

    it('finds each in its own card only', () => {
        const page = SETTINGS_PAGE;
        expect([...searchSettings(page, 'touchpad', lookup)!.keys()]).toEqual(['hardware', 'touchpad']);
        expect([...searchSettings(page, 'dead zone', lookup)!.keys()]).toEqual(['touchpad']);
        expect([...searchSettings(page, 'tapping term', lookup)!.keys()]).toEqual(['typing']);
    });
});

describe('highlightParts', () => {
    it('marks each term, ignoring case', () => {
        expect(highlightParts('Light or dark mode', 'DARK light')).toEqual([
            { text: 'Light', match: true }, { text: ' or ', match: false }, { text: 'dark', match: true }, { text: ' mode', match: false },
        ]);
    });

    it('treats regex characters as text', () => {
        expect(highlightParts('a.b', '.')).toEqual([{ text: 'a', match: false }, { text: '.', match: true }, { text: 'b', match: false }]);
    });
});
