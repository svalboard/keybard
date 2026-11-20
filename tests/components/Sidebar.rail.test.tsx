import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '../../src/components/ui/sidebar';
import AppSidebar from '../../src/layout/Sidebar';
import { settingsSectionForPanel, takeSettingsSectionRequest } from '../../src/layout/SecondarySidebar/Panels/settings/anchor';
import PointingDeepLink from '../../src/layout/PointingDeepLink';
import { _resetPointingDemoForTests, pointingDemoFromSearch } from '../../src/features/pointing-demo';

const panels = vi.hoisted(() => ({
    activePanel: null as string | null, open: false,
    setActivePanel: vi.fn(), openDetails: vi.fn(), handleCloseDetails: vi.fn(),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/features/trainer/OverlayDialog', () => ({ OverlayDialog: () => null, overlayRequested: () => false }));
const deepLink = vi.hoisted(() => ({ keyboard: null as unknown }));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard: deepLink.keyboard }) }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ getSetting: () => undefined }) }));
const firmware = vi.hoisted(() => ({ dot: false }));
vi.mock('@/features/firmware/FirmwareUpdateProvider', () => ({ useFirmwareUpdates: () => ({ status: { dot: firmware.dot } }) }));
vi.mock('@/contexts/PanelsContext', () => ({ usePanels: () => ({
    ...panels, setItemToEdit: vi.fn(), panelToGoBack: null, alternativeHeader: false,
    setPanelToGoBack: vi.fn(), setAlternativeHeader: vi.fn(), setOpen: vi.fn(),
}) }));

const renderRail = () => render(<SidebarProvider><AppSidebar /></SidebarProvider>);

beforeEach(() => { vi.clearAllMocks(); panels.activePanel = null; panels.open = false; firmware.dot = false; takeSettingsSectionRequest(); });

describe('the rail holds what is used while editing', () => {
    it('has no Typing Behavior or Hardware item: both live in Settings', () => {
        renderRail();
        const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
        for (const gone of ['Typing Behavior', 'Typing behavior', 'Hardware', 'Clusters']) expect(names).not.toContain(gone);
        // Layouts stands alone; Overlay is in the footer, between Manual (a link) and Settings.
        const footer = [...document.querySelectorAll('[data-sidebar="menu"] [aria-label]')].map((el) => el.getAttribute('aria-label'));
        expect(footer.slice(footer.indexOf('Layouts'))).toEqual(['Layouts', 'Quick Start', 'Manual', 'Overlay', 'Settings']);
    });

    it('has no About item: About is a card of Settings', () => {
        renderRail();
        const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
        expect(names).not.toContain('About');
        expect(screen.queryByRole('button', { name: 'About' })).toBeNull();
        expect(names.indexOf('Settings')).toBeGreaterThan(names.indexOf('Quick Start'));
    });
});

describe('the editors under More', () => {
    it('has no Overrides, Alt-Repeat or App Layers item on the rail', () => {
        deepLink.keyboard = { name: 'demo', feature_flags5: 1, alt_repeat_keys: [{ keycode: 'KC_Z', alt_keycode: 'KC_Y' }] };
        renderRail();
        for (const gone of ['Overrides', 'Alt-Repeat', 'App Layers']) expect(screen.queryByRole('button', { name: gone })).toBeNull();
        deepLink.keyboard = null;
    });

    it.each(['overrides', 'altrepeat', 'app-layers', 'more'])('marks More while %s is open', (panel) => {
        panels.activePanel = panel;
        panels.open = true;
        renderRail();
        expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Combos' })).toHaveAttribute('aria-pressed', 'false');
    });

    it.each([['overrides', 'overrides'], ['altrepeat', 'altrepeat'], ['app-layers', 'app-layers'], ['app-rules', 'app-layers'], ['more', 'more']])('?panel=%s opens %s', (panel, opened) => {
        deepLink.keyboard = { name: 'demo' };
        _resetPointingDemoForTests();
        window.history.replaceState(null, '', `/keybard/?panel=${panel}`);
        render(<PointingDeepLink />);
        expect(panels.setActivePanel).toHaveBeenCalledWith(opened);
        expect(panels.openDetails).toHaveBeenCalled();
        window.history.replaceState(null, '', '/');
        _resetPointingDemoForTests();
        deepLink.keyboard = null;
    });
});

describe('the firmware update dot', () => {
    it('marks Settings when an update is available and not yet seen', () => {
        firmware.dot = true;
        renderRail();
        expect(screen.getByRole('button', { name: 'Settings, firmware update available' })).toBeTruthy();
        expect(screen.getAllByTestId('rail-dot')).toHaveLength(1);
    });

    it('is quiet otherwise', () => {
        renderRail();
        expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
        expect(screen.queryByTestId('rail-dot')).toBeNull();
    });
});

describe('old links to the panels that moved into Settings', () => {
    it.each([['typing', 'typing'], ['clusters', 'hardware'], ['fragments', 'hardware'], ['about', 'about']])('?panel=%s lands in Settings at %s', (panel, section) => {
        expect(settingsSectionForPanel(panel)).toBe(section);
        expect(pointingDemoFromSearch(`?demo=combos&panel=${panel}`)!.panel).toBe(panel);
    });

    it('opens Settings at that section once a layout is loaded', () => {
        deepLink.keyboard = { name: 'demo' };
        _resetPointingDemoForTests();
        window.history.replaceState(null, '', '/keybard/?demo=combos&panel=typing');
        render(<PointingDeepLink />);
        expect(panels.setActivePanel).toHaveBeenCalledWith('settings');
        expect(panels.openDetails).toHaveBeenCalled();
        expect(takeSettingsSectionRequest()).toBe('typing');
        window.history.replaceState(null, '', '/');
        _resetPointingDemoForTests();
        deepLink.keyboard = null;
    });

    it('opens Settings at About for an old ?panel=about link', () => {
        deepLink.keyboard = { name: 'demo' };
        _resetPointingDemoForTests();
        window.history.replaceState(null, '', '/keybard/?demo=combos&panel=about');
        render(<PointingDeepLink />);
        expect(panels.setActivePanel).toHaveBeenCalledWith('settings');
        expect(takeSettingsSectionRequest()).toBe('about');
        window.history.replaceState(null, '', '/');
        _resetPointingDemoForTests();
        deepLink.keyboard = null;
    });

    it('ignores names that are not panels', () => {
        expect(settingsSectionForPanel('toString')).toBeUndefined();
        expect(pointingDemoFromSearch('?panel=toString')).toBeNull();
    });
});
