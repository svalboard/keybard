// The touchpad mode is a board setting, not layout. The backup Keybard takes right before an
// update records it, and only the update's restore puts it back: at once, read back, no
// confirmation, never a pending change. The same backup file through the normal import
// leaves the mode alone. Both with Live Updating on (queued writes run at once) and off
// (they wait for the commit).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileService } from '../../src/services/file.service';
import { prepareImport } from '../../src/services/import-preflight';
import { restoreLayoutToBoard } from '../../src/features/firmware/restore';
import { boardStateFromSvil, withBoardState } from '../../src/features/firmware/board-state';
import { customValueService } from '../../src/services/custom-value.service';
import { usbInstance } from '../../src/services/usb.service';
import { PAD_MODE_AUTO, PAD_MODE_BUILTIN, PAD_MODE_KEY } from '../../src/utils/touchpad-tuning';
import type { KeyboardInfo } from '../../src/types/keyboard.types';

const getPointingHardware = vi.fn(async (kb: KeyboardInfo) => { kb.pointing_hardware = { read: true } as never; });
vi.mock('@/services/keyboard.service', () => ({ keyboardService: { saveSvil: vi.fn(async () => {}), getPointingHardware: (kb: KeyboardInfo) => getPointingHardware(kb) } }));

const CH = 0, MODE_ID = 59, DZ_ID = 54;
const DZ_KEY = 'id_pad_dead_zone';

const board = (mode: number, deadZone: number): KeyboardInfo => ({
    rows: 1, cols: 2, layers: 1, keymap: [[4, 5]], svil_proto: 3, kbid: 'e4655015c33e122f',
    macros: [], macro_count: 0, macros_size: 64, combos: [], combo_count: 0,
    tapdances: [], tapdance_count: 0, key_overrides: [], key_override_count: 0, cosmetic: {},
    custom_values: [
        { key: PAD_MODE_KEY, channel: CH, valueId: MODE_ID, data: [mode] },
        { key: DZ_KEY, channel: CH, valueId: DZ_ID, data: [deadZone] },
    ],
});
const modeOf = (kb: KeyboardInfo | null) => kb?.custom_values?.find(e => e.key === PAD_MODE_KEY)?.data[0];

// What the board holds: VIA custom values by id.
let onBoard: Map<number, number>;
let modeWrites: number;
beforeEach(() => {
    usbInstance.svilProtocolVersion = 3;
    modeWrites = 0;
    vi.spyOn(usbInstance, 'sendSvil').mockImplementation(async (cmd: number) => Uint8Array.of(cmd, 0) as never);
    vi.spyOn(usbInstance, 'customValueSet').mockImplementation(async (_ch: number, id: number, data: number[]) => {
        if (id === MODE_ID) modeWrites++;
        onBoard.set(id, data[0]);
    });
    vi.spyOn(usbInstance, 'customValueGet').mockImplementation(async (_ch: number, id: number) => Uint8Array.of(onBoard.get(id) ?? 0) as never);
    vi.spyOn(usbInstance, 'customValueSave').mockImplementation(async () => {});
});
afterEach(() => { vi.restoreAllMocks(); });

/** The pre-update backup of a board in Built-in gestures (makeBackup: withBoardState over serializeForBackup). */
const backupOf = (kb: KeyboardInfo) => withBoardState(fileService.kbinfoToSvil(structuredClone(kb), true), kb);

/** A change queue as ChangesContext runs it: at once with Live Updating, at the commit without. */
function changes(live: boolean) {
    const waiting: Array<() => Promise<void>> = [];
    const descs: string[] = [];
    return {
        descs,
        queue: async (desc: string, cb: () => Promise<void>) => { descs.push(desc); if (live) await cb(); else waiting.push(cb); },
        commit: async () => { for (const cb of waiting.splice(0)) await cb(); return true; },
    };
}

/** The editor's two copies of the board: the draft and the loaded copy, patched alike by board state. */
function editor(kb: KeyboardInfo) {
    const e = { draft: kb as KeyboardInfo | null, loaded: kb as KeyboardInfo | null };
    return {
        e,
        setKeyboard: (next: KeyboardInfo) => { e.draft = next; },
        markSaved: (next: KeyboardInfo) => { e.loaded = next; },
        applyBoardState: (patch: (k: KeyboardInfo) => KeyboardInfo) => { e.draft = e.draft && patch(e.draft); e.loaded = e.loaded && patch(e.loaded); },
    };
}

