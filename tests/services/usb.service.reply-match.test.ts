import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    SvilUSB, isReplyTo, replyTimeoutFor, REPLY_TIMEOUT_MS, WRITE_REPLY_TIMEOUT_MS, STALE_REPLY_MS,
} from '../../src/services/usb.service';

const WRAPPER = 0xdd;
const VIA = 0xfe;
const SVIL = 0xdf;
const GET = SvilUSB.CMD_VIA_LIGHTING_GET_VALUE;
const SET = SvilUSB.CMD_VIA_LIGHTING_SET_VALUE;

type Reply = { frame: Uint8Array; delayMs: number };

/**
 * A fake board that answers bootstraps itself and every wrapped command through `respond`,
 * which returns the reports to send back and when (ms after the request). Like the firmware, it
 * answers in order: a reply never overtakes one to an earlier request.
 */
function makeBoard(respond: (clientId: number, msg: Uint8Array, n: number) => Reply[]) {
    const listeners = new Set<(ev: { data: DataView }) => void>();
    const sent: Uint8Array[] = [];
    let busyUntil = 0;
    let n = 0;
    const deliver = (frame: Uint8Array) => {
        const buf = new Uint8Array(32); buf.set(frame.slice(0, 32));
        for (const l of Array.from(listeners)) l({ data: new DataView(buf.buffer) });
    };
    const device = {
        productName: 'Svalboard', vendorId: 0xd7c0, productId: 0x0001, opened: false,
        collections: [{ usagePage: 0xff60, usage: 0x61, inputReports: [], outputReports: [], featureReports: [] }],
        open: vi.fn(async () => { device.opened = true; }),
        close: vi.fn(async () => { device.opened = false; }),
        addEventListener: vi.fn((_t: string, l: (ev: { data: DataView }) => void) => { listeners.add(l); }),
        removeEventListener: vi.fn((_t: string, l: (ev: { data: DataView }) => void) => { listeners.delete(l); }),
        sendReport: vi.fn(async (_id: number, data: BufferSource) => {
            const msg = new Uint8Array(data as ArrayBuffer).slice();
            sent.push(msg);
            const clientId = (msg[1] | (msg[2] << 8) | (msg[3] << 16) | (msg[4] << 24)) >>> 0;
            if (clientId === 0) {
                const f = new Uint8Array(32); f[0] = WRAPPER; f.set(msg.slice(5, 25), 5);
                f[25] = 0x1d; f[26] = 0x03; f[27] = 0x05; f[28] = 0; f[29] = 120;
                setTimeout(() => deliver(f), 0);
                return;
            }
            for (const r of respond(clientId, msg, n++)) {
                const at = Math.max(Date.now() + r.delayMs, busyUntil);
                busyUntil = at;
                setTimeout(() => deliver(r.frame), at - Date.now());
            }
        }),
    };
    return { device, sent };
}

/** [0xDD][client id][protocol][payload...] */
const frame = (clientId: number, protocol: number, payload: number[]) => {
    const f = new Uint8Array(32); f[0] = WRAPPER;
    f[1] = clientId & 0xff; f[2] = (clientId >> 8) & 0xff; f[3] = (clientId >> 16) & 0xff; f[4] = (clientId >> 24) & 0xff;
    f[5] = protocol; f.set(payload, 6); return f;
};
/** The firmware's reply to a VIA custom value GET: the request repeated, then the value. */
const valueReply = (clientId: number, msg: Uint8Array, value: number) =>
    frame(clientId, VIA, [msg[6], msg[7], msg[8], value]);

const get = (usb: SvilUSB, valueId: number, timeoutMs = 60) =>
    usb.send(GET, [0x00, valueId], { uint8: true, skipBytes: 3, timeoutMs }) as Promise<Uint8Array>;

