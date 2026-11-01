import { useEffect, useRef } from "react";

import {
    formatMm, isPalm, TOUCH_EV, type MultiTouch, type PadFingersBlock, type PadTouchBlock, type TouchOutcome,
} from "@/utils/touchpad-tuning";

export interface PadTiming {
    deadZone: number; // 0.01 mm
    tapMs: number;
    holdMs: number;
    holdOn: boolean;
    width: number; // 0.01 mm
    height: number;
    /** How far two fingers travel, on average, before the chip scrolls (0.01 mm). */
    scrollStart: number;
}

interface PadViewProps {
    side: "left" | "right";
    /** The pad's latest block, and when it was read (performance.now()). */
    block: PadTouchBlock;
    readAt: number;
    /** Events of the touch now, or of the last one. */
    touchEvents: number;
    /** Where that touch has been, 0.01 mm. */
    trail: { x: number; y: number }[];
    timing: PadTiming;
    outcomes: TouchOutcome[];
    /** Touches finished since the view opened. */
    count: number;
    /** The first finger's reported footprint as a circle radius, 0.01 mm (0: not reported, draw a dot). */
    contactR: number;
    /** Every finger now (the fingers page; not valid on firmware without it). */
    fingers: PadFingersBlock;
    /** The touch now (or the last one) across fingers: two-finger numbers, the largest finger. */
    touch: MultiTouch | null;
    /** Where the two fingers' centroid has been since the second landed. */
    twoTrail: { x: number; y: number }[];
    /** A finger's footprint radius for its area, 0.01 mm (0: not reported). */
    radiusOf: (area: number) => number;
    /** The palm rejection threshold in force, channels; 0 off. */
    palm: number;
}

/** The close-up's size on screen, CSS px: phones, and wider screens (Tailwind sm). */
const CLOSE_PX_PHONE = 240;
const CLOSE_PX_WIDE = 304;
const wide = () => typeof window !== "undefined" && !!window.matchMedia?.("(min-width: 640px)").matches;
/** Guides of a gesture that has resolved (fired, canceled, lifted) stay, faint. */
const RESOLVED = 0.4;