describe.each([true, false])('Touchpad mode across an update (Live Updating %s)', (live) => {
    it('the backup records the mode; the update restore puts Built-in gestures back at once', async () => {
        const before = board(PAD_MODE_BUILTIN, 5);
        const svil = backupOf(before);
        expect(boardStateFromSvil(svil)).toEqual({ touchpad_mode: PAD_MODE_BUILTIN });
        expect(fileService.parseContent(svil).kbid).toBe('e4655015c33e122f'); // the UID survives the added field

        // The update reset the board's settings: Automatic, dead zone back to the default.
        onBoard = new Map([[MODE_ID, PAD_MODE_AUTO], [DZ_ID, 0]]);
        const after = board(PAD_MODE_AUTO, 0);
        const ed = editor(after);
        const ch = changes(live);
        customValueService.populateCacheFromEntries(after.custom_values!);
        await restoreLayoutToBoard(svil, { keyboard: after, ...ed, queue: ch.queue, commit: ch.commit });

        expect(onBoard.get(MODE_ID)).toBe(PAD_MODE_BUILTIN);
        expect(modeWrites).toBe(1);
        expect(ch.descs.some(d => d.includes(PAD_MODE_KEY))).toBe(false); // never a pending change
        expect(modeOf(ed.e.draft)).toBe(PAD_MODE_BUILTIN);
        expect(modeOf(ed.e.loaded)).toBe(PAD_MODE_BUILTIN); // board state: no unsaved change
        expect(getPointingHardware).toHaveBeenCalled();
    });

    it('the same backup file through the normal import leaves the mode alone', async () => {
        const svil = backupOf(board(PAD_MODE_BUILTIN, 5));
        onBoard = new Map([[MODE_ID, PAD_MODE_AUTO], [DZ_ID, 0]]);
        const after = board(PAD_MODE_AUTO, 0);
        customValueService.populateCacheFromEntries(after.custom_values!);
        const plan = prepareImport(await fileService.loadFile(new File([svil], 'backup.svil', { type: 'application/json' })), after);
        expect(plan.errors).toEqual([]);
        const ch = changes(live);
        const { importService } = await import('../../src/services/import.service');
        const { keyboardService } = await import('../../src/services/keyboard.service');
        await importService.syncWithKeyboard(plan.keyboard, after, ch.queue, { keyboardService } as never);
        await ch.commit();

        expect(onBoard.get(MODE_ID)).toBe(PAD_MODE_AUTO);
        expect(modeWrites).toBe(0);
        expect(modeOf(plan.keyboard)).toBe(PAD_MODE_AUTO);
    });
});

describe('the restore of other backups', () => {
    it('a backup without a recorded mode (any connected or manual snapshot, any export) changes nothing', async () => {
        const svil = fileService.kbinfoToSvil(structuredClone(board(PAD_MODE_BUILTIN, 5)), true);
        expect(boardStateFromSvil(svil)).toBeNull();
        onBoard = new Map([[MODE_ID, PAD_MODE_AUTO], [DZ_ID, 0]]);
        const after = board(PAD_MODE_AUTO, 0);
        const ed = editor(after);
        const ch = changes(true);
        await restoreLayoutToBoard(svil, { keyboard: after, ...ed, queue: ch.queue, commit: ch.commit });
        expect(modeWrites).toBe(0);
        expect(onBoard.get(MODE_ID)).toBe(PAD_MODE_AUTO);
    });

    it('a mode the board does not take is reported, with the board state shown', async () => {
        const svil = backupOf(board(PAD_MODE_BUILTIN, 5));
        onBoard = new Map([[MODE_ID, PAD_MODE_AUTO], [DZ_ID, 0]]);
        vi.spyOn(usbInstance, 'customValueSet').mockImplementation(async (_ch: number, id: number, data: number[]) => { if (id !== MODE_ID) onBoard.set(id, data[0]); });
        const after = board(PAD_MODE_AUTO, 0);
        const ed = editor(after);
        const ch = changes(true);
        await expect(restoreLayoutToBoard(svil, { keyboard: after, ...ed, queue: ch.queue, commit: ch.commit })).rejects.toThrow(/Your layout is back, but not Touchpad mode. It was Built-in gestures before the update/);
        expect(modeOf(ed.e.draft)).toBe(PAD_MODE_AUTO);
        expect(modeOf(ed.e.loaded)).toBe(PAD_MODE_AUTO);
    });
});
