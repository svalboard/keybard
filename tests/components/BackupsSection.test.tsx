import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPanel from '../../src/layout/SecondarySidebar/Panels/SettingsPanel';
import type { SnapshotMeta } from '../../src/services/backup/store';

const now = Date.now();
const snap = (over: Partial<SnapshotMeta>): SnapshotMeta => ({
    id: 'a', boardKey: 'sval:AAAA', boardName: 'Desk', savedAt: now, kind: 'edited', fingerprint: 'f',
    includesPending: false, pendingCount: 0, summary: '', size: 10, ...over,
});

const mocks = vi.hoisted(() => ({
    mode: 'sidebar',
    instant: false,
    keyboard: { rows: 1, cols: 1, layers: 1, keymap: [[4]], name: 'Test', macros: [], macro_count: 0, settings: {} },
    queue: vi.fn(), sync: vi.fn(), commit: vi.fn(), upload: vi.fn(), download: vi.fn(),
    backups: {} as Record<string, unknown>,
}));
vi.mock('../../src/layout/SecondarySidebar/Panels/ClustersPanel', () => ({ default: () => <p>Hardware rows</p> }));
vi.mock('../../src/layout/SecondarySidebar/Panels/TypingBehaviorPanel', () => ({ default: () => <p>Typing behavior rows</p> }));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard: mocks.keyboard, setKeyboard: vi.fn(), isConnected: true, loadFromFile: vi.fn(), setIsImporting: vi.fn() }) }));
vi.mock('@/contexts/ChangesContext', () => ({ useChanges: () => ({ queue: mocks.queue, todo: {}, isInstant: mocks.instant, isSaving: false, commit: mocks.commit, setInstant: vi.fn() }) }));
vi.mock('@/contexts/BackupContext', () => ({ useBackups: () => mocks.backups }));
vi.mock('@/contexts/LayoutSettingsContext', () => ({ useLayoutSettings: () => ({ layoutMode: mocks.mode }) }));
vi.mock('@/contexts/PanelsContext', () => ({ usePanels: () => ({ setActivePanel: vi.fn() }) }));
vi.mock('@/App', () => ({ useNavigation: () => ({ navigateTo: vi.fn() }) }));
// Backups is in the Firmware and backups card, left open in this browser.
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({
    getSetting: (name: string) => (name === 'settings-firmware-open' ? 'open' : undefined),
    updateSetting: vi.fn(), getSettingDefinition: () => undefined,
}) }));
vi.mock('@/services/file.service', () => ({ fileService: { uploadFile: mocks.upload, downloadSvil: vi.fn(), downloadSvilText: mocks.download } }));
vi.mock('@/services/import.service', () => ({ importService: { syncWithKeyboard: mocks.sync } }));
vi.mock('@/services/keyboard.service', () => ({ keyboardService: {} }));
vi.mock('../../src/layout/SecondarySidebar/Panels/BoardIdentitySection', () => ({ default: () => null }));
vi.mock('../../src/layout/SecondarySidebar/Panels/settings/FirmwareRow', () => ({ default: () => null }));

const backups = (over: Record<string, unknown> = {}) => ({
    available: true,
    folderSupported: true,
    folder: { state: 'none', name: null, error: null },
    board: { key: 'sval:BBBB', name: 'Travel' },
    snapshots: [
        snap({ id: 'old', boardKey: 'sval:AAAA', boardName: 'Desk', savedAt: now - 1000 }),
        snap({ id: 'conn', boardKey: 'sval:BBBB', boardName: 'Travel', kind: 'connected', savedAt: now - 5000 }),
        snap({ id: 'edit', boardKey: 'sval:BBBB', boardName: 'Travel', savedAt: now - 2000, summary: '3 keys, 1 macro', includesPending: true, pendingCount: 4 }),
    ],
    getSvil: vi.fn(async (id: string) => `svil-${id}`),
    deleteSnapshot: vi.fn(async () => undefined),
    chooseFolder: vi.fn(async () => undefined),
    resumeFolder: vi.fn(async () => undefined),
    stopFolder: vi.fn(async () => undefined),
    ...over,
});

// Backups is a section of the one Settings page; its list starts collapsed.
const disclosure = () => screen.getByRole('button', { name: /^Backups, / });
const openBackups = () => { render(<SettingsPanel />); fireEvent.click(disclosure()); };
const boardRegions = () => screen.getAllByRole('region').filter((r) => /^Backups of /.test(r.getAttribute('aria-label') ?? ''));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.instant = false;
    mocks.backups = backups();
    mocks.upload.mockResolvedValue({ ...mocks.keyboard, keymap: [[5]] });
});

