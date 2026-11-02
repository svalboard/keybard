// Debug console (Sval 0x3E): the reply parser, the GET_INFO flag, and the
// simulated board's flag (keyboards/svalboard/debug_console.c).
import { describe, expect, it } from "vitest";
import { blankBoard } from "@/dev/fake-board/board";
import { FakeSvalFirmware, FLAG4_DEBUG_CONSOLE } from "@/dev/fake-board/firmware";
import { CMD_SVIL_DEBUG_CONSOLE, DEBUG_CONSOLE_OFF, DEBUG_CONSOLE_ON, DEBUG_CONSOLE_READ, hasDebugConsole, parseDebugConsoleReply } from "@/services/debug-console";

const L = 32;
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function bootstrap(fw: FakeSvalFirmware, seed: number): number {
    for (;;) {
        const req = new Uint8Array(L);
        req[0] = 0xdd;
        for (let i = 0; i < 20; i++) req[5 + i] = (i * 37 + seed) & 0xff;
        const id = le32(fw.receive(req)!, 25);
        if (id !== 0) return id;
    }
}

function wrapped(id: number, payload: number[]): Uint8Array {
    const req = new Uint8Array(L);
    req[0] = 0xdd;
    req[1] = id & 0xff; req[2] = (id >>> 8) & 0xff; req[3] = (id >>> 16) & 0xff; req[4] = (id >>> 24) & 0xff;
    req[5] = 0xdf;
    req.set(payload, 6);
    return req;
}

const send = (fw: FakeSvalFirmware, id: number, op: number) =>
    parseDebugConsoleReply(fw.receive(wrapped(id, [CMD_SVIL_DEBUG_CONSOLE, op]))!.slice(6), op);

describe("DEBUG_CONSOLE reply", () => {
    it("reads the status and the flag", () => {
        expect(parseDebugConsoleReply(new Uint8Array([0x3e, 1, 0, 1]), 1)).toEqual({ ok: true, on: true });
        expect(parseDebugConsoleReply(new Uint8Array([0x3e, 2, 0, 0]), 2)).toEqual({ ok: true, on: false });
        expect(parseDebugConsoleReply(new Uint8Array([0x3e, 1, 2, 0]), 1)).toEqual({ ok: false, on: false });
    });

    it("is null for firmware without the command, another op's echo or a short reply", () => {
        expect(parseDebugConsoleReply(new Uint8Array([0xff, 1, 0, 0]), 1)).toBeNull();
        expect(parseDebugConsoleReply(new Uint8Array([0x3e, 2, 0, 1]), 1)).toBeNull();
        expect(parseDebugConsoleReply(new Uint8Array([0x3e, 1, 0]), 1)).toBeNull();
        expect(parseDebugConsoleReply(null, 1)).toBeNull();
    });

    it("is advertised by GET_INFO byte 21 bit 2", () => {
        expect(hasDebugConsole(0x04)).toBe(true);
        expect(hasDebugConsole(0x07)).toBe(true);
        expect(hasDebugConsole(0x03)).toBe(false);
        expect(hasDebugConsole(undefined)).toBe(false);
    });
});

describe("the simulated board's debug console", () => {
    it("advertises the flag in GET_INFO byte 21, and older firmware answers 0xFF", () => {
        const fw = new FakeSvalFirmware(blankBoard());
        const id = bootstrap(fw, 5);
        expect(fw.receive(wrapped(id, [0x00]))![5 + 21] & FLAG4_DEBUG_CONSOLE).toBe(FLAG4_DEBUG_CONSOLE);
        const old = new FakeSvalFirmware(blankBoard(), { debugConsole: false });
        const id2 = bootstrap(old, 5);
        expect(old.receive(wrapped(id2, [0x00]))![5 + 21] & FLAG4_DEBUG_CONSOLE).toBe(0);
        expect(old.receive(wrapped(id2, [CMD_SVIL_DEBUG_CONSOLE, 1]))![6]).toBe(0xff);
    });

    it("starts off, turns on and off, and a read changes nothing", () => {
        const fw = new FakeSvalFirmware(blankBoard());
        const id = bootstrap(fw, 6);
        expect(send(fw, id, DEBUG_CONSOLE_READ)).toEqual({ ok: true, on: false });
        expect(send(fw, id, DEBUG_CONSOLE_ON)).toEqual({ ok: true, on: true });
        expect(send(fw, id, DEBUG_CONSOLE_READ)).toEqual({ ok: true, on: true });
        expect(send(fw, id, DEBUG_CONSOLE_OFF)).toEqual({ ok: true, on: false });
        expect(send(fw, id, 7)).toEqual({ ok: false, on: false });
        expect(fw.debugRequests).toEqual([2, 1, 2, 0, 7]);
    });

    it("is off on a board that starts again, as at every power-up", () => {
        const state = blankBoard();
        const fw = new FakeSvalFirmware(state);
        send(fw, bootstrap(fw, 7), DEBUG_CONSOLE_ON);
        const again = new FakeSvalFirmware(state);
        expect(send(again, bootstrap(again, 8), DEBUG_CONSOLE_READ)).toEqual({ ok: true, on: false });
    });
});
