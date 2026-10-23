import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { StorageResetDialog, OPEN_BACKUPS_EVENT, firmwareLine, pickResetBackup } from '../../src/components/StorageResetDialog';
import { fingerprintSvil } from '../../src/services/backup/codec';
import type { SnapshotMeta } from '../../src/services/backup/backup.service';
import { noteResetNoticeCleared, sessionFlowStore } from '../../src/services/updater/flow';

const keyboardContext = vi.hoisted(() => ({ isConnected: true, connectionSessionId: 1, keyboard: { kbid: 'abc', storage_reset: true } as Record<string, unknown>, setKeyboard: vi.fn() }));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => keyboardContext }));
const svc = vi.hoisted(() => ({ clearStorageReset: vi.fn() }));
vi.mock('@/services/keyboard.service', () => ({ keyboardService: svc }));
const changes = vi.hoisted(() => ({ queue: vi.fn(), commit: vi.fn() }));
vi.mock('@/contexts/ChangesContext', () => ({ useChanges: () => changes }));
const backups = vi.hoisted(() => ({ snapshots: [] as Array<Record<string, unknown>>, board: { key: 'sval:1', name: 'Kip' } as { key: string; name: string } | null }));
vi.mock('@/contexts/BackupContext', () => ({ useBackups: () => backups, serializeForBackup: () => '{"current":true}' }));
const restore = vi.hoisted(() => ({ restoreLayoutToBoard: vi.fn() }));
vi.mock('@/features/firmware/restore', () => restore);
const backupService = vi.hoisted(() => ({ getSvil: vi.fn() }));
vi.mock('@/services/backup/backup.service', () => ({ getBackupService: () => backupService }));
const firmwareUpdates = vi.hoisted(() => ({ value: null as null | { board: unknown } }));
vi.mock('@/features/firmware/FirmwareUpdateProvider', () => ({ useFirmwareUpdates: () => firmwareUpdates.value }));

