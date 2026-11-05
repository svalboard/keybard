import { describe, expect, it, vi } from 'vitest';
import {
    fetchSiteVersion, ownSite, parseVersionFile, releaseNotesUrl, releaseTable, resetSiteVersions, siteForTag, siteVersion, sitesToRead,
    unstableFirmwareNotice, usingSentence,
} from '../../src/utils/site-versions';
import { firmwareName, keybardName, releaseWord, runsFirmware, versionFile, type FirmwareReleasePin } from '../../src/constants/firmware-releases';

import { backupFirmwareNote } from '../../src/services/backup/describe';

const json = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);

describe('site versions', () => {
    it('pairs v releases with keybard.svalboard.com and x releases with next', () => {
        expect(siteForTag('v4.3.6')).toBe('production');
        expect(siteForTag('x4.4')).toBe('next');
        expect(siteForTag('')).toBeNull();
        expect(siteForTag('vLaunch2.3')).toBeNull();
    });

    const stable = (keybard: string | null, firmware: string | null, current = false) => ({ site: 'production', release: 'Stable', keybard, firmware, current });
    const unstable = (keybard: string | null, firmware: string | null, current = false) => ({ site: 'next', release: 'Unstable', keybard, firmware, current });

    it('on next: Stable from its version.json, Unstable from this build and current', () => {
        expect(releaseTable({ tag: 'x4.4', buildSite: 'next', fetched: { production: { tag: 'v4.3.6', firmware: 'v4.3.5' } } }))
            .toEqual([stable('v4.3.6', 'v4.3.5'), unstable('x4.4', 'x4.4', true)]);
    });

    it('on keybard.svalboard.com: the same table, Stable current', () => {
        // Today's build carries no v firmware, so this site's firmware is blank rather than guessed.
        expect(releaseTable({ tag: 'v4.3.6', buildSite: 'production', fetched: { next: { tag: 'x4.4', firmware: 'x4.4' } } }))
            .toEqual([stable('v4.3.6', null, true), unstable('x4.4', 'x4.4')]);
    });

    it('a failed read leaves the other release blank', () => {
        expect(releaseTable({ tag: 'x4.4', buildSite: 'next', fetched: { production: null } })[0]).toEqual(stable(null, null));
    });

    it('a build with no tag lists both releases, neither current', () => {
        expect(releaseTable({ tag: '', buildSite: 'dev', fetched: { next: { tag: 'x4.4', firmware: null } } }))
            .toEqual([stable(null, null), unstable('x4.4', null)]);
        expect(sitesToRead('', false, 'dev')).toEqual(['production', 'next']);
    });

    it('Paranoid reads nothing and lists only its own release', () => {
        expect(sitesToRead('v4.3.6', true, 'production')).toEqual([]);
        expect(releaseTable({ tag: 'v4.3.6', paranoid: true, buildSite: 'production', fetched: {} })).toEqual([stable('v4.3.6', null, true)]);
    });

    it('a release built for another site (Keybard Overlay builds x tags for production) is no public site', () => {
        expect(ownSite('x4.4', 'production')).toBeNull();
        expect(ownSite('x4.4', 'next')).toBe('next');
        expect(ownSite('v4.3.6', 'dev')).toBeNull();
        expect(releaseTable({ tag: 'x4.4', buildSite: 'production', fetched: {} })).toEqual([stable(null, null), unstable(null, null)]);
    });

    it('says which Keybard this is, as a plain sentence', () => {
        expect(usingSentence('x4.4', 'abc1234')).toBe("You're using Unstable Keybard x4.4.");
        expect(usingSentence('v4.3.6', '')).toBe("You're using Stable Keybard v4.3.6.");
        expect(usingSentence('', '1a2b3c4')).toBe("You're using a development build, commit 1a2b3c4.");
        expect(usingSentence('', '')).toBe("You're using a development build.");
    });

    it('notices a keyboard on Unstable firmware only on the Stable site', () => {
        const n = unstableFirmwareNotice('x4.4', 'production');
        expect(n && n.lead + n.host + n.tail).toBe('Your keyboard runs Unstable firmware x4.4. Unstable Keybard at next.keybard.svalboard.com goes with it.');
        expect(n?.url).toBe('https://next.keybard.svalboard.com/');
        expect(unstableFirmwareNotice('v4.3.5', 'production')).toBeNull();
        expect(unstableFirmwareNotice('x4.4', 'next')).toBeNull();
        expect(unstableFirmwareNotice('x4.4', 'dev')).toBeNull();
        expect(unstableFirmwareNotice('fw version 19', 'production')).toBeNull();
        expect(unstableFirmwareNotice(null, 'production')).toBeNull();
    });

    it('accepts only a tag that site serves', () => {
        expect(parseVersionFile({ tag: 'v4.3.6', firmware: 'v4.3.5' }, 'production')).toEqual({ tag: 'v4.3.6', firmware: 'v4.3.5' });
        expect(parseVersionFile({ tag: 'x4.4' }, 'production')).toBeNull();
        expect(parseVersionFile({ tag: 'v4.3.6', firmware: 'latest' }, 'production')).toEqual({ tag: 'v4.3.6', firmware: null });
        // keybard.svalboard.com carries only v firmware; next carries both.
        expect(parseVersionFile({ tag: 'v4.3.6', firmware: 'x4.4' }, 'production')).toEqual({ tag: 'v4.3.6', firmware: null });
        expect(parseVersionFile({ tag: 'x4.5', firmware: 'v4.5' }, 'next')).toEqual({ tag: 'x4.5', firmware: 'v4.5' });
        expect(parseVersionFile(null, 'next')).toBeNull();
        expect(parseVersionFile('x4.4', 'next')).toBeNull();
    });

    it('reads version.json from the site root and gives null on any failure', async () => {
        const ok = json({ tag: 'x4.4', firmware: 'x4.4' });
        expect(await fetchSiteVersion('next', ok)).toEqual({ tag: 'x4.4', firmware: 'x4.4' });
        expect(ok).toHaveBeenCalledWith('https://next.keybard.svalboard.com/version.json', expect.objectContaining({ cache: 'no-store' }));
        expect(await fetchSiteVersion('production', json({}, false))).toBeNull();
        expect(await fetchSiteVersion('production', vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).toBeNull();
        const badJson = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }) as unknown as Response);
        expect(await fetchSiteVersion('production', badJson)).toBeNull();
    });

    it('names a release "<Release> <thing> <version>" from its tag kind, never a bare v or x', () => {
        expect(releaseWord('v4.3.6')).toBe('Stable');
        expect(releaseWord('x4.4')).toBe('Unstable');
        expect(releaseWord('build 1a2b3c4')).toBeNull();
        expect(releaseWord(null)).toBeNull();
        expect(releaseWord('vLaunch2.3')).toBeNull();
        expect(firmwareName('v4.3.5')).toBe('Stable firmware v4.3.5');
        expect(firmwareName('x4.4')).toBe('Unstable firmware x4.4');
        expect(firmwareName('vLaunch2.3')).toBe('vLaunch2.3');
        expect(firmwareName('build 19')).toBe('build 19');
        expect(keybardName('v4.3.6')).toBe('Stable Keybard v4.3.6');
        expect(keybardName('x4.4')).toBe('Unstable Keybard x4.4');
        // What a connected keyboard runs, without "Firmware: Unstable firmware".
        expect(runsFirmware('x4.4')).toBe('Runs Unstable firmware x4.4');
        expect(runsFirmware('Svalboard QMK vLaunch2 or later')).toBe('Firmware: Svalboard QMK vLaunch2 or later');
        expect(backupFirmwareNote({ fromTag: 'x4.4' })).toBe('saved from Unstable firmware x4.4');
        expect(backupFirmwareNote({ fromTag: 'x4test10' })).toBe('saved from x4test10 firmware');
    });

    it('links to this release notes, or the list for an untagged build', () => {
        expect(releaseNotesUrl('x4.4')).toBe('https://github.com/svalboard/keybard/releases/tag/x4.4');
        expect(releaseNotesUrl('')).toBe('https://github.com/svalboard/keybard/releases');
    });
});