async function connect(board: ReturnType<typeof makeBoard>) {
    const usb = new SvilUSB();
    await usb.openDevice(board.device as unknown as HIDDevice);
    return usb;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('SvilUSB reply matching', () => {
    it('drops the late reply to a timed-out command; the next identical command gets its own', async () => {
        // The first GET is answered after 150 ms (a consolidation), long after its 60 ms timeout.
        const board = makeBoard((id, msg, n) => [{ frame: valueReply(id, msg, n === 0 ? 1 : 2), delayMs: n === 0 ? 150 : 0 }]);
        const usb = await connect(board);
        await expect(get(usb, 0x10)).rejects.toThrow(/timeout/i);
        // Sent before the late reply arrives; the board answers it after that reply.
        const second = await get(usb, 0x10, 500);
        expect(Array.from(second.slice(0, 1))).toEqual([2]);
        await usb.close();
    });

    it('drops the late reply when the next command asks for something else', async () => {
        const board = makeBoard((id, msg, n) => [{ frame: valueReply(id, msg, 0x40 + msg[8]), delayMs: n === 0 ? 150 : 0 }]);
        const usb = await connect(board);
        await expect(get(usb, 0x10)).rejects.toThrow(/timeout/i);
        const next = await get(usb, 0x11, 500);
        expect(next[0]).toBe(0x51);
        // And the one after that is not shifted by one either.
        expect((await get(usb, 0x12, 500))[0]).toBe(0x52);
        await usb.close();
    });

    it('does not hold the next command back after a timeout', async () => {
        const board = makeBoard((id, msg, n) => (n === 0 ? [] : [{ frame: valueReply(id, msg, 7), delayMs: 0 }]));
        const usb = await connect(board);
        await expect(get(usb, 0x10)).rejects.toThrow(/timeout/i);
        const t0 = Date.now();
        expect((await get(usb, 0x11, 500))[0]).toBe(7);
        expect(Date.now() - t0).toBeLessThan(100);
        await usb.close();
    });

    it('recovers when a timed-out reply never comes and the next command is identical', async () => {
        // The board lost the first reply. The second identical reply is taken for the late one,
        // so that command times out too; the third is answered: nothing stays shifted.
        const board = makeBoard((id, msg, n) => (n === 0 ? [] : [{ frame: valueReply(id, msg, n), delayMs: 0 }]));
        const usb = await connect(board);
        await expect(get(usb, 0x10)).rejects.toThrow(/timeout/i);
        await expect(get(usb, 0x10)).rejects.toThrow(/timeout/i);
        expect((await get(usb, 0x10, 500))[0]).toBe(2);
        await usb.close();
    });

    it('ignores a report whose echo does not match, and takes the matching one', async () => {
        const board = makeBoard((id, msg) => [
            { frame: frame(id, VIA, [msg[6], msg[7], msg[8] + 1, 0x99]), delayMs: 0 }, // another value ID
            { frame: frame(id, VIA, [SET, msg[7], msg[8], 0x98]), delayMs: 0 },        // another command
            { frame: frame(id, SVIL, [msg[6], msg[7], msg[8], 0x97]), delayMs: 0 },    // the Sval protocol
            { frame: frame(id + 1, VIA, [msg[6], msg[7], msg[8], 0x96]), delayMs: 0 }, // another client
            { frame: valueReply(id, msg, 0x42), delayMs: 0 },
        ]);
        const usb = await connect(board);
        expect((await get(usb, 0x10, 500))[0]).toBe(0x42);
        await usb.close();
    });

    it('leaves normal back-to-back traffic as it was', async () => {
        const board = makeBoard((id, msg) => {
            if (msg[5] === SVIL) return [{ frame: frame(id, SVIL, [msg[6], 0]), delayMs: 0 }]; // [cmd][status]
            if (msg[6] === 0xee) return [{ frame: frame(id, VIA, [0xff, ...msg.slice(7, 12)]), delayMs: 0 }]; // id_unhandled
            return [{ frame: valueReply(id, msg, msg[8] * 2), delayMs: 0 }];
        });
        const usb = await connect(board);
        const t0 = Date.now();
        for (let i = 0; i < 30; i++) expect((await get(usb, i, 500))[0]).toBe((i * 2) & 0xff);
        // A Sval write's reply overwrites its arguments with a status: only the command is checked.
        const status = await usb.sendSvil(SvilUSB.CMD_SVIL_COMBO_SET, [3, 0, 1, 2], { uint8: true });
        expect(Array.from(status.slice(0, 2))).toEqual([SvilUSB.CMD_SVIL_COMBO_SET, 0]);
        // An unhandled VIA command still gets its reply, not a timeout.
        const unhandled = await usb.send(0xee, [0x01], { uint8: true }) as Uint8Array;
        expect(unhandled[0]).toBe(0xff);
        expect(Date.now() - t0).toBeLessThan(1000);
        await usb.close();
    });

    it('waits out a long pause on a write', async () => {
        const board = makeBoard((id, msg) => [{ frame: frame(id, VIA, Array.from(msg.slice(6, 12))), delayMs: 1300 }]);
        const usb = await connect(board);
        await expect(usb.customValueSet(0x00, 0x10, [1])).resolves.toBeUndefined();
        await usb.close();
    }, 5000);

    it('forgets a timed-out command after STALE_REPLY_MS', async () => {
        const board = makeBoard((id, msg, n) => (n === 0 ? [] : [{ frame: valueReply(id, msg, 9), delayMs: 0 }]));
        const usb = await connect(board);
        await expect(get(usb, 0x10)).rejects.toThrow(/timeout/i);
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + STALE_REPLY_MS + 1);
        // Its reply was never sent: once the entry expires, a matching reply is taken again.
        expect((await get(usb, 0x10, 500))[0]).toBe(9);
        await usb.close();
    });
});

