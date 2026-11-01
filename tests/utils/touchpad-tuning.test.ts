import { describe, expect, it } from "vitest";

import { SCRIPT_MS, scriptSample, TOUCH_SCRIPT } from "@/dev/fake-board/touch-script";
import { withTouchpadTaps } from "@/utils/touchpad-taps";
import {
    ChipModel, chipWould, contactRadius, EMPTY_BLOCK, EMPTY_FINGERS, formatMm, formatPalm, hasPadFingers, hasPadPalm, hasPadTouch, hasPadTuning, isPalm,
    nearest, outcome, packPadFingers, packPadTouch, PAD_DEAD_ZONE_MM100, PAD_PALM_KEY, PAD_SCROLL_MM100, PAD_TAP_MS, PAD_TUNING_KEYS, parsePadFingers,
    parsePadTouch, steps, TOUCH_EV, TouchTracker, TUNE_TOUCHPAD_ACTION, type ChipSettings, type PadFingersBlock, type PadTouchBlock, type PadTouchReport,
} from "@/utils/touchpad-tuning";

const SETTINGS: ChipSettings = { deadZone: 80, tapMs: 150, holdMs: 300, tapOn: true, twoFingerOn: true, holdOn: true };

function report(left: Partial<PadTouchBlock> = {}, right: Partial<PadTouchBlock> = {}): PadTouchReport {
    return {
        tapOn: true, twoFingerOn: true, holdOn: true, elapsedMs: 30, deadZone: 80, tapMs: 150, holdMs: 300, width: 4300, height: 4000, scrollStart: 105, channelsX: 8, channelsY: 7,
        left: { ...EMPTY_BLOCK, valid: true, ...left }, right: { ...EMPTY_BLOCK, ...right },
    };
}

function reply(r: PadTouchReport): Uint8Array {
    const out = new Uint8Array(1 + 62);
    out[0] = 0x2d;
    out.set(packPadTouch(r), 1);
    return out;
}

describe("touchpad tuning flags and tables", () => {
    it("reads GET_INFO byte 20 bits 5 and 6", () => {
        expect(hasPadTuning(0x20)).toBe(true);
        expect(hasPadTuning(0x10)).toBe(false);
        expect(hasPadTouch(0x40)).toBe(true);
        expect(hasPadTouch(0x3f)).toBe(false);
        expect(hasPadTouch(undefined)).toBe(false);
    });

    it("matches the firmware's tables: the default first, the rest rising", () => {
        expect(PAD_DEAD_ZONE_MM100[0]).toBe(120);
        expect(PAD_TAP_MS[0]).toBe(150);
        expect(PAD_SCROLL_MM100[0]).toBe(0);
        for (const t of [PAD_DEAD_ZONE_MM100, PAD_TAP_MS, PAD_SCROLL_MM100]) {
            expect(t).toHaveLength(16);
            expect(steps(t)).toEqual([...new Set(t)].sort((a, b) => a - b));
        }
    });

    it("snaps to the nearest, a tie to the smaller, as the board does", () => {
        expect(nearest(PAD_DEAD_ZONE_MM100, 52)).toBe(50);
        expect(nearest(PAD_DEAD_ZONE_MM100, 85)).toBe(80);
        expect(nearest(PAD_DEAD_ZONE_MM100, 9999)).toBe(400);
        expect(nearest(PAD_TAP_MS, 0)).toBe(50);
    });

    it("writes millimeters plainly", () => {
        expect(formatMm(80)).toBe("0.8 mm");
        expect(formatMm(105)).toBe("1.05 mm");
        expect(formatMm(400)).toBe("4 mm");
        expect(formatMm(1893)).toBe("18.93 mm");
    });
});