describe('StorageResetDialog', () => {
    beforeEach(() => {
        svc.clearStorageReset.mockReset().mockResolvedValue(undefined);
        restore.restoreLayoutToBoard.mockReset().mockResolvedValue({ trimmed: [] });
        backupService.getSvil.mockReset().mockResolvedValue('{"backup":true}');
        keyboardContext.isConnected = true;
        keyboardContext.keyboard = { kbid: 'abc', storage_reset: true };
        backups.snapshots = [];
        backups.board = { key: 'sval:1', name: 'Kip' };
        firmwareUpdates.value = null;
        sessionStorage.clear();
        keyboardContext.connectionSessionId = 1;
        noteResetNoticeCleared(Symbol('no connection'));
    });

    it('tells the user to reload their layout file when there is no backup, and clears the board notice on OK', async () => {
        render(<StorageResetDialog />);
        expect(await screen.findByText("Your layout was reset")).toBeTruthy();
        expect(screen.getByText(/Load your layout file/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'OK' }));
        await waitFor(() => expect(svc.clearStorageReset).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByText("Your layout was reset")).toBeNull());
    });

    it('stays hidden when the board reports no reset or is disconnected', () => {
        keyboardContext.keyboard = { kbid: 'abc', storage_reset: false };
        const { rerender } = render(<StorageResetDialog />);
        expect(screen.queryByText("Your layout was reset")).toBeNull();
        keyboardContext.keyboard = { kbid: 'abc', storage_reset: true };
        keyboardContext.isConnected = false;
        rerender(<StorageResetDialog />);
        expect(screen.queryByText("Your layout was reset")).toBeNull();
        expect(svc.clearStorageReset).not.toHaveBeenCalled();
    });

    it('warns that changes are not being saved, and dismisses without telling the board', async () => {
        keyboardContext.keyboard = { kbid: 'abc', storage_write_failed: true };
        render(<StorageResetDialog />);
        expect(screen.getByText("Your keyboard can't save changes")).toBeTruthy();
        expect(screen.getByText(/lost when it restarts/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'OK' }));
        await waitFor(() => expect(screen.queryByText("Your keyboard can't save changes")).toBeNull());
        expect(svc.clearStorageReset).not.toHaveBeenCalled();
    });

    it('shows the save warning first, then the reset notice', async () => {
        keyboardContext.keyboard = { kbid: 'abc', storage_reset: true, storage_write_failed: true };
        render(<StorageResetDialog />);
        expect(screen.getByText("Your keyboard can't save changes")).toBeTruthy();
        expect(screen.queryByText("Your layout was reset")).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'OK' }));
        await waitFor(() => expect(screen.getByText("Your layout was reset")).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: 'OK' }));
        await waitFor(() => expect(svc.clearStorageReset).toHaveBeenCalledTimes(1));
    });

    describe('A4: new firmware reset the settings, with no update in flight', () => {
        const snap = (id: string, savedAt: number, fingerprint = id) => ({ id, boardKey: 'sval:1', boardName: 'Kip', savedAt, kind: 'pre-update', fromTag: 'v3', fingerprint });

        it('offers the newest backup of this board and puts it back, then clears the notice', async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = [snap('old', 1000), snap('new', 2000), { ...snap('other', 3000), boardKey: 'sval:2' }];
            render(<StorageResetDialog />);
            expect(await screen.findByText('Your layout was reset')).toBeTruthy();
            // The layout line names the backup by when and why, never by a firmware version.
            expect(screen.getByTestId('reset-backup').textContent).toMatch(/^Backup saved before the update, (today|yesterday|\w)/);
            expect(screen.getByTestId('reset-backup').textContent).not.toMatch(/v3/);
            fireEvent.click(screen.getByRole('button', { name: 'Restore my layout' }));
            await waitFor(() => expect(restore.restoreLayoutToBoard).toHaveBeenCalledTimes(1));
            expect(backupService.getSvil).toHaveBeenCalledWith('new');
            expect(restore.restoreLayoutToBoard.mock.calls[0][0]).toBe('{"backup":true}');
            await waitFor(() => expect(svc.clearStorageReset).toHaveBeenCalledTimes(1));
        });

        it('Start from the default layout clears the notice without writing anything', async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = [snap('new', 2000)];
            render(<StorageResetDialog />);
            fireEvent.click(await screen.findByRole('button', { name: 'Start from the default layout' }));
            await waitFor(() => expect(svc.clearStorageReset).toHaveBeenCalledTimes(1));
            expect(restore.restoreLayoutToBoard).not.toHaveBeenCalled();
        });

        it('Other backups opens Backups', async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = [snap('new', 2000)];
            const opened = vi.fn();
            window.addEventListener(OPEN_BACKUPS_EVENT, opened);
            render(<StorageResetDialog />);
            fireEvent.click(await screen.findByRole('button', { name: 'Other backups' }));
            expect(opened).toHaveBeenCalled();
            window.removeEventListener(OPEN_BACKUPS_EVENT, opened);
        });

        it('stays out of the way while this tab has an update in flight', () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            sessionStorage.setItem('keybard:firmware-update', JSON.stringify({ phase: 'running' }));
            render(<StorageResetDialog />);
            expect(screen.queryByText('Your layout was reset')).toBeNull();
        });

        it("stays out of the way while the update's dialog shows its result or a failure", () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = [snap('new', 2000)];
            for (const phase of ['result', 'failed']) {
                sessionStorage.setItem('keybard:firmware-update', JSON.stringify({ phase }));
                const { unmount } = render(<StorageResetDialog />);
                expect(screen.queryByText('Your layout was reset')).toBeNull();
                unmount();
            }
        });

        it('never asks after the update cleared the notice (0x2A) on this connection, though the loaded layout still shows it', async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            keyboardContext.connectionSessionId = 7;
            backups.snapshots = [snap('new', 2000)];
            sessionStorage.setItem('keybard:firmware-update', JSON.stringify({ phase: 'result' }));
            render(<StorageResetDialog />);
            act(() => noteResetNoticeCleared(7));
            // Done closes the update's dialog.
            act(() => sessionFlowStore().clear());
            expect(screen.queryByText('Your layout was reset')).toBeNull();
            expect(svc.clearStorageReset).not.toHaveBeenCalled();
        });

        it("asks once the update's dialog is closed when the notice is still set (the update stopped before 0x2A)", async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = [snap('new', 2000)];
            sessionStorage.setItem('keybard:firmware-update', JSON.stringify({ phase: 'failed' }));
            render(<StorageResetDialog />);
            expect(screen.queryByText('Your layout was reset')).toBeNull();
            act(() => sessionFlowStore().clear());
            await waitFor(() => expect(screen.getByText('Your layout was reset')).toBeTruthy());
        });

        it('a reset on a later connection asks again', async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            keyboardContext.connectionSessionId = 8;
            noteResetNoticeCleared(7);
            render(<StorageResetDialog />);
            expect(await screen.findByText('Your layout was reset')).toBeTruthy();
        });

        it('bit 0 keeps its own dialog and gains the same button', async () => {
            backups.snapshots = [snap('new', 2000)];
            render(<StorageResetDialog />);
            expect(await screen.findByText("Your layout was reset")).toBeTruthy();
            expect(screen.getByRole('button', { name: 'Restore my layout' })).toBeTruthy();
        });
    });

    describe('after an install: the backup saved for it, and what is installed now', () => {
        const HOUR = 60 * 60 * 1000;
        const DAY = 24 * HOUR;
        const meta = (id: string, boardKey: string, ago: number, kind: SnapshotMeta['kind'], extra: Partial<SnapshotMeta> = {}): SnapshotMeta => ({
            id, boardKey, boardName: 'Kip', savedAt: Date.now() - ago, kind, fingerprint: id, includesPending: false, pendingCount: 0, summary: '', size: 1, ...extra,
        });
        const half = (hand: 0 | 1, tag: string, fwVersion: number, usb: boolean, answered = true) => ({ hand, tag, fwVersion, usb, answered });
        const board = (halves: ReturnType<typeof half>[]) => ({ updater: true, legacyLabel: null, usbHand: 1, halves, differ: false, noChord: false, fwVersion: halves[0]?.fwVersion ?? 0, tag: halves.find((h) => h.usb)?.tag ?? '' });

        it("the board back under another key (the other half, or its serial unread): offers this morning's pre-install backup, not its own two-week-old one", async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = [
                meta('two-weeks', 'sval:1', 15 * DAY, 'connected'),
                meta('this-morning', 'sval:OTHER-HALF', 20 * 60 * 1000, 'pre-update', { fromTag: 'x3.1.3', toTag: '' }),
            ];
            render(<StorageResetDialog />);
            expect(await screen.findByText(/^Backup( of Kip)? saved before the update, today/)).toBeTruthy();
            fireEvent.click(screen.getByRole('button', { name: 'Restore my layout' }));
            await waitFor(() => expect(backupService.getSvil).toHaveBeenCalledWith('this-morning'));
        });

        it("this board's own fresh pre-update backup comes first; older pre-update backups of other boards never do", () => {
            const now = Date.now();
            const own = meta('own-pre', 'sval:1', 30 * 60 * 1000, 'pre-update');
            const other = meta('other-pre', 'sval:2', 5 * 60 * 1000, 'pre-update');
            expect(pickResetBackup([own, other], 'sval:1', 'defaults', { firmware: true, now })?.id).toBe('own-pre');
            // Older than a day: not this install's.
            const stale = meta('stale-pre', 'sval:2', 2 * DAY, 'pre-update');
            const mine = meta('mine', 'sval:1', 10 * DAY, 'edited');
            expect(pickResetBackup([stale, mine], 'sval:1', 'defaults', { firmware: true, now })?.id).toBe('mine');
            // Not a firmware reset (unreadable storage): only this board's.
            expect(pickResetBackup([mine, other], 'sval:1', 'defaults', { firmware: false, now })?.id).toBe('mine');
            // A newer edit of this board after another board's pre-update backup still wins.
            expect(pickResetBackup([other, meta('edit', 'sval:1', 60 * 1000, 'edited')], 'sval:1', 'defaults', { firmware: true, now })?.id).toBe('edit');
        });

        it('never offers the defaults the board holds now, and waits until it can tell them apart', async () => {
            const current = await fingerprintSvil('{"current":true}');
            const snaps = [meta('defaults-now', 'sval:1', 1000, 'connected', { fingerprint: current }), meta('mine', 'sval:1', 2 * HOUR, 'pre-update')];
            expect(pickResetBackup(snaps, 'sval:1', undefined, { firmware: true, now: Date.now() })).toBeUndefined();
            expect(pickResetBackup(snaps, 'sval:1', current, { firmware: true, now: Date.now() })?.id).toBe('mine');
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = snaps;
            render(<StorageResetDialog />);
            // Until the backups can be told apart, nothing to press (an OK would skip the restore).
            expect(screen.queryByRole('button', { name: 'Restore my layout' })).toBeNull();
            fireEvent.click(await screen.findByRole('button', { name: 'Restore my layout' }));
            await waitFor(() => expect(backupService.getSvil).toHaveBeenCalledWith('mine'));
        });

        it('says which firmware is installed now', async () => {
            keyboardContext.keyboard = { kbid: 'abc', storage_build_reset: true };
            backups.snapshots = [meta('mine', 'sval:1', HOUR, 'pre-update')];
            firmwareUpdates.value = { board: board([half(0, 'x4test9', 9, false), half(1, 'x4test9', 9, true)]) };
            render(<StorageResetDialog />);
            expect(await screen.findByText('x4test9 on both halves')).toBeTruthy();
        });

        it('names each half when they differ, and a half that did not answer', () => {
            expect(firmwareLine(board([half(0, 'build 8', 8, false), half(1, 'x4test9', 9, true)]) as never, null)).toBe('build 8 on the left half, x4test9 on the right half');
            expect(firmwareLine(board([half(0, '', 0, false, false), half(1, 'x4', 9, true)]) as never, null)).toBe("x4 on the right half (the left half didn't answer)");
            expect(firmwareLine(null, 'Svalboard QMK v3')).toBe('Svalboard QMK v3');
            expect(firmwareLine(null, null)).toBeNull();
        });
    });
});
