import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { UnstableFirmwareNotice } from '../../src/features/firmware/UnstableFirmwareNotice';

describe('UnstableFirmwareNotice', () => {
    it('on keybard.svalboard.com, names the Unstable firmware and links the Keybard that goes with it', () => {
        render(<UnstableFirmwareNotice boardTag="x4.4" buildSite="production" />);
        const note = screen.getByTestId('unstable-firmware-notice');
        expect(note).toHaveAttribute('role', 'status');
        expect(note.textContent).toBe('Your keyboard runs Unstable firmware x4.4. Unstable Keybard at next.keybard.svalboard.com goes with it.');
        expect(within(note).getByRole('link', { name: 'next.keybard.svalboard.com' })).toHaveAttribute('href', 'https://next.keybard.svalboard.com/');
    });

    it('shows nothing for Stable firmware, on next, on a dev build or with no keyboard read', () => {
        for (const [tag, site] of [['v4.3.5', 'production'], ['x4.4', 'next'], ['x4.4', 'dev'], [null, 'production']] as const) {
            const { container, unmount } = render(<UnstableFirmwareNotice boardTag={tag} buildSite={site} />);
            expect(container.innerHTML).toBe('');
            unmount();
        }
    });
});