describe("the touch page", () => {
    it("round-trips every field", () => {
        const r = report(
            { down: true, outside: true, fingers: 2, holding: true, events: 0x55, x: 2150, y: 2000, downX: 2100, downY: 1990, ms: 432, farthest: 61, tapPx: 38, strength: 812, area: 3 },
            { valid: true, os: true, x: 1, y: 2, downX: 3, downY: 4, ms: 65535, farthest: 7, tapPx: 25, strength: 0, area: 0 },
        );
        expect(parsePadTouch(reply(r))).toEqual(r);
    });

    it("refuses another format, another command or a short reply", () => {
        const bytes = reply(report());
        expect(parsePadTouch(bytes, 0x2f)).toBeNull();
        const motion = bytes.slice();
        motion[1] = 1; // format 1: the motion page, from firmware that ignores the page byte
        expect(parsePadTouch(motion)).toBeNull();
        expect(parsePadTouch(bytes.slice(0, 30))).toBeNull();
        expect(parsePadTouch(null)).toBeNull();
    });

    it("reads a page from firmware without finger sizes (48 bytes, byte 3 clear) with no size", () => {
        const full = reply(report({ down: true, fingers: 1, strength: 700, area: 3 }));
        const old = full.slice(0, 1 + 48);
        old[1 + 3] = 0;
        const r = parsePadTouch(old)!;
        expect(r.channelsX).toBe(0);
        expect(r.left.strength).toBe(0);
        expect(r.left.area).toBe(0);
        expect(r.left.down).toBe(true);
    });

    it("turns the area into a footprint: channels times one channel's size", () => {
        // One TPS43 channel: 43/8 x 40/7 mm = 30.7 mm2; 3 channels is 92 mm2, a circle 10.8 mm across.
        expect(contactRadius(3, report())).toBe(542);
        expect(contactRadius(0, report())).toBe(0);
        expect(contactRadius(3, { ...report(), channelsX: 0 })).toBe(0);
    });

    it("reads an all-zero block as no pad", () => {
        expect(parsePadTouch(reply(report()))!.right.valid).toBe(false);
    });
});

describe("what a touch did, and why", () => {
    const run = (blocks: Partial<PadTouchBlock>[]) => {
        const t = new TouchTracker();
        const r = report();
        return blocks.map((b) => t.take({ ...EMPTY_BLOCK, valid: true, ...b }, r)).filter(Boolean);
    };

    it("a tap: down, then up with the chip's tap", () => {
        const [o] = run([{ down: true, fingers: 1, events: TOUCH_EV.down, ms: 20 }, { events: TOUCH_EV.up | TOUCH_EV.tap, ms: 90, farthest: 12 }]);
        expect(o!.kind).toBe("tap");
        expect(o!.text).toBe("Tap: 90 ms, moved 0.12 mm");
    });

    it("a whole touch between two reads", () => {
        const [o] = run([{ events: TOUCH_EV.down | TOUCH_EV.up | TOUCH_EV.tap, ms: 40 }]);
        expect(o!.kind).toBe("tap");
    });

    it("canceled by drift, with how far it went", () => {
        const [o] = run([{ down: true, fingers: 1, events: TOUCH_EV.down }, { down: true, fingers: 1, events: TOUCH_EV.drift, outside: true }, { events: TOUCH_EV.up, ms: 300, farthest: 93 }]);
        expect(o!.kind).toBe("canceled");
        expect(o!.text).toContain("moved 0.93 mm");
    });

    it("between the tap time and the hold: no click, and says why", () => {
        const [o] = run([{ down: true, fingers: 1, events: TOUCH_EV.down }, { events: TOUCH_EV.up, ms: 260, farthest: 10 }]);
        expect(o!.kind).toBe("late");
        expect(o!.text).toBe("No click: lifted at 260 ms, after the 150 ms tap time and before the 450 ms hold");
    });

    it("press and hold and the two-finger tap", () => {
        expect(run([{ down: true, fingers: 1, events: TOUCH_EV.down }, { down: true, fingers: 1, events: TOUCH_EV.hold, holding: true }, { events: TOUCH_EV.up, ms: 900 }])[0]!.kind).toBe("hold");
        expect(run([{ down: true, fingers: 2, events: TOUCH_EV.down }, { events: TOUCH_EV.up | TOUCH_EV.twoTap, ms: 100 }])[0]!.kind).toBe("right");
    });

    it("on a pad the computer has as a touchpad, still says what the chip decided", () => {
        expect(outcome(TOUCH_EV.tap, 1, { ...EMPTY_BLOCK, valid: true, os: true, ms: 80 }, report()).kind).toBe("tap");
    });

    it("keeps the touch's path, from the down point", () => {
        const t = new TouchTracker();
        t.take({ ...EMPTY_BLOCK, valid: true, down: true, fingers: 1, events: TOUCH_EV.down, downX: 10, downY: 20, x: 12, y: 21 }, report());
        t.take({ ...EMPTY_BLOCK, valid: true, down: true, fingers: 1, downX: 10, downY: 20, x: 15, y: 25 }, report());
        expect(t.trail).toEqual([{ x: 10, y: 20 }, { x: 12, y: 21 }, { x: 15, y: 25 }]);
    });
});