/** An arc from fraction a to b of a full circle, clockwise from the top. */
function arc(cx: number, cy: number, r: number, a: number, b: number): string {
    const p = (f: number) => [cx + r * Math.sin(2 * Math.PI * f), cy - r * Math.cos(2 * Math.PI * f)];
    if (b <= a) return "";
    if (b - a >= 0.9999) return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}`;
    const [x1, y1] = p(a), [x2, y2] = p(b);
    return `M ${x1} ${y1} A ${r} ${r} 0 ${b - a > 0.5 ? 1 : 0} 1 ${x2} ${y2}`;
}

const KIND_TONE: Record<TouchOutcome["kind"], string> = {
    tap: "text-kb-touch-tap", right: "text-kb-touch-tap", hold: "text-kb-touch-hold", canceled: "text-kb-touch-cancel",
    late: "text-muted-foreground", short: "text-muted-foreground", moved: "text-muted-foreground", scroll: "text-kb-touch-tap",
    palm: "text-muted-foreground", multi: "text-muted-foreground", touch: "text-muted-foreground",
};

function markOf(events: number, scrolled: boolean, gesture: "one" | "two" | "many" | "os"): { text: string; tone: string; cancel: boolean } | null {
    if (gesture === "os") return null;
    if (events & TOUCH_EV.twoTap) return { text: "Right click", tone: "var(--kb-touch-tap)", cancel: false };
    if (scrolled) return { text: "Scroll", tone: "var(--kb-touch-tap)", cancel: false };
    // The first finger's tap, hold and dead zone say nothing about a touch of more fingers.
    if (gesture !== "one") return null;
    if (events & TOUCH_EV.hold) return { text: "Hold", tone: "var(--kb-touch-hold)", cancel: false };
    if (events & TOUCH_EV.tap) return { text: "Tap", tone: "var(--kb-touch-tap)", cancel: false };
    if (events & TOUCH_EV.drift) return { text: "Canceled", tone: "var(--kb-touch-cancel)", cancel: true };
    return null;
}

const WORDS = ["no", "one", "two", "three", "four", "five"];

/**
 * One pad: at its true size, with every finger on it and where the touch
 * began, and a close-up of the gesture the chip is deciding. One finger: the
 * dead zone around its touch-down point, the path, and how long it has been
 * down against the tap window and the hold threshold. Two fingers: the line
 * between them, and the scroll start as a ring around where their centroid
 * began, with their average travel (the chip's measure) growing inside it;
 * the tap window for a two-finger tap. Three or more: the fingers only. Only
 * the active gesture's guides show, faint once it has resolved. Redraws per
 * frame only while a finger is down, and only the timer.
 */
export function PadView({ side, block, readAt, touchEvents, trail, timing, outcomes, count, contactR, fingers, touch, twoTrail, radiusOf, palm }: PadViewProps) {
    const progressRef = useRef<SVGPathElement>(null);
    const msRef = useRef<HTMLSpanElement>(null);
    // Strength has no fixed scale (it follows the pad's sensitivity): shade against the strongest touch seen.
    const strongest = useRef(1);
    if (block.strength > strongest.current) strongest.current = block.strength;
    const press = block.strength ? 0.15 + 0.35 * Math.min(1, block.strength / strongest.current) : 0.2;

    // Touchpad mode: the computer makes the gestures, so this pad shows contacts, palms and counts only.
    const osPad = block.os;
    const multi = fingers.valid;
    const peak = Math.max(touch?.maxFingers ?? 0, multi ? fingers.fingers.length : block.fingers);
    const gesture: "one" | "two" | "many" | "os" = osPad ? "os" : touch?.hadTwo && peak <= 2 ? "two" : peak >= 3 ? "many" : peak === 2 && !multi ? "two" : "one";
    const two = gesture === "two" && multi;
    const scrolled = two && (fingers.scrolled || !!touch?.scrolledAt);

    const total = gesture === "one" ? timing.tapMs + (timing.holdOn ? timing.holdMs : 0) : timing.tapMs;
    // Past this nothing more can happen to the touch: the timer stops redrawing.
    const timerSpan = Math.max(total * 1.25, timing.tapMs + 200);
    const { down } = block;
    const dz = Math.max(timing.deadZone, 10);
    const ss = Math.max(timing.scrollStart, 10);
    // The close-up: the gesture's threshold takes half its width, with the timer ring outside it.
    const ref = two ? ss : dz;
    const half = ref * 2;
    const ringR = ref * 1.45, ringW = ref * 0.16;
    const cx = two ? fingers.startX : block.downX, cy = two ? fingers.startY : block.downY;

    useEffect(() => {
        const draw = (ms: number) => {
            if (progressRef.current) progressRef.current.setAttribute("d", arc(cx, cy, ringR, 0, Math.min(1, ms / total)));
            if (msRef.current) msRef.current.textContent = `${Math.round(ms)} ms`;
        };
        if (!down) { draw(block.ms); return; }
        let frame = 0;
        const tick = () => {
            const ms = block.ms + (performance.now() - readAt);
            draw(ms);
            if (ms < timerSpan) frame = requestAnimationFrame(tick);
        };
        tick();
        return () => cancelAnimationFrame(frame);
    }, [down, block.ms, readAt, cx, cy, ringR, total, timerSpan]);

    const label = side === "left" ? "Left pad" : "Right pad";
    const shown = block.valid && (block.down || block.ms > 0);
    const mark = shown ? markOf(touchEvents, scrolled, gesture) : null;
    const resolved = !down || !!mark;
    const guide = resolved ? RESOLVED : 1;
    const zoneTone = block.outside ? "var(--kb-touch-cancel)" : "var(--kb-touch-zone)";
    const path = trail.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
    const twoPath = twoTrail.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
    const mmWide = (2 * half) / 100;
    const closePx = wide() ? CLOSE_PX_WIDE : CLOSE_PX_PHONE;
    const zoom = Math.round(closePx / (mmWide * 3.7795));
    const pair = two && fingers.fingers.length === 2 ? fingers.fingers : null;
    const travel = touch?.hadTwo ? (down ? fingers.travel : touch.maxTravel) : 0;
    const centroid = pair ? { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 } : twoTrail[twoTrail.length - 1] ?? null;
    const n = multi ? fingers.fingers.length : block.down ? block.fingers : 0;

    const fingerCount = (k: number) => `${WORDS[k] ?? k} finger${k === 1 ? "" : "s"}`;
    const readout = !shown ? null : gesture === "os"
        ? <>{down ? `${fingerCount(n)} down` : `last touch, ${fingerCount(peak)}`}</>
        : gesture === "two" && multi
        ? <>{down ? "two fingers · " : "last touch, two fingers · "}moved {formatMm(travel)} of {formatMm(timing.scrollStart)}</>
        : gesture === "many"
            ? <>{down ? `${WORDS[n] ?? n} fingers down` : `last touch, ${WORDS[peak] ?? peak} fingers`}</>
            : <>{down ? "down " : "last touch "}<span ref={msRef} />{<> · moved {formatMm(block.farthest)} of {formatMm(timing.deadZone)}</>}
                {down && contactR > 0 && <> · contact {formatMm(contactR * 2)} across</>}</>;

    const caption = gesture === "os"
        ? "Touchpad mode: contacts only"
        : gesture === "two"
        ? `Close-up, ${zoom}× · scroll start ${formatMm(timing.scrollStart)}, average travel`
        : gesture === "many"
            ? `${(WORDS[peak] ?? String(peak)).replace(/^./, (c) => c.toUpperCase())} fingers: no tap or scroll on the chip`
            : `Close-up, ${zoom}× · dead zone ${formatMm(timing.deadZone)}`;

    return (
        <section aria-label={label} data-pad={side} data-touches={count} data-gesture={shown ? gesture : "none"} className="flex min-w-0 flex-col gap-1.5 sm:h-full">
            <div className="flex h-5 items-baseline justify-between gap-x-2 overflow-hidden">
                <h4 className="text-sm font-semibold text-kb-ink">{label}</h4>
                {block.valid && (
                    <span className="min-w-0 truncate text-xs tabular-nums text-muted-foreground" data-pad-readout>
                        {readout ?? <span ref={msRef} className="sr-only" />}
                    </span>
                )}
            </div>
            {!block.valid ? (
                <p className="h-[27rem] text-xs text-muted-foreground sm:h-[21rem]" data-pad-absent>No touchpad on this hand, or it isn't answering.</p>
            ) : (
                <>
                    <div className="flex h-[27rem] shrink-0 flex-wrap content-start items-start gap-4 overflow-hidden sm:h-[21rem]" data-pad-drawings>
                        <svg
                            role="img"
                            aria-label={`${label} at true size, ${n ? `${n} finger${n === 1 ? "" : "s"} down` : "no finger"}`}
                            viewBox={`0 0 ${timing.width} ${timing.height}`}
                            style={{ width: `${timing.width / 100}mm`, height: `${timing.height / 100}mm` }}
                            className="block shrink-0"
                            data-pad-svg
                        >
                            <rect x={20} y={20} width={timing.width - 40} height={timing.height - 40} rx={300} fill="var(--kb-touch-pad)" stroke="var(--kb-touch-edge)" strokeWidth={40} />
                            {shown && (
                                <g data-touch={block.down ? "down" : "up"}>
                                    {gesture === "one" && (
                                        <g opacity={guide}>
                                            <path d={path} fill="none" stroke="var(--kb-touch-zone)" strokeWidth={30} />
                                            <circle cx={block.downX} cy={block.downY} r={90} fill="none" stroke={zoneTone} strokeWidth={30} />
                                        </g>
                                    )}
                                    {two && touch?.hadTwo && (
                                        <g opacity={guide} data-two-guides>
                                            <circle cx={fingers.startX} cy={fingers.startY} r={ss} fill="none" stroke={scrolled ? "var(--kb-touch-tap)" : "var(--kb-touch-zone)"} strokeWidth={25} />
                                            {pair && <line x1={pair[0].x} y1={pair[0].y} x2={pair[1].x} y2={pair[1].y} stroke="var(--kb-touch-zone)" strokeWidth={20} data-two-line />}
                                        </g>
                                    )}
                                    {multi ? fingers.fingers.map((f) => {
                                        const r = radiusOf(f.area) || 260;
                                        const isPalmContact = isPalm(palm, f.area);
                                        return (
                                            <g key={f.slot} data-finger data-slot={f.slot} data-palm={isPalmContact || undefined} data-contact={radiusOf(f.area) ? "sized" : "dot"}>
                                                {isPalmContact ? (
                                                    <circle cx={f.x} cy={f.y} r={r} fill="none" stroke="var(--kb-touch-zone)" strokeWidth={30} strokeDasharray="90 70" />
                                                ) : (
                                                    <>
                                                        <circle cx={f.x} cy={f.y} r={r} fill="var(--kb-touch-finger)" fillOpacity={press}
                                                            stroke="var(--kb-touch-finger)" strokeOpacity={0.5} strokeWidth={25} />
                                                        <circle cx={f.x} cy={f.y} r={70} fill="var(--kb-touch-finger)" />
                                                    </>
                                                )}
                                                <text x={f.x + r * 0.72 + 40} y={f.y - r * 0.72 - 40} fontSize={220} fill="var(--kb-touch-zone)" data-finger-label>
                                                    {isPalmContact ? "palm" : f.slot + 1}
                                                </text>
                                            </g>
                                        );
                                    }) : block.down && (
                                        <>
                                            <circle cx={block.x} cy={block.y} r={contactR || 260} fill="var(--kb-touch-finger)" fillOpacity={press}
                                                stroke={contactR ? "var(--kb-touch-finger)" : "none"} strokeOpacity={0.5} strokeWidth={25} data-finger data-contact={contactR ? "sized" : "dot"} />
                                            <circle cx={block.x} cy={block.y} r={70} fill="var(--kb-touch-finger)" />
                                        </>
                                    )}
                                    {mark && gesture !== "os" && <text x={Math.min((centroid?.x ?? block.x) + 200, timing.width - 1600)} y={Math.max((centroid?.y ?? block.y) - 400, 330)} fontSize={280} fontWeight={600} fill={mark.tone} data-mark={mark.text}>{mark.text}</text>}
                                </g>
                            )}
                        </svg>
                        <figure className="m-0 flex shrink-0 flex-col gap-0.5" style={{ width: closePx }}>
                            <svg
                                role="img"
                                aria-label={gesture === "two" ? `${label} close-up of the scroll start, ${zoom} times` : `${label} close-up of the dead zone, ${zoom} times`}
                                viewBox={`${cx - half} ${cy - half} ${2 * half} ${2 * half}`}
                                width={closePx}
                                height={closePx}
                                className="block overflow-hidden rounded-md border border-kb-gray-border"
                                style={{ background: "var(--kb-touch-pad)" }}
                                data-close-up={gesture}
                            >
                                {shown && two ? (
                                    <g data-two-close>
                                        <g opacity={guide}>
                                            <circle cx={cx} cy={cy} r={ss} fill="none" stroke={scrolled ? "var(--kb-touch-tap)" : "var(--kb-touch-zone)"} strokeWidth={ss * 0.06} data-scroll-ring />
                                        </g>
                                        {/* The two-finger tap's window: faint once it has passed (a scroll can still start). */}
                                        <g opacity={resolved || block.ms >= timing.tapMs ? RESOLVED : 1}>
                                            <g data-timer-ring>
                                                <path d={arc(cx, cy, ringR, 0, 1)} fill="none" stroke="var(--kb-touch-tap)" strokeOpacity={0.4} strokeWidth={ringW} />
                                                <path ref={progressRef} fill="none" stroke="var(--kb-touch-finger)" strokeWidth={ringW * 0.45} />
                                            </g>
                                        </g>
                                        {travel > 0 && <circle cx={cx} cy={cy} r={Math.min(travel, half)} fill="none" stroke="var(--kb-touch-finger)" strokeWidth={ss * 0.04} data-travel-ring />}
                                        <path d={twoPath} fill="none" stroke="var(--kb-touch-finger)" strokeOpacity={0.6} strokeWidth={ss * 0.03} strokeLinejoin="round" />
                                        <circle cx={cx} cy={cy} r={ss * 0.05} fill="var(--kb-touch-zone)" />
                                        {down && centroid && <circle cx={centroid.x} cy={centroid.y} r={ss * 0.09} fill="var(--kb-touch-finger)" />}
                                    </g>
                                ) : shown && gesture === "one" ? (
                                    <>
                                        {block.down && contactR > 0 && (
                                            <circle cx={block.x} cy={block.y} r={contactR} fill="var(--kb-touch-finger)" fillOpacity={press * 0.35}
                                                stroke="var(--kb-touch-finger)" strokeOpacity={0.35} strokeWidth={dz * 0.03} data-contact-close />
                                        )}
                                        <g opacity={guide}>
                                            <circle cx={cx} cy={cy} r={dz} fill="none" stroke={zoneTone} strokeWidth={dz * 0.06} data-dead-zone />
                                            <g data-timer-ring>
                                                <path d={arc(cx, cy, ringR, 0, timing.tapMs / total)} fill="none" stroke="var(--kb-touch-tap)" strokeOpacity={0.4} strokeWidth={ringW} />
                                                {timing.holdOn && <path d={arc(cx, cy, ringR, timing.tapMs / total, 1)} fill="none" stroke="var(--kb-touch-hold)" strokeOpacity={0.4} strokeWidth={ringW} />}
                                                <path ref={progressRef} fill="none" stroke="var(--kb-touch-finger)" strokeWidth={ringW * 0.45} />
                                            </g>
                                        </g>
                                        <path d={path} fill="none" stroke="var(--kb-touch-finger)" strokeWidth={dz * 0.04} strokeLinejoin="round" data-path />
                                        <circle cx={cx} cy={cy} r={dz * 0.05} fill="var(--kb-touch-zone)" />
                                        {block.down && <circle cx={block.x} cy={block.y} r={dz * 0.11} fill="var(--kb-touch-finger)" />}
                                        {mark?.cancel && (() => {
                                            const out = trail.find((p) => Math.hypot(p.x - cx, p.y - cy) > timing.deadZone) ?? { x: block.x, y: block.y };
                                            const k = dz * 0.14;
                                            return <path d={`M ${out.x - k} ${out.y - k} L ${out.x + k} ${out.y + k} M ${out.x + k} ${out.y - k} L ${out.x - k} ${out.y + k}`} stroke="var(--kb-touch-cancel)" strokeWidth={dz * 0.07} data-cancel-point />;
                                        })()}
                                        {mark && !mark.cancel && <circle cx={block.x} cy={block.y} r={dz * 0.16} fill="none" stroke={mark.tone} strokeWidth={dz * 0.07} />}
                                    </>
                                ) : shown || osPad ? null : (
                                    <circle cx={cx} cy={cy} r={ref} fill="none" stroke="var(--kb-touch-edge)" strokeWidth={ref * 0.04} />
                                )}
                            </svg>
                            <figcaption className="truncate text-xs text-muted-foreground" data-close-caption>{caption}</figcaption>
                        </figure>
                    </div>
                    <p className={"h-8 shrink-0 overflow-hidden text-xs text-muted-foreground" + (block.os ? "" : " invisible")} aria-hidden={!block.os} data-pad-os>
                        Touchpad mode on this pad: the list shows each touch's fingers and palms.
                    </p>
                    <ol className="flex h-44 shrink-0 flex-col gap-0.5 overflow-y-auto sm:h-auto sm:min-h-44 sm:flex-1 rounded-md border border-kb-gray-border px-2 py-1.5 text-xs" aria-label={`${label}: last touches, newest first`} tabIndex={0} data-outcomes>
                        {outcomes.length === 0 && <li className="text-muted-foreground">Touch the pad: each touch shows here, with why it clicked or didn't.</li>}
                        {outcomes.map((o, i) => <li key={count - i} className={KIND_TONE[o.kind]} data-outcome={o.kind} data-os={o.os || undefined}>{o.text}</li>)}
                    </ol>
                </>
            )}
        </section>
    );
}
