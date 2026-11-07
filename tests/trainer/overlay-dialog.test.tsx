import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULTS } from '@/features/trainer/core';
import { HOST_DOWNLOAD } from '@/features/trainer/HostInstall';

const host = vi.hoisted(() => ({ state: null as unknown, error: '', configure: vi.fn(), command: vi.fn(), connect: vi.fn() }));
vi.mock('@/features/trainer/host', async (original) => ({
    ...(await original<typeof import('@/features/trainer/host')>()),
    useHost: () => ({ state: host.state, busy: false, error: host.error, local: false, build: null, configure: host.configure, command: host.command, connect: host.connect }),
}));
const settings = vi.hoisted(() => ({ showShiftedLegends: true as boolean | undefined, showAltGrLegends: false }));
vi.mock('@/contexts/LayoutSettingsContext', () => ({ useLayoutSettings: () => ({ internationalLayout: 'de', ...settings }) }));
import { OverlayDialog, overlayRequested } from '@/features/trainer/OverlayDialog';

const connected = (layoutId = 'de', legends: { shiftedLegends?: boolean; altgrLegends?: boolean } = { shiftedLegends: true, altgrLegends: false }) => ({
    config: { ...DEFAULTS, layoutId, ...legends, highlightPressed: true, manualDefault: 1 }, revision: 1, session: 's', valid: true, status: 'Connected',
    devices: [{ id: 'a', name: 'Svalboard Right', serial: 'sval:1' }], selectedDevice: 'a',
});
const show = () => render(<OverlayDialog open onOpenChange={() => {}} />);

beforeEach(() => { settings.showShiftedLegends = true; settings.showAltGrLegends = false; host.state = null; host.error = ''; vi.clearAllMocks(); });

describe('Desktop overlay dialog', () => {
    it('offers the download and a connection when no Host is connected', () => {
        show();
        expect(screen.getByText('The Keybard Overlay app shows your layout above your other windows.')).toBeTruthy();
        expect(screen.getByRole('link', { name: /Download for Windows/ })).toHaveAttribute('href', HOST_DOWNLOAD);
        fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
        expect(host.connect).toHaveBeenCalled();
    });

    it('names the board and can disconnect; settings are only in the Host', () => {
        host.state = connected();
        show();
        expect(screen.getByText('The overlay app is following Svalboard Right.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /settings/i })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
        expect(host.command).toHaveBeenCalledWith({ op: 'disconnect' });
    });

    it('hides an old connection error once connected', () => {
        host.state = connected(); host.error = 'Connection to the overlay app lost. The preview is paused.';
        show();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps the overlay on Keybard’s keyboard language, and only when it differs', () => {
        host.state = connected('us');
        const { unmount } = show();
        const update = host.configure.mock.calls[0][0] as (c: object) => object;
        expect(update({ ...DEFAULTS, layoutId: 'us' })).toMatchObject({ layoutId: 'de' });
        unmount(); vi.clearAllMocks();
        host.state = connected('de');
        show();
        expect(host.configure).not.toHaveBeenCalled();
    });

    it('keeps the overlay on the Shifted Key Symbols and AltGr Symbols settings, and only when they differ', () => {
        settings.showAltGrLegends = true;
        host.state = connected('de', { shiftedLegends: true, altgrLegends: false });
        const { unmount } = show();
        const update = host.configure.mock.calls[0][0] as (c: object) => object;
        expect(update({ ...DEFAULTS })).toMatchObject({ altgrLegends: true });
        unmount(); vi.clearAllMocks();
        host.state = connected('de', { shiftedLegends: true, altgrLegends: true });
        show();
        expect(host.configure).not.toHaveBeenCalled();
    });

    it('leaves an older overlay app alone: it has neither legend field and rejects unknown ones', () => {
        settings.showAltGrLegends = true;
        host.state = { ...(connected('de') as object), config: { ...DEFAULTS, layoutId: 'de', highlightPressed: true, manualDefault: 1 } };
        show();
        expect(host.configure).not.toHaveBeenCalled();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('tries a legend change once per connection, never in a loop', () => {
        settings.showAltGrLegends = true;
        host.state = connected('de', { shiftedLegends: true, altgrLegends: false });
        const { rerender } = show();
        rerender(<OverlayDialog open onOpenChange={() => {}} />);
        expect(host.configure).toHaveBeenCalledTimes(1);
    });

    it('opens from the Host’s link and from older Hosts’ link', () => {
        expect(overlayRequested('#overlay')).toBe(true);
        expect(overlayRequested('#trainer')).toBe(true);
        expect(overlayRequested('#manual')).toBe(false);
    });
});