describe('Settings > Backups', () => {
    it.each(['sidebar', 'bottombar'])('lists snapshots by board, connected board first (%s)', (mode) => {
        mocks.mode = mode;
        openBackups();
        const groups = boardRegions();
        expect(groups[0]).toHaveAccessibleName('Backups of Travel');
        expect(groups[1]).toHaveAccessibleName('Backups of Desk');
        const rows = within(groups[0]).getAllByTestId('backup-row');
        expect(rows[0]).toHaveTextContent('3 keys, 1 macro');
        expect(rows[0]).toHaveTextContent('Unsent (4)');
        expect(rows[1]).toHaveTextContent('Saved when the keyboard connected');
        expect(rows[1]).not.toHaveTextContent('Unsent');
    });

    it('restores through the import review, staging changes for Apply', async () => {
        openBackups();
        const travel = boardRegions()[0];
        fireEvent.click(within(travel).getAllByRole('button', { name: /Restore backup/ })[0]);
        expect(await screen.findByRole('dialog')).toBeVisible();
        expect(mocks.upload).toHaveBeenCalledTimes(1);
        const file = mocks.upload.mock.calls[0][0] as File;
        expect(file.name).toMatch(/^Travel .*\.svil$/);
        expect(mocks.sync).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Stage import' }));
        await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('downloads and deletes', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        openBackups();
        fireEvent.click(screen.getAllByRole('button', { name: /Download backup/ })[0]);
        await waitFor(() => expect(mocks.download).toHaveBeenCalledWith('svil-edit', expect.stringMatching(/\.svil$/)));
        fireEvent.click(screen.getAllByRole('button', { name: /Delete backup/ })[0]);
        await waitFor(() => expect((mocks.backups.deleteSnapshot as any)).toHaveBeenCalledWith('edit'));
    });

    it('offers to choose a folder', () => {
        openBackups();
        fireEvent.click(screen.getByRole('button', { name: 'Choose backup folder' }));
        expect(mocks.backups.chooseFolder).toHaveBeenCalled();
    });

    it('offers Resume only while paused', () => {
        mocks.backups = backups({ folder: { state: 'paused', name: 'Keybard backups', error: null } });
        openBackups();
        expect(screen.getByText('Keybard backups')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Resume backups' }));
        expect(mocks.backups.resumeFolder).toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Stop using folder' }));
        expect(mocks.backups.stopFolder).toHaveBeenCalled();
    });

    it('shows Choose again when the folder was lost', () => {
        mocks.backups = backups({ folder: { state: 'lost', name: null, error: null } });
        openBackups();
        expect(screen.getByRole('button', { name: 'Choose backup folder' })).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Resume backups' })).toBeNull();
    });

    it('pins before-update and by-hand backups at the top of a board, labelled, beyond the row limit', () => {
        const many = Array.from({ length: 10 }, (_, i) => snap({ id: `e${i}`, boardKey: 'sval:BBBB', boardName: 'Travel', savedAt: now - 10_000 - i }));
        mocks.backups = backups({ snapshots: [
            ...many,
            snap({ id: 'pre', boardKey: 'sval:BBBB', boardName: 'Travel', kind: 'pre-update', fromTag: 'v3', toTag: 'x4', savedAt: now - 900_000 }),
            snap({ id: 'man', boardKey: 'sval:BBBB', boardName: 'Travel', kind: 'manual', savedAt: now - 800_000 }),
        ] });
        openBackups();
        const rows = within(boardRegions()[0]).getAllByTestId('backup-row');
        expect(rows[0]).toHaveTextContent('Saved by hand');
        // Named by why it was saved; the firmware it was saved from is a muted detail.
        expect(rows[1]).toHaveTextContent('Saved before a firmware update');
        expect(rows[1]).toHaveTextContent('saved from v3 firmware');
        expect(rows[1]).not.toHaveTextContent('x4');
        expect(rows[0]).toHaveAttribute('data-pinned', 'true');
        expect(rows[2]).toHaveTextContent('Saved after a change');
        expect(rows).toHaveLength(2 + 8); // the pins, then the usual eight
        expect(screen.getByRole('button', { name: 'Show all (10)' })).toBeVisible();
    });

    it('backs up the connected board now', async () => {
        const backUpNow = vi.fn(async () => undefined);
        mocks.backups = backups({ backUpNow });
        openBackups();
        fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
        await waitFor(() => expect(backUpNow).toHaveBeenCalled());
        expect(await screen.findByText(/^Saved Today/)).toBeVisible();
    });

    it('starts collapsed, with the count and newest backup in its header and Back up now in reach', () => {
        render(<SettingsPanel />);
        expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
        expect(disclosure()).toHaveAccessibleName(/^Backups, 3 backups, latest Today /);
        expect(screen.queryAllByTestId('backup-row')).toHaveLength(0);
        expect(screen.queryByRole('button', { name: 'Choose backup folder' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Back up now' })).toBeVisible();
        fireEvent.click(disclosure());
        expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getAllByTestId('backup-row')).toHaveLength(3);
    });

    it('starts collapsed again the next time Settings opens', () => {
        const view = render(<SettingsPanel />);
        fireEvent.click(disclosure());
        view.unmount();
        render(<SettingsPanel />);
        expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    });

    it('says when there are no backups yet', () => {
        mocks.backups = backups({ snapshots: [] });
        render(<SettingsPanel />);
        expect(disclosure()).toHaveAccessibleName('Backups, No backups yet');
    });

    it('opens for a search that finds it, and collapses when the search clears', () => {
        render(<SettingsPanel />);
        const search = screen.getByRole('textbox', { name: 'Search settings' });
        fireEvent.change(search, { target: { value: 'restore' } });
        expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getAllByTestId('backup-row')).toHaveLength(3);
        fireEvent.keyDown(search, { key: 'Escape' });
        expect(search).toHaveValue('');
        expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    });

    it('offers Back up now only with a board connected', () => {
        mocks.backups = backups({ board: null });
        openBackups();
        expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull();
    });
});
