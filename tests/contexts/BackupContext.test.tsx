import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupProvider, EDIT_SETTLE_MS, boardKeyFor, serializeForBackup } from '../../src/contexts/BackupContext';
import { ComboOptions } from '../../src/types/keyboard.types';
import { BackupService } from '../../src/services/backup/backup.service';
import { MemoryBackupStore } from '../../src/services/backup/store';
import { SerialSource } from '../../src/services/identity.service';
import type { KeyboardInfo } from '../../src/types/keyboard.types';

const state = vi.hoisted(() => ({
    keyboard: null as KeyboardInfo | null,
    isConnected: false,
    session: 1,
    pending: 0,
    setKeyboard: vi.fn(),
}));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard: state.keyboard, setKeyboard: state.setKeyboard, isConnected: state.isConnected, connectionSessionId: state.session, loadedFrom: 'Svalboard' }) }));
vi.mock('@/contexts/ChangesContext', () => ({ useChanges: () => ({ getPendingCount: () => state.pending }) }));

const board = (k0 = 4): KeyboardInfo => ({
    rows: 1, cols: 2, layers: 1, kbid: 'abcdef', name: 'Svalboard', keymap: [[k0, 5]],
    macros: [], macro_count: 0, combos: [], tapdances: [], key_overrides: [], settings: {},
} as KeyboardInfo);
const identity = { available: true, name: 'Desk', nameMaxBytes: 32, serialSource: SerialSource.FlashId, serial: 'sval:E46498769F365934' };

let store: MemoryBackupStore;
let service: BackupService;
const readIdentity = vi.fn(async () => identity);
const ui = () => <BackupProvider service={service} readIdentity={readIdentity}><span /></BackupProvider>;
const realTimeout = globalThis.setTimeout;
// Hashing, compression and the combo-name lookup finish outside the fake clock; give them real time.
const settle = async () => { await act(async () => { await new Promise((r) => realTimeout(r, 150)); }); };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 9, 6, 12));
    store = new MemoryBackupStore();
    service = new BackupService(store);
    state.keyboard = null; state.isConnected = false; state.session = 1; state.pending = 0;
    state.setKeyboard.mockReset();
    state.setKeyboard.mockImplementation((update: unknown) => {
        state.keyboard = typeof update === 'function' ? (update as (k: KeyboardInfo | null) => KeyboardInfo | null)(state.keyboard) : update as KeyboardInfo;
    });
    readIdentity.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('BackupProvider triggers', () => {
    it('snapshots a board once it has connected and loaded, keyed by its serial', async () => {
        const view = render(ui());
        state.isConnected = true; state.keyboard = board(); state.session = 2;
        view.rerender(ui());
        await settle();
        const snaps = await service.listSnapshots();
        expect(snaps).toHaveLength(1);
        expect(snaps[0]).toMatchObject({ boardKey: 'sval:E46498769F365934', boardName: 'Desk', kind: 'connected', includesPending: false });
    });

    it('saves an edited snapshot after the state settles, flagging unsent changes', async () => {
        state.isConnected = true; state.keyboard = board();
        const view = render(ui());
        await settle();
        state.keyboard = board(9); state.pending = 1;
        view.rerender(ui());
        await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_SETTLE_MS - 100); });
        expect(await service.listSnapshots()).toHaveLength(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        await settle();
        const [latest] = await service.listSnapshots();
        expect(latest).toMatchObject({ kind: 'edited', includesPending: true, pendingCount: 1, summary: '1 key' });
    });

    it('saves right away when the tab is hidden', async () => {
        state.isConnected = true; state.keyboard = board();
        const view = render(ui());
        await settle();
        state.keyboard = board(7);
        view.rerender(ui());
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        await settle();
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        expect(await service.listSnapshots()).toHaveLength(2);
    });

    it('does not back up a layout opened from a file', async () => {
        state.isConnected = true; state.keyboard = board();
        const view = render(ui());
        await settle();
        // loadFromFile: a new session, offline.
        state.isConnected = false; state.session = 3; state.keyboard = board(8);
        view.rerender(ui());
        await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_SETTLE_MS * 2); });
        await settle();
        expect(await service.listSnapshots()).toHaveLength(1);
    });
});

