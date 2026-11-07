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
    return <svg role="img" aria-label="Overlay keyboard preview" viewBox={`-4 -4 ${width * 40 + 8} ${height * 40 + 8}`}>
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
                {k.legend && !hidden.has(k.id) ? <foreignObject x="2" y="2" width={k.w * 40 - 7} height={k.h * 40 - 7}>
                    <KeyLegend legend={k.legend} width={k.w * 40 - 7} height={k.h * 40 - 7} color={a.legend} opacity={a.legendAlpha / 100} halo={a.halo} capitals={capitals} />
                </foreignObject> : lines.map((line, i) => <text key={i} x={(k.w * 40 - 3) / 2} y={(k.h * 40 - 3) / 2 + 4 + (i - (lines.length - 1) / 2) * 11}
                    textAnchor="middle" fontSize={SINGLE_ALNUM.test(line) ? 18 : line.length > 5 ? 8 : 12} fontWeight="600"
                    textLength={line.length > 6 ? Math.max(15, k.w * 40 - 9) : undefined} lengthAdjust="spacingAndGlyphs"
                    fill={a.legend} fillOpacity={a.legendAlpha / 100} stroke={a.halo ? haloColor(a.legend) : 'none'} strokeOpacity={a.legendAlpha / 100} strokeWidth="3" paintOrder="stroke fill">{capitals && SINGLE_ALNUM.test(line) ? capital(line) : line}</text>)}
            </g>;
        })}
    </svg>;
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
