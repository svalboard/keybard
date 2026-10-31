// FakeSvalboardDevice: the parts of WebHID's HIDDevice Keybard uses, answered
// by the simulated firmware (firmware.ts) instead of a USB keyboard.
import { loadStoredBoard, storeBoard, wipeFakeBoard, type FakeBoardState } from "./board";
import { FakeSvalFirmware } from "./firmware";
import { seedBoard, seedKeymap } from "./seed";

/** What the simulated board calls itself, so nobody takes it for a real one. */
export const FAKE_BOARD_PRODUCT_NAME = "Simulated Svalboard";
export const FAKE_BOARD_VENDOR_ID = 0x303a; // info.json usb.vid
export const FAKE_BOARD_PRODUCT_ID = 0x4044; // info.json usb.pid
export const FAKE_BOARD_REPORT_LENGTH = 32;

export interface FakeSvalboardOptions {
    /** Firmware with combo names (label type 3, GET_INFO flags2 bit 7). Default true. */
    comboLabels?: boolean;
    /** Firmware with the typing pause (Sval 0x3C). Default true. */
    typingPause?: boolean;
    /** Firmware with the flicker latch (Sval 0x3D). Default true. */
    flickerLatch?: boolean;
    /** Firmware with the optical debounce switch (VIA value 48, Scan Lab STATUS byte 23). Default true. */
    debounceSwitch?: boolean;
    /** Firmware with the scan timing in µs only (feat/timing-us-only). Default true. */
    timingUsOnly?: boolean;
    /** Firmware with the touchpad tap setting (VIA values 51-54). Default true. */
    padGestures?: boolean;
    /** An Azoteq touchpad on each half. Default false. */
    touchpad?: boolean;
    /**
     * A board that ran turbo TURBO with both waits at 0 before this firmware:
     * seeded that way, fresh on every load (not saved), so the firmware's boot
     * migration runs each time.
     */
    seedTurbo?: number;
    /**
     * Firmware from before x4.3.3, whose settings reset stored a leader timeout
     * of 0 with per-key timing off: seeded that way, fresh on every load.
     */
    seedLeaderZero?: boolean;
    /** The raw HID report size: 32 (default, as older firmware) or 64 (current firmware). */
    reportLength?: number;
    /** The board's stored settings; default: localStorage, else a freshly seeded board. */
    state?: FakeBoardState;
    /** Keep the settings in localStorage after every write. Default: true unless `state` is given. */
    persist?: boolean;
    /** How a reply is scheduled after a report goes out (a later task, as USB replies are). */
    schedule?: (fn: () => void) => void;
}

/** The raw HID collection QMK exposes: usage page 0xFF60, usage 0x61, 32-byte reports. */
function rawHidCollection(length: number): HIDCollectionInfo {
    const report: HIDReportInfo = { reportId: 0, items: [{ reportSize: 8, reportCount: length, usagePage: 0xff60 } as HIDReportItem] };
    return { usagePage: 0xff60, usage: 0x61, type: 1, children: [], inputReports: [report], outputReports: [report], featureReports: [] };
}

function defaultSchedule(): (fn: () => void) => void {
    // A message-channel task is not throttled the way chained zero timeouts are,
    // so the hundreds of round trips of a load stay quick.
    if (typeof MessageChannel !== "undefined" && typeof window !== "undefined" && !/jsdom/i.test(navigator.userAgent)) {
        const channel = new MessageChannel();
        const queue: (() => void)[] = [];
        channel.port1.onmessage = () => queue.shift()?.();
        return (fn) => {
            queue.push(fn);
            channel.port2.postMessage(0);
        };
    }
    return (fn) => setTimeout(fn, 0);
}

/**
 * Runs a callback at an exact time, as a USB reply lands: a worker watches the
 * clock and posts back when it is due, so the reply arrives as its own task on
 * the page, on time. Page timers can't do this: on Windows a short setTimeout
 * waits for the next system tick, often 15.6 ms, which made the simulated link
 * four times slower than the real one. The worker only runs while a reply is
 * pending, and never on the page's main thread. Null where workers don't exist
 * (jsdom); setTimeout is used there.
 */
function makeLinkClock(): ((fn: () => void, delayMs: number) => void) | null {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL?.createObjectURL !== "function") return null;
    try {
        const source = "onmessage = (e) => { const [id, due] = e.data; while (performance.timeOrigin + performance.now() < due) {} postMessage(id); };";
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        const pending = new Map<number, () => void>();
        let next = 0, broken = false;
        // A policy that forbids workers (Paranoid) may only say so later: fall back to timers.
        worker.onerror = () => {
            broken = true;
            for (const fn of pending.values()) setTimeout(fn, 0);
            pending.clear();
        };
        worker.onmessage = (e: MessageEvent<number>) => {
            const fn = pending.get(e.data);
            pending.delete(e.data);
            fn?.();
        };
        return (fn, delayMs) => {
            if (broken) { setTimeout(fn, delayMs); return; }
            const id = next++;
            pending.set(id, fn);
            worker.postMessage([id, performance.timeOrigin + performance.now() + delayMs]);
        };
    } catch {
        return null;
    }
}

