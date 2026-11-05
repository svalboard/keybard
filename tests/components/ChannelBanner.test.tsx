import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import ChannelBanner, { STABLE_URL } from '../../src/components/ChannelBanner';
import { resetSiteVersions } from '../../src/utils/site-versions';

describe('ChannelBanner', () => {
    beforeEach(() => resetSiteVersions());
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    it('says which firmware and site give the stable version once version.json is read', async () => {
        vi.stubEnv('VITE_CHANNEL', 'next');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tag: 'v4.3.6', firmware: 'v4.3.5' }) }) as Response));
        render(<ChannelBanner />);
        await waitFor(() => expect(screen.getByRole('note').textContent).toContain('v4.3.5'));
        expect(screen.getByRole('note').textContent)
            .toBe('This is the Unstable release and may break. For the Stable release, flash Stable firmware v4.3.5 and use keybard.svalboard.com.');
        expect(screen.getByRole('link', { name: 'keybard.svalboard.com' }).getAttribute('href')).toBe(STABLE_URL);
    });

    it('names only the site when its version.json cannot be read', async () => {
        vi.stubEnv('VITE_CHANNEL', 'next');
        const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
        vi.stubGlobal('fetch', fetchMock);
        render(<ChannelBanner />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        // Wait for the read itself to finish, so this is the failed state, not the one while reading.
        await act(async () => { await fetchMock.mock.results[0].value.catch(() => {}); await new Promise(r => setTimeout(r, 0)); });
        expect(screen.getByRole('note').textContent)
            .toBe('This is the Unstable release and may break. For the Stable release, use keybard.svalboard.com.');
    });

    it('shows nothing and reads nothing on other builds', () => {
        vi.stubEnv('VITE_CHANNEL', '');
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { container } = render(<ChannelBanner />);
        expect(container.innerHTML).toBe('');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
