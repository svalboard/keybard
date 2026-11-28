import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_REPORT_LENGTH, payloadCapacity, reportLength } from '../../src/services/hid-report';
import { SvilUSB } from '../../src/services/usb.service';
import { MacroService } from '../../src/services/macro.service';
import { IdentityService, IDENTITY_CHANNEL } from '../../src/services/identity.service';

const WRAPPER = 0xdd;

type Item = { reportSize: number; reportCount: number };

/** A HIDDevice-shaped object with one collection whose output report has these items. */
function fakeCollectionDevice(usagePage: number, usage: number, items: Item[] | null) {
    return {
        collections: [
            // An unrelated keyboard collection first, as a composite device lists it
            { usagePage: 0x01, usage: 0x06, inputReports: [], outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 1 }] }], featureReports: [] },
            { usagePage, usage, inputReports: [], outputReports: items ? [{ reportId: 0, items }] : [], featureReports: [] },
        ],
    } as unknown as HIDDevice;
}

describe('reportLength', () => {
    it('reads 32 bytes from a raw HID output report', () => {
        expect(reportLength(fakeCollectionDevice(0xff60, 0x61, [{ reportSize: 8, reportCount: 32 }]))).toBe(32);
    });

    it('reads 64 bytes from a raw HID output report', () => {
        expect(reportLength(fakeCollectionDevice(0xff60, 0x61, [{ reportSize: 8, reportCount: 64 }]))).toBe(64);
        expect(reportLength(fakeCollectionDevice(0xff61, 0x62, [{ reportSize: 8, reportCount: 64 }]))).toBe(64);
    });

    it('sums the items of the report', () => {
        const items = [{ reportSize: 8, reportCount: 48 }, { reportSize: 16, reportCount: 8 }];
        expect(reportLength(fakeCollectionDevice(0xff60, 0x62, items))).toBe(64);
    });

    it('falls back to 32 when the size cannot be read', () => {
        expect(reportLength(null)).toBe(DEFAULT_REPORT_LENGTH);
        expect(reportLength({} as HIDDevice)).toBe(32);
        expect(reportLength(fakeCollectionDevice(0xff60, 0x61, null))).toBe(32);
        expect(reportLength(fakeCollectionDevice(0xff60, 0x61, []))).toBe(32);
        // Only the raw HID collection counts, not the keyboard one
        expect(reportLength(fakeCollectionDevice(0x0c, 0x01, [{ reportSize: 8, reportCount: 64 }]))).toBe(32);
        // Too small to carry the protocol
        expect(reportLength(fakeCollectionDevice(0xff60, 0x61, [{ reportSize: 8, reportCount: 8 }]))).toBe(32);
    });

    it('payloadCapacity subtracts the header from the report length', () => {
        expect(payloadCapacity({ reportLength: 64 }, 10)).toBe(54);
        expect(payloadCapacity({ reportLength: 32 }, 10)).toBe(22);
        expect(payloadCapacity({}, 10)).toBe(22);
    });
});

/**
 * A fake Svalboard with reports of `len` bytes: the client wrapper, VIA keymap
 * buffer reads and Sval definition chunks (capped at `definitionCap` bytes, as
 * the firmware's SVAL_DEFINITION_CHUNK_SIZE does).
 */