/**
 * Structurally a HIDDevice (WebHID's overloaded event typings can't be
 * implemented by a plain class); use asHIDDevice() where one is expected.
 */
export class FakeSvalboardDevice extends EventTarget {
    oninputreport: ((ev: HIDInputReportEvent) => unknown) | null = null;
    readonly vendorId = FAKE_BOARD_VENDOR_ID;
    readonly productId = FAKE_BOARD_PRODUCT_ID;
    readonly productName = FAKE_BOARD_PRODUCT_NAME;
    readonly reportLength: number;
    readonly collections: HIDCollectionInfo[];
    readonly firmware: FakeSvalFirmware;
    /** Every report sent to the board, for tests (newest last; up to 2000 kept). */
    readonly sent: Uint8Array[] = [];
    /**
     * Extra time before each reply, in ms (0: none), kept exactly (makeLinkClock).
     * The e2e tests set the round trip measured on the trackball test board.
     */
    replyDelayMs = 0;
    private isOpen = false;
    private persisting: boolean;
    private readonly schedule: (fn: () => void) => void;
    private linkClock: ((fn: () => void, delayMs: number) => void) | null | undefined;

    constructor(options: FakeSvalboardOptions = {}) {
        super();
        this.reportLength = options.reportLength ?? FAKE_BOARD_REPORT_LENGTH;
        this.collections = [rawHidCollection(this.reportLength)];
        const persist = options.persist ?? (!options.state && options.seedTurbo === undefined && !options.seedLeaderZero);
        this.persisting = persist;
        let state = options.state ?? (persist ? loadStoredBoard() : null);
        if (!state) {
            state = seedBoard();
            if (options.seedTurbo !== undefined) {
                const c = state.custom;
                c[9 * 2] = options.seedTurbo;
                c[13 * 2] = c[13 * 2 + 1] = c[14 * 2] = c[14 * 2 + 1] = 0;
            }
            if (options.seedLeaderZero) {
                state.qmkSettings[40] = state.qmkSettings[41] = 0; // leader_timeout
                state.qmkSettings[42] = 0; // leader_options
            }
            if (persist) storeBoard(state);
        }
        this.firmware = new FakeSvalFirmware(state, {
            comboLabels: options.comboLabels ?? true,
            typingPause: options.typingPause ?? true,
            flickerLatch: options.flickerLatch ?? true,
            debounceSwitch: options.debounceSwitch ?? true,
            timingUsOnly: options.timingUsOnly ?? true,
            padGestures: options.padGestures ?? true,
            touchpad: options.touchpad ?? false,
            onChange: (state) => { if (this.persisting) storeBoard(state); },
            factoryKeymap: seedKeymap(),
        });
        this.schedule = options.schedule ?? defaultSchedule();
    }

    /** Forget the stored settings and stop saving them (before a reload starts the board over). */
    forgetSettings(): void {
        this.persisting = false;
        wipeFakeBoard();
    }

    asHIDDevice(): HIDDevice {
        return this as unknown as HIDDevice;
    }

    get opened(): boolean {
        return this.isOpen;
    }

    get state(): FakeBoardState {
        return this.firmware.state;
    }

    async open(): Promise<void> {
        this.isOpen = true;
    }

    async close(): Promise<void> {
        this.isOpen = false;
    }

    async forget(): Promise<void> {
        this.isOpen = false;
    }

    async sendReport(reportId: number, data: BufferSource): Promise<void> {
        if (!this.isOpen) throw new DOMException("The device must be opened first.", "InvalidStateError");
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        // A report is always the descriptor's length; shorter data is zero-padded, as the OS does.
        const report = new Uint8Array(this.reportLength);
        report.set(bytes.subarray(0, this.reportLength));
        this.sent.push(report);
        if (this.sent.length > 2000) this.sent.splice(0, this.sent.length - 2000);
        if (reportId !== 0) return;
        let reply: Uint8Array | null;
        try {
            reply = this.firmware.receive(report);
        } catch (e) {
            // A bug in the simulation must never reach the page as an exception.
            console.error("[fake board] The simulated firmware failed on a report:", e);
            reply = null;
        }
        if (!reply) return;
        if (this.replyDelayMs > 0) {
            if (this.linkClock === undefined) this.linkClock = makeLinkClock();
            const at = this.linkClock;
            if (at) at(() => this.deliver(reply!), this.replyDelayMs);
            else setTimeout(() => this.deliver(reply!), this.replyDelayMs);
        }
        else this.schedule(() => this.deliver(reply!));
    }

    async sendFeatureReport(): Promise<void> {
        throw new DOMException("The simulated board has no feature reports.", "NotSupportedError");
    }

    async receiveFeatureReport(): Promise<DataView> {
        throw new DOMException("The simulated board has no feature reports.", "NotSupportedError");
    }

    private deliver(reply: Uint8Array) {
        if (!this.isOpen) return;
        const buffer = new ArrayBuffer(this.reportLength);
        new Uint8Array(buffer).set(reply);
        const event = new Event("inputreport") as HIDInputReportEvent;
        Object.defineProperties(event, {
            device: { value: this },
            reportId: { value: 0 },
            data: { value: new DataView(buffer) },
        });
        this.oninputreport?.(event);
        this.dispatchEvent(event);
    }
}