describe('combo names on connect', () => {
    const ON = ComboOptions.ENABLED;
    const withCombos = (output1: string): KeyboardInfo => ({
        ...board(),
        combos: [
            { cmbid: 0, keys: ['KC_J', 'KC_K', 'KC_NO', 'KC_NO'], output: 'KC_ESC', options: ON },
            { cmbid: 1, keys: ['KC_D', 'KC_F', 'KC_NO', 'KC_NO'], output: output1, options: ON },
        ],
        combo_count: 2,
    } as KeyboardInfo);

    it('restores names from the latest backup only for unchanged combos, and the connected snapshot keeps them', async () => {
        const named = { ...withCombos('KC_ENTER'), cosmetic: { combos: { '0': 'Dictation', '1': 'Zoom mute' } } };
        await service.saveSnapshot({ boardKey: identity.serial, boardName: 'Desk', svil: serializeForBackup(named), kind: 'edited', pendingCount: 0 });
        // Combo 1 was changed on another computer since that backup.
        state.isConnected = true; state.keyboard = withCombos('KC_TAB'); state.session = 2;
        render(ui());
        // Wait for the restore and the connected snapshot, not a fixed time (slow under a full run).
        await vi.waitFor(async () => {
            expect(state.keyboard?.cosmetic?.combos).toEqual({ '0': 'Dictation' });
            const [latest] = await service.listSnapshots();
            expect(latest.kind).toBe('connected');
            expect(JSON.parse(await service.getSvil(latest.id)).cosmetic.combos).toEqual({ '0': 'Dictation' });
        }, { timeout: 5000, interval: 25 });
    });

    it('changes nothing when the backup has no combo names', async () => {
        await service.saveSnapshot({ boardKey: identity.serial, boardName: 'Desk', svil: serializeForBackup(withCombos('KC_ENTER')), kind: 'edited', pendingCount: 0 });
        state.isConnected = true; state.keyboard = withCombos('KC_ENTER'); state.session = 2;
        render(ui());
        await settle();
        expect(state.setKeyboard).not.toHaveBeenCalled();
    });

    it('backs up a name-only edit with nothing pending, and the next connect brings the name back', async () => {
        state.isConnected = true; state.keyboard = withCombos('KC_ENTER');
        const view = render(ui());
        await settle();
        // Rename combo 1 only: no board write, so nothing is pending.
        state.keyboard = { ...withCombos('KC_ENTER'), cosmetic: { combos: { '1': 'Zoom mute' } } };
        view.rerender(ui());
        await act(async () => { await vi.advanceTimersByTimeAsync(EDIT_SETTLE_MS + 100); });
        await settle();
        const [latest] = await service.listSnapshots();
        expect(latest).toMatchObject({ kind: 'edited', includesPending: false, pendingCount: 0 });
        expect(JSON.parse(await service.getSvil(latest.id)).cosmetic.combos).toEqual({ '1': 'Zoom mute' });
        view.unmount();
        // The tab closed; the board connects again with no names of its own.
        state.keyboard = withCombos('KC_ENTER'); state.session = 5;
        render(ui());
        await settle();
        expect(state.keyboard?.cosmetic?.combos).toEqual({ '1': 'Zoom mute' });
    });

    it('uses only this board\'s backups', async () => {
        const named = { ...withCombos('KC_ENTER'), cosmetic: { combos: { '0': 'Dictation' } } };
        await service.saveSnapshot({ boardKey: 'sval:0123456789ABCDEF', boardName: 'Other', svil: serializeForBackup(named), kind: 'edited', pendingCount: 0 });
        state.isConnected = true; state.keyboard = withCombos('KC_ENTER'); state.session = 2;
        render(ui());
        await settle();
        expect(state.setKeyboard).not.toHaveBeenCalled();
    });
});

describe('boardKeyFor', () => {
    it('prefers the persistent serial and falls back to the UID', () => {
        expect(boardKeyFor(identity, board())).toBe('sval:E46498769F365934');
        expect(boardKeyFor(null, board())).toBe('uid:ABCDEF');
        expect(boardKeyFor({ ...identity, serialSource: SerialSource.None, serial: 'sval:0000000000000000' }, board())).toBe('uid:ABCDEF');
    });
});