function fakeKeyboard(len: number, definition: Uint8Array, definitionCap = 22) {
    const listeners = new Set<(ev: { data: DataView }) => void>();
    const sent: Uint8Array[] = [];
    const deliver = (frame: Uint8Array) => {
        const buf = new Uint8Array(len); buf.set(frame.slice(0, len));
        for (const l of Array.from(listeners)) l({ data: new DataView(buf.buffer) });
    };
    const device = {
        productName: 'Svalboard', vendorId: 0xd7c0, productId: 0x0001, opened: false,
        collections: [{
            usagePage: 0xff60, usage: 0x61, inputReports: [], featureReports: [],
            outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: len }] }],
        }],
        open: vi.fn(async () => { device.opened = true; }),
        close: vi.fn(async () => { device.opened = false; }),
        addEventListener: vi.fn((_t: string, l: (ev: { data: DataView }) => void) => { listeners.add(l); }),
        removeEventListener: vi.fn((_t: string, l: (ev: { data: DataView }) => void) => { listeners.delete(l); }),
        sendReport: vi.fn(async (_id: number, data: BufferSource) => {
            const msg = new Uint8Array(data as ArrayBuffer).slice();
            sent.push(msg);
            setTimeout(() => {
                const f = new Uint8Array(len);
                f.set(msg.slice(0, 6));
                const clientId = msg[1] | (msg[2] << 8) | (msg[3] << 16) | (msg[4] << 24);
                if (clientId === 0) {
                    f.set(msg.slice(5, 25), 5);
                    f[25] = 0x11; f[26] = 0x22; f[27] = 0x33; f[28] = 0x44; f[29] = 120;
                } else if (msg[5] === 0xfe && msg[6] === SvilUSB.CMD_VIA_KEYMAP_GET_BUFFER) {
                    // VIA sees the full report; its reply loses the last 6 bytes to the wrapper
                    const offset = (msg[7] << 8) | msg[8];
                    const size = msg[9];
                    const via = new Uint8Array(len);
                    via.set(msg.slice(6, 10));
                    for (let i = 0; i < size; i++) via[4 + i] = (offset + i) & 0xff;
                    f.set(via.slice(0, len - 6), 6);
                } else if (msg[5] === 0xdf && msg[6] === SvilUSB.CMD_SVIL_DEFINITION_SIZE) {
                    f[6] = msg[6];
                    f[7] = definition.length & 0xff; f[8] = definition.length >> 8;
                } else if (msg[5] === 0xdf && msg[6] === SvilUSB.CMD_SVIL_DEFINITION_CHUNK) {
                    const offset = msg[7] | (msg[8] << 8);
                    const want = Math.min(msg[9] || definitionCap, definitionCap);
                    const chunk = definition.slice(offset, offset + want);
                    f.set([msg[6], msg[7], msg[8], chunk.length, ...chunk], 6);
                } else {
                    f[6] = msg[6]; // the firmware repeats the command byte
                }
                deliver(f);
            }, 0);
        }),
    };
    return { device, sent };
}

describe('SvilUSB report length', () => {
    for (const len of [32, 64]) {
        it(`sends ${len}-byte reports to a ${len}-byte device`, async () => {
            const { device, sent } = fakeKeyboard(len, new Uint8Array(0));
            const usb = new SvilUSB();
            await usb.openDevice(device as unknown as HIDDevice);
            expect(usb.reportLength).toBe(len);
            await usb.send(SvilUSB.CMD_VIA_GET_PROTOCOL_VERSION, []);
            expect(sent.length).toBe(2); // bootstrap, command
            expect(sent.every(m => m.length === len)).toBe(true);
            expect(sent[0][0]).toBe(WRAPPER);
            await usb.close();
            expect(usb.reportLength).toBe(32);
        });
    }

    it('reads a keymap buffer in 22-byte chunks at 32 and 54-byte chunks at 64', async () => {
        const size = 120;
        const expected = { 32: [0, 22, 44, 66, 88, 110], 64: [0, 54, 108] } as Record<number, number[]>;
        for (const len of [32, 64]) {
            const { device, sent } = fakeKeyboard(len, new Uint8Array(0));
            const usb = new SvilUSB();
            await usb.openDevice(device as unknown as HIDDevice);
            const data = await usb.getViaBuffer(SvilUSB.CMD_VIA_KEYMAP_GET_BUFFER, size,
                { uint16: true, slice: 2, bigendian: true, bytes: 2 }) as number[];
            const reads = sent.filter(m => m[5] === 0xfe && m[6] === SvilUSB.CMD_VIA_KEYMAP_GET_BUFFER);
            expect(reads.map(m => (m[7] << 8) | m[8])).toEqual(expected[len]);
            expect(reads.map(m => m[9])).toEqual(expected[len].map(o => Math.min(len - 10, size - o)));
            expect(data.length).toBe(size / 2);
            // Keycodes are big-endian pairs of the fake's byte pattern
            expect(data.slice(0, 3)).toEqual([0x0001, 0x0203, 0x0405]);
            expect(data[data.length - 1]).toBe((118 << 8) | 119);
            await usb.close();
        }
    });

    it('asks for larger definition chunks at 64 and keeps reading when the firmware caps them', async () => {
        const definition = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) & 0xff);
        for (const [len, cap] of [[32, 22], [64, 22], [64, 54]]) {
            const { device, sent } = fakeKeyboard(len, definition, cap);
            const usb = new SvilUSB();
            await usb.openDevice(device as unknown as HIDDevice);
            const got = await usb.getSvilDefinition();
            expect(Array.from(got)).toEqual(Array.from(definition));
            const chunks = sent.filter(m => m[5] === 0xdf && m[6] === SvilUSB.CMD_SVIL_DEFINITION_CHUNK);
            expect(chunks[0][9]).toBe(len - 10);
            expect(chunks.length).toBe(Math.ceil(definition.length / cap));
            await usb.close();
        }
    });
});

