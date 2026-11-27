import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { KeyContent } from '@/types/keyboard.types';
import { getHeaderIcons, getCenterContent, getTypeIcon } from '@/utils/key-icons';
import type { Appearance, Preferences } from './core';
import { haloColor } from './core';
import { DualLegendFace } from '@/components/DualLegendFace';
import { KEY_BAND_PX, DIAGONAL_INSET_PX, planLegends, type DualLegend } from '@/lib/shiftedLegends';
export interface SurfaceKey { id: number; x: number; y: number; w: number; h: number; label: string; code: number; layer: number; hand: string; legend?: { keycode: string; keyContents?: KeyContent; displayLabel: string; topLabel: string; bottomStr: string; dual?: DualLegend } }
interface Props { keys: SurfaceKey[]; appearance: Appearance; changed: Set<number>; held: Set<number>; effect: Preferences['effect']; duration: number; hidden: Set<number>; target?: number; onSelect?: (id: number) => void; capitals?: boolean; keyAppearance?: Map<number, Appearance> }
/** A legend that is one letter or digit: drawn larger, and in capitals when asked. */
const SINGLE_ALNUM = /^[\p{L}\p{N}]$/u;
/** Upper case for the Capital letters option, unless that isn't a single character (ß -> SS). */
export function capital(letter: string): string {
    const upper = letter.toUpperCase();
    return [...upper].length === 1 ? upper : letter;
}
export function OverlaySurface({ keys, appearance, changed, held, effect, duration, hidden, target, onSelect, capitals = false, keyAppearance }: Props) {
    if (!keys.length) return <p>No physical keys in this layout.</p>;
    const minX = Math.min(...keys.map(k => k.x)), minY = Math.min(...keys.map(k => k.y));
    const width = Math.max(...keys.map(k => k.x + k.w)) - minX;
    const height = Math.max(...keys.map(k => k.y + k.h)) - minY;
    const viewWidth = width * 40 + 8, viewHeight = height * 40 + 8;
    return <SurfaceFrame viewWidth={viewWidth} viewHeight={viewHeight} legends={keys.map(k => {
        if (!k.legend || hidden.has(k.id)) return null;
        const a = keyAppearance?.get(k.id) ?? appearance;
        // The key's group sits at (x, y) * 40 in a drawing that starts at -4, and its legend 2 px inside it.
        return <div key={k.id} data-key-id={k.id} style={{ left: (k.x - minX) * 40 + 6, top: (k.y - minY) * 40 + 6, width: k.w * 40 - 7, height: k.h * 40 - 7 }}>
            <KeyLegend legend={k.legend} width={k.w * 40 - 7} height={k.h * 40 - 7} color={a.legend} opacity={a.legendAlpha / 100} halo={a.halo} capitals={capitals} />
        </div>;
    })}><svg role="img" aria-label="Overlay keyboard preview" viewBox={`-4 -4 ${viewWidth} ${viewHeight}`}>
        {keys.map(k => {
            const a = keyAppearance?.get(k.id) ?? appearance;
            const isHeld = held.has(k.id), isChanged = changed.has(k.id) && effect !== 'Off';
            const label = hidden.has(k.id) ? '·' : k.label;
            const lines = label.split('\n').slice(0, 3);
            return <g key={k.id} data-key-id={k.id} transform={`translate(${(k.x - minX) * 40} ${(k.y - minY) * 40})`} onClick={() => onSelect?.(k.id)}>
                <title>{`${k.hand} · ${k.label.split('\n').join(' / ')} · layer ${k.layer}`}</title>
                {/* The halo also traces the outline, in the contrasting color, so keys stay visible on any background. */}
                {a.halo && a.width > 0 && <rect width={k.w * 40 - 3} height={k.h * 40 - 3} rx="6" fill="none"
                    stroke={haloColor(a.outline)} strokeWidth={a.width + 2} strokeOpacity={.55 * a.outlineAlpha / 100} />}
                <rect width={k.w * 40 - 3} height={k.h * 40 - 3} rx="6" fill={a.fill} fillOpacity={a.fillAlpha / 100}
                    stroke={isHeld ? a.pressed : target === k.id ? a.changed : a.outline} strokeWidth={a.width} strokeOpacity={a.outlineAlpha / 100} />
                {isChanged && <rect className={effect === 'Short fade' ? 'trainer-fade' : ''} style={{ animationDuration: `${duration}ms` }} width={k.w * 40 - 3} height={k.h * 40 - 3} rx="6"
                    fill={a.changed} fillOpacity={a.fillAlpha / 200} stroke={a.changed} strokeOpacity={a.outlineAlpha / 100} strokeWidth={a.width ? a.width + 1 : 0} />}
                {isHeld && <rect width={k.w * 40 - 3} height={k.h * 40 - 3} rx="6" fill={a.pressed} fillOpacity={a.fillAlpha / 200} />}
                {k.legend && !hidden.has(k.id) ? null : lines.map((line, i) => <text key={i} x={(k.w * 40 - 3) / 2} y={(k.h * 40 - 3) / 2 + 4 + (i - (lines.length - 1) / 2) * 11}
                    textAnchor="middle" fontSize={SINGLE_ALNUM.test(line) ? 18 : line.length > 5 ? 8 : 12} fontWeight="600"
                    textLength={line.length > 6 ? Math.max(15, k.w * 40 - 9) : undefined} lengthAdjust="spacingAndGlyphs"
                    fill={a.legend} fillOpacity={a.legendAlpha / 100} stroke={a.halo ? haloColor(a.legend) : 'none'} strokeOpacity={a.legendAlpha / 100} strokeWidth="3" paintOrder="stroke fill">{capitals && SINGLE_ALNUM.test(line) ? capital(line) : line}</text>)}
            </g>;
        })}
    </svg></SurfaceFrame>;
}

