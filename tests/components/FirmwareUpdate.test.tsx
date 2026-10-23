import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UnsupportedFirmwareCard } from '../../src/components/FirmwareUpdate';
import { LATEST_FIRMWARE_RELEASE, SVALBOARD_FIRMWARE_URL, describeFirmware, identifyFirmwareRelease } from '../../src/constants/firmware';

const mode = vi.hoisted(() => ({ paranoid: false }));
vi.mock('@/lib/paranoid', () => ({ get PARANOID() { return mode.paranoid; }, userIsLooking: () => true }));

describe('UnsupportedFirmwareCard', () => {
    beforeEach(() => { mode.paranoid = false; });

    it('tells a Vial Svalboard owner to save the layout, then leads to the manual install', () => {
        render(<UnsupportedFirmwareCard info={{ kind: 'svalboard-vial', reportedVersion: 'v2025-11-01' }} />);
        const card = screen.getByRole('alert');
        expect(card).toHaveTextContent('old Vial firmware (v2025-11-01)');
        expect(card).toHaveTextContent('File > Save current layout');
        fireEvent.click(screen.getByRole('button', { name: 'Install by hand' }));
        const manual = screen.getByTestId('manual-install');
        expect(manual).toHaveTextContent('Press its RESET button twice, about a quarter of a second apart. Too fast and nothing happens.');
        expect(manual).toHaveTextContent('RPI-RP2');
        expect(screen.getByText(/Import Layout/)).toBeInTheDocument();
        // No release carried yet: the manual install links the firmware release
        expect(screen.getByRole('link', { name: /Svalboard firmware releases/ })).toHaveAttribute('href', SVALBOARD_FIRMWARE_URL);
        // One title, and it names the dialog
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Install the newest firmware by hand');
        expect(manual).not.toHaveTextContent('Download the firmware and copy it onto each half');
    });

    it('sends other keyboards elsewhere without the Svalboard download', () => {
        render(<UnsupportedFirmwareCard info={{ kind: 'other-qmk' }} />);
        expect(screen.getByRole('alert')).toHaveTextContent("doesn't run Svalboard firmware");
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        expect(screen.queryByText(/Save current layout/)).not.toBeInTheDocument();
    });

    it('tells a keyboard that never answered to retry, not to reflash', () => {
        render(<UnsupportedFirmwareCard info={{ kind: 'no-response' }} />);
        const card = screen.getByRole('alert', { name: "The keyboard didn't respond" });
        expect(card).toHaveTextContent('Unplug the keyboard');
        expect(card).not.toHaveTextContent(/Vial firmware|uf2|Flash/);
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('shows the download address as text in Keybard Paranoid', () => {
        mode.paranoid = true;
        render(<UnsupportedFirmwareCard info={{ kind: 'unknown' }} />);
        fireEvent.click(screen.getByRole('button', { name: 'Install by hand' }));
        expect(screen.queryByRole('link')).not.toBeInTheDocument();
        expect(screen.getByTestId('manual-install')).toHaveTextContent(SVALBOARD_FIRMWARE_URL);
    });
});

describe('firmware release identification', () => {
    const live = { svil_proto: 3, keycode_version_reported: true, feature_flags: 0x6f };

    it('identifies each release from what GET_INFO reports', () => {
        expect(identifyFirmwareRelease({ svil_proto: 3, feature_flags: 0x0f, keycode_version_reported: false })).toEqual({ name: 'vRC0', orLater: false, outdated: true });
        expect(identifyFirmwareRelease({ svil_proto: 3, feature_flags: 0x6f, keycode_version_reported: false })).toEqual({ name: 'vRC1 or vRC2', orLater: false, outdated: true });
        expect(identifyFirmwareRelease({ ...live, feature_flags2: 0 })).toEqual({ name: 'vLaunch', orLater: false, outdated: true });
        expect(identifyFirmwareRelease({ ...live, feature_flags2: 0x01 })).toEqual({ name: 'vLaunch2', orLater: true, outdated: false });
    });

    it('treats vLaunch2 as the newest release it knows', () => {
        expect(LATEST_FIRMWARE_RELEASE).toBe('vLaunch2');
        expect(identifyFirmwareRelease({ ...live, svil_proto: 4 })).toEqual({ name: 'newer than vLaunch2', orLater: false, outdated: false });
    });

    it('says nothing about loaded files or unsupported protocols', () => {
        expect(identifyFirmwareRelease({ svil_proto: 3, feature_flags: 0x6f })).toBeNull();
        expect(identifyFirmwareRelease({ ...live, svil_proto: 2 })).toBeNull();
        expect(describeFirmware({ svil_proto: 3 })).toBeNull();
    });

    it('prefers the build string the board reports', () => {
        expect(describeFirmware({ ...live, feature_flags2: 1 })).toBe('Svalboard QMK vLaunch2 or later');
        expect(describeFirmware({ ...live, sval_firmware: 'svalboard/trackball/pmw3389/right:sval @ vLaunch2-3-gabc' })).toBe('svalboard/trackball/pmw3389/right:sval @ vLaunch2-3-gabc');
    });
});
