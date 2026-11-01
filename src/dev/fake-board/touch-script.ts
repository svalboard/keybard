// Scripted touches for the simulated board's touchpads (?fakeBoard=touchpad),
// played in a loop through the chip model (utils/touchpad-tuning.ts ChipModel)
// with the board's own tuning, so changing the dead zone or the times changes
// what each touch does. Positions in 0.01 mm on a 43 x 40 mm pad, a sample
// every 10 ms (the chip's report period). The finger wobbles a little, as a
// real one does; the wobble is fixed (seeded), so every loop is the same.
// Some touches have more fingers (each in its own chip slot), and one is a
// resting palm: a contact far larger than a fingertip.
import type { TouchPoint, TouchSample } from "@/utils/touchpad-tuning";

/** Another finger of a touch: where it sits from the first, when it lands, its area. */
export interface OtherFinger {
    ox: number;
    oy: number;
    /** ms after the first finger. */
    delay?: number;
    area?: number;
}

export interface ScriptedTouch {
    /** What the touch is meant to show, for tests and the review page. */
    name: string;
    ms: number;
    fingers: number;
    /** Start point and how far it travels by the end (0.01 mm). */
    x: number;
    y: number;
    dx: number;
    dy: number;
    /** When the travel happens: the whole touch (0), or only the last this-many ms (a roll at the lift). */
    late?: number;
    /** Or only the first this-many ms (a finger that settles while it rests). */
    by?: number;
    /** The first finger's area once pressed in, channels (3: a fingertip). */
    area?: number;
    /** The other fingers; they move with the first and lift with it. */
    others?: OtherFinger[];
    /** Idle time after it, ms. */
    gap: number;
}

export const TOUCH_SCRIPT: ScriptedTouch[] = [
    { name: "quick tap", ms: 90, fingers: 1, x: 1500, y: 1700, dx: 15, dy: 10, gap: 900 },
    { name: "tap that rolls 0.6 mm at the lift", ms: 120, fingers: 1, x: 2400, y: 2100, dx: 50, dy: 35, late: 40, gap: 1100 },
    { name: "slow touch, too long for a tap", ms: 280, fingers: 1, x: 2000, y: 1500, dx: 10, dy: 15, gap: 1000 },
    { name: "press and hold", ms: 1100, fingers: 1, x: 1800, y: 2300, dx: 30, dy: 20, gap: 1100 },
    { name: "hold that drifts 0.65 mm", ms: 700, fingers: 1, x: 2600, y: 1600, dx: 45, dy: 47, by: 400, gap: 1100 },
    { name: "two-finger tap", ms: 110, fingers: 2, x: 1300, y: 2000, dx: 10, dy: 0, others: [{ ox: 1600, oy: -150 }], gap: 1100 },
    { name: "two-finger scroll", ms: 700, fingers: 2, x: 1300, y: 1200, dx: 0, dy: 900, others: [{ ox: 1700, oy: -100, delay: 40 }], gap: 1100 },
    { name: "two fingers that move 0.6 mm, too little to scroll", ms: 450, fingers: 2, x: 1400, y: 1800, dx: 40, dy: 45, others: [{ ox: 1600, oy: 120, delay: 30 }], gap: 1000 },
    { name: "three-finger touch", ms: 500, fingers: 3, x: 800, y: 2000, dx: 20, dy: 10, others: [{ ox: 1500, oy: -250, delay: 30 }, { ox: 3000, oy: 50, delay: 60 }], gap: 1000 },
    { name: "resting palm", ms: 900, fingers: 1, x: 2700, y: 2700, dx: 80, dy: -40, area: 14, gap: 1100 },
    { name: "pointer move", ms: 600, fingers: 1, x: 1000, y: 2600, dx: 1800, dy: -700, gap: 1400 },
];

export const SCRIPT_MS = TOUCH_SCRIPT.reduce((t, s) => t + s.ms + s.gap, 0);

function wobble(seed: number): number {
    const v = Math.sin(seed * 12.9898) * 43758.5453;
    return (v - Math.floor(v)) * 2 - 1;
}

/** The finger at time t (0..SCRIPT_MS) of the loop. */
export function scriptSample(t: number): TouchSample {
    let at = 0;
    for (const [i, s] of TOUCH_SCRIPT.entries()) {
        if (t < at + s.ms) {
            const u = t - at;
            // The last 10 ms sample of a touch is at its full travel.
            const k = Math.min(1, s.late ? Math.max(0, (u - (s.ms - s.late)) / (s.late - 10)) : u / ((s.by ?? s.ms) - 10));
            const w = 6 * wobble(i * 1000 + Math.floor(u / 10));
            // A finger presses in over its first 60 ms (a palm over 150): its strength and footprint grow, then hold.
            const press = Math.min(1, (u + 10) / (s.area ? 150 : 60));
            const strength = Math.round((420 + 380 * press) * (1 + 0.05 * wobble(i * 7 + Math.floor(u / 30))));
            const full = s.area ?? (s.fingers > 1 ? 4 : 3);
            const area = Math.max(1, Math.round(full * press));
            const x = Math.round(s.x + s.dx * k + w), y = Math.round(s.y + s.dy * k - w);
            const points: TouchPoint[] = [{ slot: 0, x, y, area }];
            for (const [j, o] of (s.others ?? []).entries()) {
                if (u < (o.delay ?? 0)) continue;
                const v = 5 * wobble(i * 1000 + 97 * (j + 1) + Math.floor(u / 10));
                const pressed = Math.min(1, (u - (o.delay ?? 0) + 10) / 60);
                points.push({ slot: j + 1, x: x + o.ox + Math.round(v), y: y + o.oy - Math.round(v), area: Math.max(1, Math.round((o.area ?? 4) * pressed)) });
            }
            return { t, x, y, fingers: points.length, strength, area, points };
        }
        at += s.ms + s.gap;
        if (t < at) return { t, x: s.x + s.dx, y: s.y + s.dy, fingers: 0, points: [] };
    }
    return { t, x: 0, y: 0, fingers: 0, points: [] };
}
