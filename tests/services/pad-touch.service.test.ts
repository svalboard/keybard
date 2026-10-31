import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    PAD_TOUCH_BACKOFF_MS, PAD_TOUCH_FAST_MS, PAD_TOUCH_IDLE_MS, PadTouchService, type PadTouchDeps,
} from "@/services/pad-touch.service";
import type { KeyboardInfo } from "@/types/keyboard.types";
import { EMPTY_BLOCK, type PadTouchReport } from "@/utils/touchpad-tuning";

const KB = { feature_flags3: 0x70 } as KeyboardInfo;

function report(down = false): PadTouchReport {
    return {
        tapOn: true, twoFingerOn: true, holdOn: true, elapsedMs: 0, deadZone: 80, tapMs: 150, holdMs: 300, width: 4300, height: 4000, scrollStart: 105, channelsX: 8, channelsY: 7,
        left: { ...EMPTY_BLOCK, valid: true, down }, right: { ...EMPTY_BLOCK },
    };
}

describe("PadTouchService", () => {
    let calls: number[];
    let next: () => PadTouchReport | null;
    let deps: PadTouchDeps;

    beforeEach(() => {
        vi.useFakeTimers();
        calls = [];
        next = () => report();
        deps = {
            getPadTouch: async () => { calls.push(Date.now()); return next(); },
            hasPadTouch: (kb) => !!kb && ((kb.feature_flags3 ?? 0) & 0x40) !== 0,
            now: () => Date.now(),
        };
    });
    afterEach(() => vi.useRealTimers());

    it("reads only while something holds it, on a connected board with the page", async () => {
        const s = new PadTouchService(deps);
        s.setConnection(KB, true);
        await vi.advanceTimersByTimeAsync(500);
        expect(calls).toHaveLength(0);
        const release = s.acquire();
        await vi.advanceTimersByTimeAsync(500);
        expect(calls.length).toBeGreaterThan(3);
        release();
        const n = calls.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(calls.length).toBe(n);
        expect(s.isPolling).toBe(false);
    });

    it("never reads firmware without the page, or a disconnected board", async () => {
        const s = new PadTouchService(deps);
        s.setConnection({ feature_flags3: 0x30 } as KeyboardInfo, true);
        s.acquire();
        await vi.advanceTimersByTimeAsync(500);
        s.setConnection(KB, false);
        await vi.advanceTimersByTimeAsync(500);
        expect(calls).toHaveLength(0);
    });

    it("reads every ~90 ms while the pads rest, every ~30 ms while a finger is down", async () => {
        const s = new PadTouchService(deps);
        s.setConnection(KB, true);
        s.acquire();
        await vi.advanceTimersByTimeAsync(900);
        const idle = calls.length;
        expect(idle).toBeLessThanOrEqual(Math.ceil(900 / PAD_TOUCH_IDLE_MS) + 1);
        expect(idle).toBeGreaterThanOrEqual(Math.floor(900 / PAD_TOUCH_IDLE_MS) - 1);
        next = () => report(true);
        await vi.advanceTimersByTimeAsync(900);
        const busy = calls.length - idle;
        expect(busy).toBeGreaterThanOrEqual(Math.floor(900 / PAD_TOUCH_FAST_MS) - 3);
        expect(busy).toBeLessThanOrEqual(Math.ceil(900 / PAD_TOUCH_FAST_MS) + 1);
    });

    it("hands each report to its listeners, and backs off after failed reads", async () => {
        const s = new PadTouchService(deps);
        const seen: PadTouchReport[] = [];
        s.subscribe((r) => seen.push(r));
        s.setConnection(KB, true);
        s.acquire();
        await vi.advanceTimersByTimeAsync(200);
        expect(seen.length).toBeGreaterThan(0);
        next = () => null;
        await vi.advanceTimersByTimeAsync(400);
        const before = calls.length;
        await vi.advanceTimersByTimeAsync(PAD_TOUCH_BACKOFF_MS - 50);
        expect(calls.length - before).toBeLessThanOrEqual(1);
    });
});
