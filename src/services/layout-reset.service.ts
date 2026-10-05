import type { KeyboardInfo } from '@/types/vial.types';
import { usbInstance } from './usb.service';
import { vialService } from './vial.service';

export type LayoutResetMode = 'factory' | 'transparent';

/** Reset mappings only: never use EEPROM/Svil reset, which also erases settings. */
export async function resetLayout(mode: LayoutResetMode, keyboard: KeyboardInfo): Promise<void> {
    const { rows, cols } = keyboard;
    const layers = keyboard.layers ?? 0;
    if (![layers, rows, cols].every(n => Number.isInteger(n) && n > 0)) {
        throw new Error('The keyboard dimensions are unavailable. Reconnect and try again.');
    }
    if (mode === 'factory') {
        const response = await usbInstance.send(0x06, [], { uint8: true });
        if (response[0] !== 0x06) throw new Error('The keyboard did not accept the layout reset.');
    } else {
        // Await each write so disconnects stop the operation instead of queuing thousands of writes.
        for (let layer = 0; layer < layers; layer++) {
            for (let row = 0; row < rows; row++) {
                for (let col = 0; col < cols; col++) {
                    await vialService.updateKey(layer, row, col, 1); // KC_TRNS, including layer 0
                }
            }
        }
        const actual = { ...keyboard };
        await vialService.getKeyMap(actual);
        if (!actual.keymap || actual.keymap.length !== layers || actual.keymap.some(layer =>
            layer.length !== rows * cols || layer.some(key => key !== 1))) {
            throw new Error('Some keys were not cleared. Reconnect and try again.');
        }
    }
}
