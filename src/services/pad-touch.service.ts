// One poller for the touch page of POINTING_MOTION (0x2D page 1), for the
// touchpad tuning view. It polls only while a view holds it, the board
// advertises the page, and the tab is visible (in Keybard Paranoid, also
// focused). It only reads: the board follows its pads only while a host
// reads this page, and stops 1.5 s after the last read.

import { PARANOID, userIsLooking } from "@/lib/paranoid";
import { keyboardService } from "@/services/keyboard.service";
import type { KeyboardInfo } from "@/types/keyboard.types";
import type { PadTouchReport } from "@/utils/touchpad-tuning";

/** While a finger is down, or something happened in the last PAD_TOUCH_ACTIVE_MS. */
export const PAD_TOUCH_FAST_MS = 30;
/** Otherwise: a touch-down still shows within about 100 ms. */
export const PAD_TOUCH_IDLE_MS = 90;
export const PAD_TOUCH_ACTIVE_MS = 1500;
/** After PAD_TOUCH_MAX_MISSES empty or failed reads in a row. */
export const PAD_TOUCH_BACKOFF_MS = 1000;
export const PAD_TOUCH_MAX_MISSES = 3;

export interface PadTouchDeps {
    getPadTouch(kbinfo: KeyboardInfo): Promise<PadTouchReport | null>;
    hasPadTouch(kbinfo: KeyboardInfo | null | undefined): boolean;
    now(): number;
}

export type PadTouchListener = (report: PadTouchReport, at: number) => void;

export class PadTouchService {
    private refs = 0;
    private kbinfo: KeyboardInfo | null = null;
    private connected = false;
    private listeners = new Set<PadTouchListener>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private inFlight = false;
    private looping = false;
    private misses = 0;
    private activeAt = -Infinity;
    private listening = false;

    constructor(private deps: PadTouchDeps) {}

    setConnection(kbinfo: KeyboardInfo | null, connected: boolean) {
        this.kbinfo = kbinfo;
        this.connected = connected;
        if (!connected) this.stop();
        this.kick();
    }

    acquire(): () => void {
        this.refs++;
        this.listen();
        this.kick();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.refs = Math.max(0, this.refs - 1);
            if (this.refs === 0) this.stop();
        };
    }

    subscribe(listener: PadTouchListener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    get isPolling(): boolean {
        return this.looping;
    }

    private canPoll(): boolean {
        if (this.refs <= 0 || !this.connected || !this.kbinfo) return false;
        if (typeof document !== "undefined" && document.hidden) return false;
        if (PARANOID && !userIsLooking()) return false;
        return this.deps.hasPadTouch(this.kbinfo);
    }

    private stop() {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.looping = false;
    }

    private kick() {
        if (this.looping || this.inFlight || !this.canPoll()) return;
        this.schedule(0);
    }

    private schedule(delay: number) {
        this.looping = true;
        this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
    }

    private async tick() {
        if (!this.canPoll() || !this.kbinfo) { this.stop(); return; }
        let report: PadTouchReport | null = null;
        this.inFlight = true;
        try {
            report = await this.deps.getPadTouch(this.kbinfo);
        } catch {
            report = null;
        } finally {
            this.inFlight = false;
        }
        const now = this.deps.now();
        if (!report) {
            this.misses++;
        } else {
            this.misses = 0;
            const busy = [report.left, report.right].some((b) => b.down || b.events !== 0);
            if (busy) this.activeAt = now;
            for (const l of [...this.listeners]) {
                try { l(report, now); } catch (e) { console.warn("Touch listener failed:", e); }
            }
        }
        if (!this.canPoll()) { this.stop(); return; }
        this.schedule(this.misses >= PAD_TOUCH_MAX_MISSES ? PAD_TOUCH_BACKOFF_MS
            : now - this.activeAt < PAD_TOUCH_ACTIVE_MS ? PAD_TOUCH_FAST_MS : PAD_TOUCH_IDLE_MS);
    }

    private listen() {
        if (this.listening || typeof document === "undefined") return;
        this.listening = true;
        document.addEventListener("visibilitychange", () => { if (document.hidden) this.stop(); else this.kick(); });
        if (typeof window !== "undefined") window.addEventListener("focus", () => this.kick());
    }
}

let instance: PadTouchService | null = null;
let depsOverride: PadTouchDeps | null = null;

export function getPadTouch(): PadTouchService {
    if (!instance) {
        instance = new PadTouchService(depsOverride ?? {
            getPadTouch: (kb) => keyboardService.getPadTouch(kb),
            hasPadTouch: (kb) => keyboardService.hasPadTouch(kb),
            now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
        });
    }
    return instance;
}

/** For tests: replace the singleton's dependencies (and drop the old instance). */
export function _setPadTouchDepsForTest(deps: PadTouchDeps | null) {
    instance = null;
    depsOverride = deps;
}