/**
 * The key drawing (an SVG) with the legends laid over it as ordinary HTML.
 *
 * The legends used to be HTML inside an SVG <foreignObject> on each key. WebKit (Safari, and the web views of
 * macOS and Linux) paints such HTML at the SVG's corner, unscaled, as soon as it has a filter, an opacity,
 * clipping or positioning, and the legends have all four: every legend piled up in the top-left corner over
 * blank keys. HTML outside the SVG is painted the same by every engine. The layer has the drawing's own size
 * in its units and is scaled and centered exactly as the SVG scales its viewBox (fit inside, centered).
 */
function SurfaceFrame({ viewWidth, viewHeight, legends, children }: { viewWidth: number; viewHeight: number; legends: ReactNode; children: ReactNode }) {
    const frame = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);
    useLayoutEffect(() => {
        const el = frame.current;
        if (!el) return;
        const measure = () => { const r = el.getBoundingClientRect(); setSize(s => (s && s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height })); };
        measure();
        if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    // Before the first measurement (and where there is no layout, as in unit tests) the layer is unscaled.
    const scale = size && size.w && size.h ? Math.min(size.w / viewWidth, size.h / viewHeight) : 1;
    const left = size ? (size.w - viewWidth * scale) / 2 : 0, top = size ? (size.h - viewHeight * scale) / 2 : 0;
    return <div className="trainer-surface" ref={frame}>
        {children}
        <div className="trainer-legends" style={{ left, top, width: viewWidth, height: viewHeight, transform: `scale(${scale})`, visibility: size ? undefined : 'hidden' }}>{legends}</div>
    </div>;
}

/** A legend halo: stacked shadows build a solid edge in the contrasting color, readable on any background. */
const HALO = (c: string) => `drop-shadow(0 0 .5px ${c}) drop-shadow(0 0 1px ${c}) drop-shadow(0 0 1.5px ${c})`;

function KeyLegend({ legend: l, width, height, color, opacity, halo, capitals }: { legend: NonNullable<SurfaceKey['legend']>; width: number; height: number; color: string; opacity: number; halo: boolean; capitals: boolean }) {
    const { icons, isMouse } = getHeaderIcons(l.keycode, l.displayLabel);
    const layer = l.keyContents?.type === 'layer';
    const icon = getTypeIcon(l.keyContents?.type || '', 'small');
    const top = layer ? l.keyContents?.layertext : l.topLabel;
    const content = layer ? l.keyContents?.top?.split('(')[1]?.replace(')', '') : getCenterContent(l.displayLabel, l.keycode, isMouse);
    const alnum = !layer && typeof content === 'string' && SINGLE_ALNUM.test(content); // not a layer key's number
    const center = alnum && capitals ? capital(content as string) : content;
    // Digit and punctuation keys draw the keycap grid (shifted top left, base bottom left, AltGr bottom
    // right) with the same planner as Keybard's keys, at its small size; a key without room keeps one centered legend.
    const bands = (icons.length > 0 || top ? 1 : 0) + (l.bottomStr ? 1 : 0);
    const dual = l.dual?.letter && l.dual.shifted && capitals ? { ...l.dual, shifted: capital(l.dual.shifted) } : l.dual;
    const plan = dual ? planLegends(dual, 'small', height - KEY_BAND_PX.small * bands, width - 2 * DIAGONAL_INSET_PX.small.x, false) : null;
    if (plan) return <div className="trainer-key-legend" style={{ color, opacity, filter: halo ? HALO(haloColor(color)) : undefined, justifyContent: 'flex-start' }}>
        {(icons.length > 0 || top) && <div className="trainer-key-heading">{icons.length ? icons : top}</div>}
        <DualLegendFace plan={plan} variant="small" />
        {l.bottomStr && <div className="trainer-key-heading">{l.bottomStr}</div>}
    </div>;
    return <div className="trainer-key-legend" style={{ color, opacity, filter: halo ? HALO(haloColor(color)) : undefined }}>
        {(icons.length > 0 || top) && <div className="trainer-key-heading">{icons.length ? icons : top}</div>}
        <div className="trainer-key-center" style={{ flexDirection: icon && !layer ? 'column' : 'row', fontSize: alnum ? 18 : typeof center === 'string' && center.length > 6 ? 7 : typeof center === 'string' && center.length > 3 ? 9 : 12 }}>
            {!layer && icon}{center}{layer && icon}
        </div>
        {l.bottomStr && <div className="trainer-key-heading">{l.bottomStr}</div>}
    </div>;
}