describe('reading a site', () => {
    it('reads again after a failed read, but only once after a good one', async () => {
        resetSiteVersions();
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('offline'))
            .mockResolvedValue({ ok: true, json: async () => ({ tag: 'x4.4' }) });
        vi.stubGlobal('fetch', fetchMock);
        try {
            expect(await siteVersion('next')).toBeNull();
            await Promise.resolve();
            expect(await siteVersion('next')).toEqual({ tag: 'x4.4', firmware: null });
            expect(await siteVersion('next')).toEqual({ tag: 'x4.4', firmware: null });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            vi.unstubAllGlobals();
            resetSiteVersions();
        }
    });
});

describe('version.json', () => {
    const pin = (tag: string, kind: 'v' | 'x', fwVersion: number): FirmwareReleasePin => ({
        tag, kind, fwVersion, updaterProtocol: 4, file: { uf2: `${tag}.uf2`, sha256: '0', size: 1 }, notesUrl: '',
    });
    const carried = [pin('v4.3.5', 'v', 18), pin('x4.4', 'x', 19)];

    it('names the Keybard release and the newest firmware that site carries', () => {
        // A Keybard-only v release carries older firmware: the two tags differ.
        expect(versionFile('v4.3.6', 'production', carried)).toEqual({ tag: 'v4.3.6', firmware: 'v4.3.5' });
        expect(versionFile('x4.4', 'next', carried)).toEqual({ tag: 'x4.4', firmware: 'x4.4' });
    });

    it('leaves out firmware the site does not carry, and is absent for untagged builds', () => {
        expect(versionFile('v4.4', 'production', [pin('x4.4', 'x', 19)])).toEqual({ tag: 'v4.4' });
        expect(versionFile('', 'dev', carried)).toBeNull();
    });

    it('is absent for a release built for another site', () => {
        expect(versionFile('x4.4', 'production', carried)).toBeNull();
        expect(versionFile('v4.3.6', 'next', carried)).toBeNull();
    });
});