describe("the chip model (simulated board)", () => {
    const play = (samples: [number, number, number, number][], cfg: Partial<ChipSettings> = {}) => {
        const m = new ChipModel(() => ({ ...SETTINGS, ...cfg }));
        let events = 0;
        for (const [t, x, y, fingers] of samples) {
            m.sample({ t, x, y, fingers });
            events |= m.read(t).events;
        }
        return events;
    };
    const still = (ms: number, fingers = 1, dx = 0): [number, number, number, number][] => {
        const out: [number, number, number, number][] = [];
        for (let t = 0; t <= ms; t += 10) out.push([t, 1000 + Math.round((dx * t) / ms), 1000, fingers]);
        out.push([ms + 10, 1000 + dx, 1000, 0]);
        return out;
    };

    it("a short still touch taps; a long one holds at tap + hold time", () => {
        expect(play(still(90)) & TOUCH_EV.tap).toBeTruthy();
        expect(play(still(260)) & (TOUCH_EV.tap | TOUCH_EV.hold)).toBe(0);
        expect(play(still(600)) & TOUCH_EV.hold).toBeTruthy();
        expect(play(still(600), 1, 0) & TOUCH_EV.tap).toBe(0);
    });

    it("the dead zone decides: 0.6 mm of drift cancels at 0.5 mm, not at 0.8 mm", () => {
        expect(play(still(120, 1, 60), { deadZone: 50 }) & TOUCH_EV.drift).toBeTruthy();
        expect(play(still(120, 1, 60), { deadZone: 50 }) & TOUCH_EV.tap).toBe(0);
        expect(play(still(120, 1, 60), { deadZone: 80 }) & TOUCH_EV.tap).toBeTruthy();
    });

    it("the switches turn each click off", () => {
        expect(play(still(90), 1, 0) & TOUCH_EV.tap).toBeTruthy();
        expect(play(still(90), { tapOn: false } as never) & TOUCH_EV.tap).toBe(0);
        expect(play(still(600), 1, 0) & TOUCH_EV.hold).toBeTruthy();
        const m = new ChipModel(() => ({ ...SETTINGS, holdOn: false }));
        let ev = 0;
        for (const [t, x, y, f] of still(600)) { m.sample({ t, x, y, fingers: f }); ev |= m.read(t).events; }
        expect(ev & TOUCH_EV.hold).toBe(0);
        expect(play(still(100, 2)) & TOUCH_EV.twoTap).toBeTruthy();
    });

    it("leaving the zone after the hold fired is a drag, not a cancel", () => {
        const s = still(450);
        s.pop();
        s.push([460, 1500, 1000, 1], [470, 1500, 1000, 0]);
        const ev = play(s);
        expect(ev & TOUCH_EV.hold).toBeTruthy();
        expect(ev & TOUCH_EV.drift).toBe(0);
    });
});

