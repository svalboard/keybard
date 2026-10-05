import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardInfo } from '../../src/types/vial.types';
import { resetLayout } from '../../src/services/layout-reset.service';
const mock = vi.hoisted(() => ({ send: vi.fn(), updateKey: vi.fn(), getKeyMap: vi.fn() }));
vi.mock('../../src/services/usb.service', () => ({ usbInstance: { send: mock.send } }));
vi.mock('../../src/services/vial.service', () => ({ vialService: mock }));
const keyboard = { layers: 2, rows: 2, cols: 2, keymap: [[4,5,6,7],[8,9,10,11]] } as KeyboardInfo;
beforeEach(() => {
    vi.resetAllMocks();
    mock.send.mockResolvedValue(new Uint8Array([6]));
    mock.getKeyMap.mockImplementation(async kb => { kb.keymap = [[1,1,1,1],[1,1,1,1]]; });
});
describe('layout reset', () => {
    it('uses only the firmware keymap reset, without resetting settings or macros', async () => {
        await resetLayout('factory', keyboard);
        expect(mock.send).toHaveBeenCalledExactlyOnceWith(6, [], { uint8: true });
        expect(mock.updateKey).not.toHaveBeenCalled();
    });
    it('clears every position including layer zero and reads back the result', async () => {
        await resetLayout('transparent', keyboard);
        expect(mock.updateKey.mock.calls).toEqual([
            [0,0,0,1],[0,0,1,1],[0,1,0,1],[0,1,1,1],
            [1,0,0,1],[1,0,1,1],[1,1,0,1],[1,1,1,1],
        ]);
        expect(mock.getKeyMap).toHaveBeenCalledOnce();
        expect(keyboard.keymap[0][0]).toBe(4);
    });
    it('stops on a failed write', async () => {
        mock.updateKey.mockRejectedValueOnce(new Error('disconnected'));
        await expect(resetLayout('transparent', keyboard)).rejects.toThrow('disconnected');
        expect(mock.updateKey).toHaveBeenCalledOnce();
    });
    it('rejects a readback mismatch', async () => {
        mock.getKeyMap.mockImplementation(async kb => { kb.keymap = [[4,1,1,1],[1,1,1,1]]; });
        await expect(resetLayout('transparent', keyboard)).rejects.toThrow('Some keys');
    });
    it('rejects missing dimensions before touching firmware', async () => {
        await expect(resetLayout('factory', { ...keyboard, layers: 0 })).rejects.toThrow('dimensions');
        expect(mock.send).not.toHaveBeenCalled();
    });
    it('rejects an unsupported reset response', async () => {
        mock.send.mockResolvedValue(new Uint8Array([255]));
        await expect(resetLayout('factory', keyboard)).rejects.toThrow('did not accept');
    });
});
