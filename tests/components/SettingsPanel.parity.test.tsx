import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPanel from '../../src/layout/SecondarySidebar/Panels/SettingsPanel';
import { SETTINGS } from '../../src/contexts/SettingsContext';
import { CONDITIONAL_SECTIONS, SETTINGS_PAGE as DECLARED, sectionStateSetting } from '../../src/layout/SecondarySidebar/Panels/settings/layout';

// These boards have no touchpad: Touchpad tuning isn't on their page.
const SETTINGS_PAGE = DECLARED.filter((s) => !(CONDITIONAL_SECTIONS as readonly string[]).includes(s.id));
import { requestSettingsSection } from '../../src/layout/SecondarySidebar/Panels/settings/anchor';

const state = vi.hoisted(() => ({
    mode: 'sidebar', navigate: vi.fn(), navigateTo: vi.fn(), connected: true, firmwareDot: false,
    stored: {} as Record<string, string | number | boolean>, storageFails: false,
}));
vi.mock('../../src/layout/SecondarySidebar/Panels/ClustersPanel', () => ({ default: () => <p>Hardware rows</p> }));
vi.mock('../../src/layout/SecondarySidebar/Panels/TypingBehaviorPanel', () => ({ default: () => <p>Typing behavior rows</p> }));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard: null, isConnected: state.connected }) }));
vi.mock('@/contexts/LayoutSettingsContext', () => ({ useLayoutSettings: () => ({ layoutMode: state.mode }) }));
vi.mock('@/contexts/PanelsContext', () => ({ usePanels: () => ({ setActivePanel: state.navigate }) }));
vi.mock('@/App', () => ({ useNavigation: () => ({ navigateTo: state.navigateTo }) }));
vi.mock('@/hooks/useLayoutImport', () => ({ useLayoutImport: () => ({}) }));
vi.mock('@/features/firmware/FirmwareUpdateProvider', () => ({ useFirmwareUpdates: () => ({ status: { dot: state.firmwareDot } }) }));
vi.mock('@/contexts/SettingsContext', async (orig) => {
    const actual = await orig<typeof import('../../src/contexts/SettingsContext')>();
    const failing = (name: string) => state.storageFails && name.startsWith('settings-') && name.endsWith('-open');
    return {
        ...actual,
        useSettings: () => ({
            // Like the app: a setting never stored, with no definition, reads as false.
            getSetting: (name: string, fallback: unknown) => {
                if (failing(name)) throw new Error('storage unavailable');
                return state.stored[name] ?? fallback ?? false;
            },
            updateSetting: (name: string, value: string | number | boolean) => {
                if (failing(name)) throw new Error('storage unavailable');
                state.stored[name] = value;
            },
            getSettingDefinition: (name: string) => actual.SETTINGS.find((s) => s.name === name),
        }),
    };
});
vi.mock('../../src/layout/SecondarySidebar/Panels/BoardIdentitySection', () => ({ default: () => <p>Board identity</p> }));
vi.mock('../../src/layout/SecondarySidebar/Panels/BackupsSection', () => ({ default: () => <p>Backup list</p> }));
vi.mock('../../src/layout/SecondarySidebar/Panels/settings/FirmwareRow', () => ({ default: () => <p>Firmware status</p> }));
vi.mock('../../src/components/ExportDialog', () => ({ default: ({ open }: { open: boolean }) => (open ? <p>Export dialog</p> : null) }));

let raf: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.clearAllMocks();
    state.stored = {}; state.connected = true; state.mode = 'sidebar'; state.storageFails = false; state.firmwareDot = false;
    Element.prototype.scrollIntoView = vi.fn();
    raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
});
afterEach(() => raf.mockRestore());

const TITLES = ['Hardware', 'Firmware', 'Backups', 'Appearance and editing', 'Typing behavior', 'About'];
const toggle = (title: string) => within(screen.getByRole('heading', { level: 4, name: title })).getByRole('button');
const expanded = (title: string) => toggle(title).getAttribute('aria-expanded') === 'true';
const openCard = (title: string) => { if (!expanded(title)) fireEvent.click(toggle(title)); };
const chips = () => screen.getByRole('navigation', { name: 'Settings sections' });

