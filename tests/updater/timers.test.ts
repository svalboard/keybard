// A background tab clamps the page's timers (at least 1 s; a minute after five minutes
// hidden). The update's waits run on a worker's timers instead, and the send loop waits on
// each reply, never on a timer, so a hidden tab doesn't stretch the transfer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdaterClient } from "@/services/updater/client";
import { planInstall } from "@/services/updater/checks";
import { fakeSetup, fixtureRelease } from "@/services/updater/fake-host";
import { memoryFlowStore, UpdateFlow, type Step } from "@/services/updater/flow";
import { VirtualClock } from "@/services/updater/transport";
import { updaterSleep, workerTimers, type TimerWorker, type UpdaterTimers } from "@/services/updater/timers";

/** The page's timers in a hidden tab: never sooner than a second. */
function clampedPageTimers(minMs = 1000): UpdaterTimers {
    return {
        setTimeout: (fn, ms) => setTimeout(fn, Math.max(ms, minMs)) as unknown as number,
        clearTimeout: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
        unthrottled: false,
    };
}

/** A dedicated worker: its timers aren't clamped. */
class FakeTimerWorker implements TimerWorker {
    onmessage: ((event: { data: number }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    private timers = new Map<number, ReturnType<typeof setTimeout>>();
    terminated = false;
    postMessage(m: { id: number; ms?: number; cancel?: boolean }) {
        if (m.cancel) { clearTimeout(this.timers.get(m.id)); this.timers.delete(m.id); return; }
        this.timers.set(m.id, setTimeout(() => { this.timers.delete(m.id); this.onmessage?.({ data: m.id }); }, m.ms));
    }
    terminate() { this.terminated = true; for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}

async function elapsedFor(timers: UpdaterTimers, sleeps: number, ms: number): Promise<number> {
    const t0 = Date.now();
    const done = (async () => { for (let i = 0; i < sleeps; i++) await updaterSleep(ms, timers); })();
    await vi.runAllTimersAsync();
    await done;
    return Date.now() - t0;
}

describe("the update's timers in a background tab", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("twenty 250 ms status polls take 5 s on the worker, where the clamped page timers take 20 s", async () => {
        const page = clampedPageTimers();
        const onWorker = workerTimers(() => new FakeTimerWorker(), page);
        expect(onWorker.unthrottled).toBe(true);
        expect(await elapsedFor(onWorker, 20, 250)).toBe(5_000);
        expect(await elapsedFor(page, 20, 250)).toBe(20_000);
    });

    it("a cleared timeout never fires (a reply arrived in time)", async () => {
        const timers = workerTimers(() => new FakeTimerWorker(), clampedPageTimers());
        const fired = vi.fn();
        const id = timers.setTimeout(fired, 1000);
        timers.clearTimeout(id);
        await vi.runAllTimersAsync();
        expect(fired).not.toHaveBeenCalled();
    });

    it("no worker (Keybard Paranoid forbids them): the page's timers, as before", () => {
        const page = clampedPageTimers();
        expect(workerTimers(() => null, page)).toBe(page);
    });

    it("a worker that fails moves its pending timers to the page's timers", async () => {
        let worker: FakeTimerWorker | null = null;
        const timers = workerTimers(() => (worker = new FakeTimerWorker()), clampedPageTimers());
        const fired = vi.fn();
        timers.setTimeout(fired, 300);
        worker!.onerror?.(new Event("error"));
        expect(worker!.terminated).toBe(true);
        expect(timers.unthrottled).toBe(false);
        await vi.runAllTimersAsync();
        expect(fired).toHaveBeenCalledTimes(1);
        // New waits go to the page's timers too.
        const later = vi.fn();
        timers.setTimeout(later, 10);
        await vi.runAllTimersAsync();
        expect(later).toHaveBeenCalledTimes(1);
    });
});

/** Virtual time whose sleeps are clamped like a hidden tab's timers; records the step of each. */
class ClampedClock extends VirtualClock {
    flow: UpdateFlow | null = null;
    readonly sleptIn: Step[] = [];
    async sleep(ms: number): Promise<void> {
        if (this.flow) this.sleptIn.push(this.flow.state.step);
        await super.sleep(Math.max(ms, 1000));
    }
}

describe("the transfer with clamped timers", () => {
    it("the send loop waits on each reply, never on a timer: no sleep while either half's image is sent", async () => {
        const clock = new ClampedClock();
        const v3 = await fixtureRelease("v3", 3000);
        const x32 = await fixtureRelease("x3.2", 4000, { noChord: true, imageLen: 0x8000 });
        const { board, host } = fakeSetup({ clock, running: v3, noChord: true });
        const plan = await planInstall(new UpdaterClient(board), { kind: "file", files: [x32.files[0], x32.files[1]] }, { clock, releases: [] });
        if ("id" in plan) throw new Error(`plan failed: ${plan.id}`);
        const flow = UpdateFlow.create(host, memoryFlowStore(), { plan, afterwards: "blank", backup: null });
        clock.flow = flow;
        const sendSteps: Step[] = [];
        flow.subscribe((s) => { if ((s.step === "other-send" || s.step === "self-send") && !sendSteps.includes(s.step)) sendSteps.push(s.step); });
        const state = await flow.run();
        expect(state.phase).toBe("result");
        expect(sendSteps).toEqual(["other-send", "self-send"]);
        expect(clock.sleptIn.length).toBeGreaterThan(0); // the polls did sleep, clamped
        expect(clock.sleptIn.filter((s) => s === "other-send" || s === "self-send")).toEqual([]);
    });
});