describe("the simulated board's scripted touches", () => {
    // Each scripted touch, played through the chip model with the defaults, does what its name says.
    const expected: Record<string, number> = {
        "quick tap": TOUCH_EV.tap,
        "tap that rolls 0.6 mm at the lift": TOUCH_EV.tap,
        "slow touch, too long for a tap": 0,
        "press and hold": TOUCH_EV.hold,
        "hold that drifts 0.65 mm": TOUCH_EV.hold,
        "two-finger tap": TOUCH_EV.twoTap,
        "two-finger scroll": TOUCH_EV.scroll,
        "two fingers that move 0.6 mm, too little to scroll": 0,
        "three-finger touch": 0,
        "resting palm": TOUCH_EV.hold,
        "pointer move": TOUCH_EV.drift,
    };

    it("covers every case once, within one loop", () => {
        expect(TOUCH_SCRIPT.map((s) => s.name)).toEqual(Object.keys(expected));
        expect(SCRIPT_MS).toBeGreaterThan(5000);
        expect(SCRIPT_MS).toBeLessThan(20000);
    });

    it.each(Object.entries(expected))("%s", (name, want) => {
        const m = new ChipModel(() => SETTINGS);
        let at = 0;
        for (const s of TOUCH_SCRIPT) {
            if (s.name === name) break;
            at += s.ms + s.gap;
        }
        const s = TOUCH_SCRIPT.find((x) => x.name === name)!;
        let events = 0;
        for (let t = at; t <= at + s.ms + 20; t += 10) {
            m.sample(scriptSample(t));
            events |= m.read(t).events;
        }
        const kinds = TOUCH_EV.tap | TOUCH_EV.hold | TOUCH_EV.twoTap | TOUCH_EV.drift | TOUCH_EV.scroll;
        if (name === "hold that drifts 0.65 mm") expect(events & TOUCH_EV.drift).toBe(0);
        expect(events & kinds & (want || kinds)).toBe(want);
    });

    it("at a 0.5 mm dead zone, the rolling tap and the drifting hold are canceled", () => {
        for (const name of ["tap that rolls 0.6 mm at the lift", "hold that drifts 0.65 mm"]) {
            const m = new ChipModel(() => ({ ...SETTINGS, deadZone: 50 }));
            let at = 0;
            for (const s of TOUCH_SCRIPT) { if (s.name === name) break; at += s.ms + s.gap; }
            const s = TOUCH_SCRIPT.find((x) => x.name === name)!;
            let events = 0;
            for (let t = at; t <= at + s.ms + 20; t += 10) { m.sample(scriptSample(t)); events |= m.read(t).events; }
            expect(events & TOUCH_EV.drift, name).toBeTruthy();
            expect(events & (TOUCH_EV.tap | TOUCH_EV.hold), name).toBe(0);
        }
    });
});

describe("the fingers page", () => {
    const block = (b: Partial<PadFingersBlock>): PadFingersBlock => ({ ...EMPTY_FINGERS, valid: true, ...b });

    it("reads GET_INFO byte 20 bit 7 and byte 21 bit 0", () => {
        expect(hasPadFingers(0x80)).toBe(true);
        expect(hasPadFingers(0x7f)).toBe(false);
        expect(hasPadPalm(0x01)).toBe(true);
        expect(hasPadPalm(undefined)).toBe(false);
    });

    it("round-trips the firmware's layout: every slot, the two-finger numbers, the palm threshold", () => {
        const left = block({ os: true, two: true, hadTwo: true, scrolled: true, fingers: [{ slot: 0, x: 2150, y: 2000, area: 3 }, { slot: 3, x: 4298, y: 3998, area: 12 }],
            startX: 2100, startY: 2010, travel: 160, twoMs: 80 });
        const right = block({ twoTap: true, chipPalm: true, tooMany: true });
        const bytes = packPadFingers({ palm: 10, left, right });
        expect(bytes).toHaveLength(56);
        expect(bytes[0]).toBe(1);
        expect(bytes[1]).toBe(10);
        // The firmware's own test vector: slot 0 at 1075, 1000 (0.02 mm), area 3.
        expect(bytes[2]).toBe(0x01 | 0x02 | 0x10 | 0x20 | 0x80); // valid, OS, two, scrolled, had two
        expect(bytes[3]).toBe(0x09); // slots 0 and 3
        expect(bytes[4] | (bytes[5] << 8) | (bytes[6] << 16)).toBe(1075 | (1000 << 12));
        const r = parsePadFingers(Uint8Array.from([0x2d, ...bytes]))!;
        expect(r.palm).toBe(10);
        expect(r.left.fingers).toEqual([{ slot: 0, x: 2150, y: 2000, area: 3 }, { slot: 3, x: 4298, y: 3998, area: 12 }]);
        expect(r.left).toMatchObject({ os: true, two: true, hadTwo: true, scrolled: true, startX: 2100, startY: 2010, travel: 160, twoMs: 80 });
        expect(r.right).toMatchObject({ valid: true, twoTap: true, chipPalm: true, tooMany: true, fingers: [] });
    });

    it("refuses anything else", () => {
        expect(parsePadFingers(null)).toBeNull();
        expect(parsePadFingers(Uint8Array.from([0x2d, 2, ...new Array(55).fill(0)]))).toBeNull(); // the touch page's format
        expect(parsePadFingers(Uint8Array.from([0x2d, 1, 0]))).toBeNull(); // short
        const empty = parsePadFingers(Uint8Array.from([0x2d, 1, ...new Array(55).fill(0)]))!;
        expect(empty.left.valid).toBe(false);
    });

    it("a palm is a contact larger than the threshold, never with it off", () => {
        expect(isPalm(0, 40)).toBe(false);
        expect(isPalm(10, 10)).toBe(false);
        expect(isPalm(10, 11)).toBe(true);
        expect(formatPalm(0)).toBe("Off");
        expect(formatPalm(12)).toBe("over 12 channels");
        expect(PAD_TUNING_KEYS).toContain(PAD_PALM_KEY);
    });
});

