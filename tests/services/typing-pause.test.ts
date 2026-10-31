// Typing pause (Sval 0x3C): the reply parser, the exit key, and the simulated
// board's lease, which only the owning client extends (keyboards/svalboard/typing_pause.c).
import { describe, expect, it } from "vitest";
import { blankBoard } from "@/dev/fake-board/board";
import { FakeSvalFirmware, FLAG3_TYPING_PAUSE } from "@/dev/fake-board/firmware";
import { CMD_SVIL_TYPING_PAUSE, hasTypingPause, parseTypingPauseReply } from "@/services/typing-pause";
import { FALLBACK_EXIT, findTesterExitKey, isExitHeld } from "@/utils/tester-exit-key";

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

function wrapped(id: number, protocol: number, payload: number[]): Uint8Array {
    const req = new Uint8Array(L);
    req[0] = 0xdd;
    req[1] = id & 0xff; req[2] = (id >>> 8) & 0xff; req[3] = (id >>> 16) & 0xff; req[4] = (id >>> 24) & 0xff;
    req[5] = protocol;
    req.set(payload, 6);
    return req;
}

const pause = (fw: FakeSvalFirmware, id: number, op: number) => parseTypingPauseReply(fw.receive(wrapped(id, 0xdf, [CMD_SVIL_TYPING_PAUSE, op]))!.slice(6));
const matrixRead = (fw: FakeSvalFirmware, id: number) => fw.receive(wrapped(id, 0xfe, [0x02, 0x03]));

function clocked() {
    let t = 10_000;
    const fw = new FakeSvalFirmware(blankBoard(), { now: () => t });
    return { fw, advance: (ms: number) => { t += ms; } };
}

describe("TYPING_PAUSE reply", () => {
    it("reads the state, ownership and counters", () => {
        const r = new Uint8Array(18);
        r.set([0x3c, 1, 0, 1, 0, 1, 0xdc, 0x05, 4, 0, 1, 0, 9, 0]);
        expect(parseTypingPauseReply(r)).toEqual({ ok: true, state: "paused", owned: true, leaseMs: 1500, keyboardBlocked: 4, extraBlocked: 1, mousePassed: 9 });
    });

    it("is null for firmware without the command (0xFF echo) or a short reply", () => {
        expect(parseTypingPauseReply(new Uint8Array([0xff, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
        expect(parseTypingPauseReply(new Uint8Array([0x3c, 1, 0]))).toBeNull();
    });

    it("is advertised by GET_INFO byte 20 bit 2", () => {
        expect(hasTypingPause(0x04)).toBe(true);
        expect(hasTypingPause(0x01)).toBe(false);
        expect(hasTypingPause(undefined)).toBe(false);
    });
});

describe("the simulated board's typing pause", () => {
    it("advertises the flag in GET_INFO byte 20, and not on older firmware", () => {
        const { fw } = clocked();
        const id = bootstrap(fw, 3);
        expect(fw.receive(wrapped(id, 0xdf, [0x00]))![5 + 20] & FLAG3_TYPING_PAUSE).toBe(FLAG3_TYPING_PAUSE);
        const old = new FakeSvalFirmware(blankBoard(), { typingPause: false, flickerLatch: false, padGestures: false });
        const id2 = bootstrap(old, 3);
        expect(old.receive(wrapped(id2, 0xdf, [0x00]))![5 + 20]).toBe(0);
        expect(old.receive(wrapped(id2, 0xdf, [CMD_SVIL_TYPING_PAUSE, 1]))![6]).toBe(0xff);
    });

    it("stays on while its owner polls", () => {
        const { fw, advance } = clocked();
        const a = bootstrap(fw, 1);
        expect(pause(fw, a, 1)).toMatchObject({ ok: true, state: "paused", owned: true });
        for (let i = 0; i < 100; i++) { advance(50); matrixRead(fw, a); }
        expect(fw.typingPauseState()).toBe("paused");
    });

    it("another client's traffic does not extend it", () => {
        const { fw, advance } = clocked();
        const a = bootstrap(fw, 1);
        const b = bootstrap(fw, 2); // Keybard Overlay, or another tab
        pause(fw, a, 1);
        for (let i = 0; i < 28; i++) { advance(50); matrixRead(fw, b); }
        expect(fw.typingPauseState()).toBe("paused");
        advance(150);
        matrixRead(fw, b);
        expect(fw.typingPauseState()).toBe("ending");
        advance(500);
        expect(fw.typingPauseState()).toBe("off");
    });

    it("ends on off from any client, and a renew while ending keeps it", () => {
        const { fw, advance } = clocked();
        const a = bootstrap(fw, 1);
        const b = bootstrap(fw, 2);
        pause(fw, a, 1);
        expect(pause(fw, b, 0)).toMatchObject({ state: "ending", owned: false });
        advance(100);
        expect(pause(fw, a, 1)).toMatchObject({ state: "paused", owned: true });
    });
});

describe("the tester's exit key", () => {
    const cols = 6;
    const layer = (entries: Record<number, number>) => Array.from({ length: 60 }, (_, i) => entries[i] ?? 0x04);

    it("is the base layer's Esc", () => {
        const exit = findTesterExitKey([layer({ 22: 0x29 })], cols);
        expect(exit).toEqual({ keys: [{ row: 3, col: 4 }], name: "Esc", fallback: false });
    });

    it("prefers a plain Esc over a tap-Esc, and takes a tap-Esc when there is no plain one", () => {
        expect(findTesterExitKey([layer({ 5: 0x4129, 22: 0x29 })], cols).keys).toEqual([{ row: 3, col: 4 }]);
        expect(findTesterExitKey([layer({ 5: 0x4129 })], cols).keys).toEqual([{ row: 0, col: 5 }]);
    });

    it("uses the board's default layer, not another layer's Esc", () => {
        const keymap = [layer({}), layer({ 30: 0x29 })];
        expect(findTesterExitKey(keymap, cols, 0)).toBe(FALLBACK_EXIT);
        expect(findTesterExitKey(keymap, cols, 1).keys).toEqual([{ row: 5, col: 0 }]);
    });

    it("falls back to both index-finger center keys, held together", () => {
        const exit = findTesterExitKey([layer({})], cols);
        expect(exit.fallback).toBe(true);
        expect(exit.name).toBe("both index-finger center keys");
        expect(isExitHeld(exit, (r, c) => r === 1 && c === 2)).toBe(false);
        expect(isExitHeld(exit, (r, c) => (r === 1 || r === 6) && c === 2)).toBe(true);
    });
});