describe('Chunk sizes in services', () => {
    const fakeSvil = (reportLength: number) => ({
        reportLength,
        svilProtocolVersion: 3,
        send: vi.fn(),
        sendSvil: vi.fn((cmd: number, args: number[]) => {
            if (cmd === SvilUSB.CMD_SVIL_MACRO_BUFFER_GET) {
                const count = args[4];
                return Promise.resolve(new Uint8Array([cmd, ...args.slice(0, 5), ...new Array(count).fill(1)]));
            }
            return Promise.resolve(new Uint8Array([cmd, 0]));
        }),
    });

    it('macro buffer reads and writes use 20 bytes at 32 and 52 at 64', async () => {
        for (const [len, chunk] of [[32, 20], [64, 52]]) {
            const usb = fakeSvil(len);
            const macros = new MacroService(usb as unknown as SvilUSB);
            const kbinfo = { macro_count: 1, macros_size: 130 } as never;
            await macros.get(kbinfo);
            const reads = usb.sendSvil.mock.calls.filter(c => c[0] === SvilUSB.CMD_SVIL_MACRO_BUFFER_GET);
            expect(reads.map(c => c[1][0] | (c[1][1] << 8))).toEqual(
                Array.from({ length: Math.ceil(130 / chunk) }, (_, i) => i * chunk));
            expect(reads.map(c => c[1][4])).toEqual(
                Array.from({ length: Math.ceil(130 / chunk) }, (_, i) => Math.min(chunk, 130 - i * chunk)));

            usb.sendSvil.mockClear();
            await (macros as unknown as { pushSvilBuffer(n: number, b: Uint8Array): Promise<void> })
                .pushSvilBuffer(130, new Uint8Array(130));
            const writes = usb.sendSvil.mock.calls.filter(c => c[0] === SvilUSB.CMD_SVIL_MACRO_BUFFER_SET);
            expect(writes.length).toBe(Math.ceil(130 / chunk));
            // Every write fits the report: wrapper + [cmd] + args
            expect(writes.every(c => 6 + 1 + c[1].length <= len)).toBe(true);
            expect(writes[0][1][4]).toBe(chunk);
        }
    });

    it('board name writes use 21-byte chunks at 32 and 53 at 64', async () => {
        const name = 'x'.repeat(60);
        for (const [len, chunk] of [[32, 21], [64, 53]]) {
            const usb = {
                reportLength: len,
                send: vi.fn((_cmd: number, _args: number[]) => Promise.resolve(new Uint8Array([0]))),
            };
            await new IdentityService(usb as unknown as SvilUSB).setName(name);
            const names = usb.send.mock.calls.filter(c => c[1][0] === IDENTITY_CHANNEL && c[1][1] === 1);
            expect(names.map(c => c[1][2])).toEqual(
                Array.from({ length: Math.ceil(60 / chunk) }, (_, i) => i * chunk));
            expect(names.every(c => 6 + 1 + c[1].length <= len)).toBe(true);
        }
    });
});