describe('isReplyTo', () => {
    const req = { clientId: 0x0005031d, protocol: VIA, payload: [GET, 0x00, 0x10] };
    it('needs the client ID, protocol, command and the echoed arguments', () => {
        expect(isReplyTo(frame(req.clientId, VIA, [GET, 0x00, 0x10, 5]), req)).toBe(true);
        expect(isReplyTo(frame(req.clientId, VIA, [GET, 0x00, 0x11, 5]), req)).toBe(false);
        expect(isReplyTo(frame(req.clientId, VIA, [GET, 0x01, 0x10, 5]), req)).toBe(false);
        expect(isReplyTo(frame(req.clientId, SVIL, [GET, 0x00, 0x10, 5]), req)).toBe(false);
        expect(isReplyTo(frame(req.clientId + 1, VIA, [GET, 0x00, 0x10, 5]), req)).toBe(false);
        expect(isReplyTo(frame(req.clientId, 0xff, [1]), req)).toBe(false);
    });
    it('takes an unhandled VIA reply only with its arguments left in place', () => {
        expect(isReplyTo(frame(req.clientId, VIA, [0xff, 0x00, 0x10]), req)).toBe(true);
        expect(isReplyTo(frame(req.clientId, VIA, [0xff, 0x00, 0x11]), req)).toBe(false);
    });
    it('checks only the command of a Sval reply, or its error byte', () => {
        const svil = { clientId: 7, protocol: SVIL, payload: [0x04, 3, 0, 1] };
        expect(isReplyTo(frame(7, SVIL, [0x04, 0]), svil)).toBe(true);
        expect(isReplyTo(frame(7, SVIL, [0xff]), svil)).toBe(true);
        expect(isReplyTo(frame(7, SVIL, [0x03, 3, 0]), svil)).toBe(false);
    });
});

describe('replyTimeoutFor', () => {
    it('gives writes time for a consolidation and keeps reads at 1 s', () => {
        expect(REPLY_TIMEOUT_MS).toBe(1000);
        expect(WRITE_REPLY_TIMEOUT_MS).toBeGreaterThan(4500);
        expect(replyTimeoutFor(VIA, SvilUSB.CMD_VIA_KEYMAP_SET_BUFFER)).toBe(WRITE_REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(VIA, SvilUSB.CMD_VIA_SET_KEYCODE)).toBe(WRITE_REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(VIA, SET)).toBe(WRITE_REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(SVIL, SvilUSB.CMD_SVIL_COMBO_SET)).toBe(WRITE_REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(SVIL, SvilUSB.CMD_SVIL_MACRO_BUFFER_SET)).toBe(WRITE_REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(VIA, GET)).toBe(REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(VIA, SvilUSB.CMD_VIA_KEYMAP_GET_BUFFER)).toBe(REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(SVIL, SvilUSB.CMD_SVIL_COMBO_GET)).toBe(REPLY_TIMEOUT_MS);
        expect(replyTimeoutFor(SVIL, SvilUSB.CMD_SVIL_POINTING_MOTION)).toBe(REPLY_TIMEOUT_MS);
    });
});