describe("multi-finger touches, and what the chip made of them", () => {
    const r = report();
    const play = (name: string, cfg: Partial<ChipSettings> = {}, palm = 0, os = false) => {
        const m = new ChipModel(() => ({ ...SETTINGS, scrollStart: 105, ...cfg }));
        const t = new TouchTracker();
        let at = 0;
        for (const s of TOUCH_SCRIPT) { if (s.name === name) break; at += s.ms + s.gap; }
        const s = TOUCH_SCRIPT.find((x) => x.name === name)!;
        const seen: PadFingersBlock[] = [];
        let done = null;
        for (let tt = at; tt <= at + s.ms + 60; tt += 30) {
            for (let u = tt - 20; u <= tt; u += 10) m.sample(scriptSample(u));
            const b = { ...m.read(tt), os };
            const f = { ...m.readFingers(tt), os };
            seen.push(f);
            done = t.take(b, { ...r, deadZone: cfg.deadZone ?? 80 }, f, palm) ?? done;
        }
        return { done: done!, seen, tracker: t };
    };

    it("two fingers that scroll: the chip's rule, from the two-finger start, and when it started", () => {
        const { done, seen } = play("two-finger scroll");
        const live = seen.filter((f) => f.two);
        expect(live.length).toBeGreaterThan(5);
        expect(live.every((f) => f.fingers.length === 2)).toBe(true);
        const first = seen.findIndex((f) => f.scrolled);
        expect(seen[first].travel).toBeGreaterThan(105);
        expect(seen[first - 1].travel).toBeLessThanOrEqual(105 + 40);
        expect(done.kind).toBe("scroll");
        expect(done.text).toMatch(/^Two-finger scroll: started after \d+(\.\d+)? mm \(scroll start 1\.05 mm\)$/);
    });

    it("a higher scroll start: the same touch scrolls later", () => {
        const at = (start: number) => { const { seen } = play("two-finger scroll", { scrollStart: start }); return seen.findIndex((f) => f.scrolled); };
        expect(at(400)).toBeGreaterThan(at(105));
    });

    it("too little travel: no scroll, and says how far of the scroll start", () => {
        const { done, seen } = play("two fingers that move 0.6 mm, too little to scroll");
        expect(seen.some((f) => f.scrolled)).toBe(false);
        expect(done.kind).toBe("short");
        expect(done.text).toMatch(/^Two fingers, no click: moved 0\.\d+ mm of the 1\.05 mm scroll start; lifted at \d+ ms, past the 150 ms tap time$/);
    });

    it("a two-finger tap fires at the lift, with a check", () => {
        const { done } = play("two-finger tap");
        expect(done.kind).toBe("right");
        expect(done.text).toMatch(/^Two-finger tap ✓ right click, \d+ ms$/);
    });

    it("three fingers: every finger, no gesture", () => {
        const { done, seen } = play("three-finger touch");
        expect(Math.max(...seen.map((f) => f.fingers.length))).toBe(3);
        expect(new Set(seen.flatMap((f) => f.fingers.map((p) => p.slot)))).toEqual(new Set([0, 1, 2]));
        expect(seen.some((f) => f.two && f.fingers.length === 3)).toBe(false);
        expect(done.kind).toBe("multi");
        expect(done.text).toMatch(/^Three fingers: no tap or scroll on the chip/);
    });

    it("a resting palm: plain with palm rejection off, a palm above the threshold", () => {
        expect(play("resting palm").done.kind).not.toBe("palm");
        const { done } = play("resting palm", {}, 10);
        expect(done.kind).toBe("palm");
        expect(done.text).toMatch(/^Palm: 14 channels, over 10: the pad ignored it/);
        expect(play("resting palm", {}, 10, true).done.text).toMatch(/the computer ignores it/);
        expect(play("resting palm", {}, 20).done.kind).not.toBe("palm");
    });

    it("in touchpad mode, says what the chip would have done", () => {
        expect(play("two-finger tap", {}, 0, true).done.text).toMatch(/^Chip would right click \(two-finger tap\), \d+ ms$/);
        expect(play("two-finger scroll", {}, 0, true).done.text).toMatch(/^Chip would start scrolling after \d/);
        expect(play("quick tap", {}, 0, true).done).toMatchObject({ kind: "tap", os: true });
        expect(play("quick tap", {}, 0, true).done.text).toMatch(/^Chip would tap: /);
        expect(chipWould("No click: 300 ms")).toBe("Chip wouldn't click: 300 ms");
        expect(chipWould("Canceled: moved 1 mm")).toBe("Chip would cancel: moved 1 mm");
        expect(chipWould("Palm: 14 channels")).toBe("Palm: 14 channels");
    });

    it("a stale two-finger touch from before doesn't color a single tap", () => {
        const t = new TouchTracker();
        const stale = { ...EMPTY_FINGERS, valid: true, hadTwo: true, travel: 300, startX: 10, startY: 10 };
        t.take({ ...EMPTY_BLOCK, valid: true, down: true, fingers: 1, events: TOUCH_EV.down }, r, { ...stale, fingers: [{ slot: 0, x: 1, y: 1, area: 3 }] });
        const o = t.take({ ...EMPTY_BLOCK, valid: true, events: TOUCH_EV.up | TOUCH_EV.tap, ms: 80 }, r, stale);
        expect(o!.kind).toBe("tap");
    });
});