describe('Settings page', () => {
    it('is one short list of cards, in order, with a chip for each', () => {
        render(<SettingsPanel />);
        expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(TITLES);
        expect(within(chips()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Hardware', 'Firmware', 'Backups', 'Appearance', 'Typing', 'About']);
        expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    });

    it('starts with Hardware open and every other card collapsed on a first visit', () => {
        render(<SettingsPanel />);
        expect(TITLES.map((t) => [t, expanded(t)])).toEqual([
            ['Hardware', true], ['Firmware', false], ['Backups', false], ['Appearance and editing', false], ['Typing behavior', false], ['About', false],
        ]);
        expect(screen.getByText('Hardware rows')).toBeVisible();
        expect(screen.queryByText('Typing behavior rows')).toBeNull();
        expect(screen.queryByText('Firmware status')).toBeNull();
    });

    it('holds the board setup, and no layout configuration', () => {
        render(<SettingsPanel />);
        TITLES.forEach(openCard);
        for (const text of ['Hardware rows', 'Firmware status', 'Board identity', 'Backup list', 'Typing behavior rows']) {
            expect(screen.getByText(text)).toBeVisible();
        }
        const body = document.body.textContent ?? '';
        for (const banned of ['QMK Settings', 'DPI', 'Layer color', 'Brightness', 'Live Updating', 'Overlay', 'Combo timeout',
            'Leader', 'Mouse key', 'Print Layers']) {
            expect(body).not.toContain(banned);
        }
        for (const def of SETTINGS.filter((s) => s.scope === 'hardware')) {
            expect(screen.queryByText(def.label)).toBeNull();
        }
    });

    it('shows each Appearance and Editing preference under its page label', () => {
        render(<SettingsPanel />);
        openCard('Appearance and editing');
        const card = screen.getByRole('region', { name: 'Appearance and editing' });
        expect(within(card).getByRole('combobox', { name: 'Theme' })).toBeVisible();
        expect(within(card).getByRole('combobox', { name: 'Key size' })).toHaveValue('auto');
        expect(within(card).getByRole('combobox', { name: 'Panel position' })).toHaveValue('auto');
        expect(within(card).getByRole('group', { name: 'Typing binds a key' })).toBeVisible();
        expect(within(card).getByRole('combobox', { name: 'Advance after assigning' })).toBeVisible();
        expect(within(card).getByRole('combobox', { name: 'Key legends' })).toBeVisible();
    });

    it('has no Large option, no gloss or sparkle slider, and combo indicators as an on/off switch', () => {
        render(<SettingsPanel />);
        TITLES.forEach(openCard);
        expect(screen.queryByRole('option', { name: 'Large' })).toBeNull();
        expect(screen.queryAllByRole('slider')).toHaveLength(0);
        expect(screen.queryByText(/gloss|sparkle/i)).toBeNull();
        expect(screen.queryByText(/Binding editor placement/i)).toBeNull();
        const card = screen.getByRole('region', { name: 'Appearance and editing' });
        const combo = within(card).getByRole('group', { name: 'Combo indicators' });
        expect(within(combo).getByRole('button', { name: 'ON' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(within(combo).getByRole('button', { name: 'OFF' }));
        expect(state.stored['combo-indicators']).toBe(false);
        expect(within(card).getByRole('group', { name: 'Colorblind-friendly combo colors' })).toBeVisible();
    });

    it('stores a changed preference', () => {
        render(<SettingsPanel />);
        openCard('Appearance and editing');
        fireEvent.change(screen.getByRole('combobox', { name: 'Key size' }), { target: { value: 'small' } });
        expect(state.stored['key-size']).toBe('small');
    });

    it('keeps Firmware to firmware: backups, import and export are in Backups', () => {
        render(<SettingsPanel />);
        openCard('Firmware');
        const firmware = screen.getByRole('region', { name: 'Firmware' });
        expect(within(firmware).getByText('Firmware status')).toBeVisible();
        for (const text of ['Backup list', 'Import layout', 'Export layout', 'Board identity']) expect(within(firmware).queryByText(text)).toBeNull();
        openCard('Backups');
        const backups = screen.getByRole('region', { name: 'Backups' });
        for (const text of ['Backup list', 'Import layout', 'Export layout']) expect(within(backups).getByText(text)).toBeVisible();
        expect(within(screen.getByRole('region', { name: 'Hardware' })).getByText('Board identity')).toBeVisible();
    });

    it('opens the one Export dialog from Backups', () => {
        render(<SettingsPanel />);
        openCard('Backups');
        expect(screen.queryByText('Export dialog')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Export layout' }));
        expect(screen.getByText('Export dialog')).toBeVisible();
        expect(screen.queryByRole('button', { name: /Print/ })).toBeNull();
    });

    it('keeps the developer tools in About', () => {
        render(<SettingsPanel />);
        expect(screen.queryByRole('button', { name: 'Scan Lab' })).toBeNull();
        openCard('About');
        fireEvent.click(screen.getByRole('button', { name: 'Scan Lab' }));
        expect(state.navigate).toHaveBeenCalledWith('scanlab');
        fireEvent.click(screen.getByRole('button', { name: 'Key proof sheet' }));
        expect(state.navigateTo).toHaveBeenCalledWith('proof-sheet');
    });

    it.each(['sidebar', 'bottombar'])('renders the same page in %s mode', (mode) => {
        state.mode = mode;
        render(<SettingsPanel />);
        expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(6);
        expect(chips()).toBeVisible();
    });

    it('asks for a connection where the board is needed', () => {
        state.connected = false;
        render(<SettingsPanel />);
        openCard('Hardware');
        expect(screen.getByText('Connect a keyboard to see its name and serial.')).toBeVisible();
        expect(screen.queryByText('Board identity')).toBeNull();
    });
});

describe('jump chips', () => {
    it.each(SETTINGS_PAGE.map((s) => [s.chip, s.title, s.id]))('%s opens and scrolls to %s, for this visit only', (chip, title, id) => {
        const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
        state.stored[sectionStateSetting(id)] = 'collapsed';
        const view = render(<SettingsPanel />);
        expect(expanded(title)).toBe(false);
        fireEvent.click(within(chips()).getByRole('button', { name: chip }));
        expect(expanded(title)).toBe(true);
        expect(scroll.mock.contexts.at(-1)).toBe(document.getElementById(`settings-section-${id}`));
        expect(state.stored[sectionStateSetting(id)]).toBe('collapsed');
        view.unmount();
        render(<SettingsPanel />);
        expect(expanded(title)).toBe(false);
    });

    it('marks Firmware and opens it for this visit when an update is available', () => {
        state.firmwareDot = true;
        render(<SettingsPanel />);
        expect(within(chips()).getByRole('button', { name: 'Firmware, update available' })).toBeVisible();
        expect(expanded('Firmware')).toBe(true);
        expect(expanded('Backups')).toBe(false);
        expect(state.stored[sectionStateSetting('firmware')]).toBeUndefined();
    });
});

describe('every card remembers whether it was left open or collapsed', () => {
    it.each(SETTINGS_PAGE.map((s) => [s.title, s.id, s.defaultOpen] as const))('%s: as declared on a first visit, then as it was left', (title, id, defaultOpen) => {
        const key = sectionStateSetting(id);
        const view = render(<SettingsPanel />);
        expect(expanded(title)).toBe(defaultOpen);
        fireEvent.click(toggle(title));
        expect(expanded(title)).toBe(!defaultOpen);
        expect(state.stored[key]).toBe(defaultOpen ? 'collapsed' : 'open');
        view.unmount();
        const again = render(<SettingsPanel />);
        expect(expanded(title)).toBe(!defaultOpen);
        fireEvent.click(toggle(title));
        expect(state.stored[key]).toBe(defaultOpen ? 'open' : 'collapsed');
        again.unmount();
        render(<SettingsPanel />);
        expect(expanded(title)).toBe(defaultOpen);
    });

    it.each([['typing', 'Typing behavior'], ['hardware', 'Hardware'], ['backups', 'Backups'], ['firmware', 'Firmware']])('an old link to %s opens it for the visit without changing what is remembered', (id, title) => {
        state.stored[sectionStateSetting(id)] = 'collapsed';
        requestSettingsSection(id);
        const view = render(<SettingsPanel />);
        expect(expanded(title)).toBe(true);
        expect(state.stored[sectionStateSetting(id)]).toBe('collapsed');
        view.unmount();
        render(<SettingsPanel />);
        expect(expanded(title)).toBe(false);
    });

    it('a request while Settings is open opens that card', () => {
        render(<SettingsPanel />);
        expect(expanded('About')).toBe(false);
        act(() => requestSettingsSection('about'));
        expect(expanded('About')).toBe(true);
        expect(state.stored[sectionStateSetting('about')]).toBeUndefined();
    });

    it('a search match opens a card without changing what is remembered', () => {
        state.stored[sectionStateSetting('hardware')] = 'collapsed';
        render(<SettingsPanel />);
        const search = screen.getByRole('textbox', { name: 'Search settings' });
        expect(screen.queryByText('Hardware rows')).toBeNull();
        fireEvent.change(search, { target: { value: 'trackball' } });
        expect(screen.getByText('Hardware rows')).toBeVisible();
        fireEvent.change(search, { target: { value: '' } });
        expect(screen.queryByText('Hardware rows')).toBeNull();
        expect(state.stored[sectionStateSetting('hardware')]).toBe('collapsed');
    });

    it('follows the defaults when storage fails, and still toggles', () => {
        state.storageFails = true;
        render(<SettingsPanel />);
        expect(expanded('Hardware')).toBe(true);
        expect(expanded('Typing behavior')).toBe(false);
        fireEvent.click(toggle('Hardware'));
        expect(expanded('Hardware')).toBe(false);
        fireEvent.click(toggle('Typing behavior'));
        expect(expanded('Typing behavior')).toBe(true);
    });

    it('treats an unknown stored value, or the app default of false, as a first visit', () => {
        state.stored[sectionStateSetting('hardware')] = false;
        state.stored[sectionStateSetting('typing')] = 'maybe';
        render(<SettingsPanel />);
        expect(expanded('Hardware')).toBe(true);
        expect(expanded('Typing behavior')).toBe(false);
    });
});