describe("the Touchpad section with tuning", () => {
    const menus = [{ label: "Pointing Device", content: [{ label: "Left Pointer", content: [{ label: "DPI", type: "dropdown" as const, content: ["id_left_dpi", 0, 0] }] }] }];

    it("adds the tuning values and the link only on firmware with bit 5", () => {
        const keys = (flags3: number) => JSON.stringify(withTouchpadTaps(menus, flags3));
        expect(keys(0x10)).not.toContain("id_pad_dead_zone");
        expect(keys(0x10)).not.toContain(TUNE_TOUCHPAD_ACTION);
        const withTuning = keys(0x30);
        for (const k of ["id_pad_dead_zone", "id_pad_tap_ms", "id_pad_scroll_start", TUNE_TOUCHPAD_ACTION]) expect(withTuning).toContain(k);
    });

    it("adds palm rejection (VIA 58) only on firmware with GET_INFO byte 21 bit 0", () => {
        expect(JSON.stringify(withTouchpadTaps(menus, 0x30))).not.toContain(PAD_PALM_KEY);
        expect(JSON.stringify(withTouchpadTaps(menus, 0x30, 0x01))).toContain(PAD_PALM_KEY);
    });

    it("reads the tuning values as 16-bit (their ranges pass 255) on the menu's channel", () => {
        const section = (withTouchpadTaps(menus, 0x30)[0].content as { label?: string; content: unknown[] }[]).find((i) => i.label === "Touchpad")!;
        const items = section.content as { type: string; options?: number[]; content: (string | number)[] }[];
        for (const id of [55, 56, 57]) {
            const item = items.find((i) => i.content[2] === id)!;
            expect(item.type).toBe("range");
            expect(item.options![1]).toBeGreaterThan(255);
            expect(item.content[1]).toBe(0);
        }
    });
});
