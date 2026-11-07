import { useEffect, useMemo, useRef, useState } from 'react';
import { OverlaySurface, type SurfaceKey } from './OverlaySurface';
import { useHost } from './host';
import { surfaceKeys } from './useSurfaceKeys';
import type { Appearance } from './core';
import { adaptKeys, keyPad, type Backdrop } from './adaptiveContrast';
import './trainer.css';
import { PointingOverlayLayer } from './PointingOverlayLayer';
export default function HostOverlay() {
    const { state } = useHost({ overlay: true });
    const [changed, setChanged] = useState<Set<number>>(new Set());
    const previous = useRef<SurfaceKey[]>([]);
    const keys = useMemo(() => {
        if (!state?.valid || !state.board) return [];
        try { return surfaceKeys(state.board, state.active, state.default ?? state.config.manualDefault, state.config.hands, state.config.layoutId, state.modifiers, { shifted: state.config.shiftedLegends, altgr: state.config.altgrLegends }); }
        catch { return []; }
    }, [state?.board, state?.valid, state?.active, state?.default, state?.config.manualDefault, state?.config.hands, state?.config.layoutId, state?.config.shiftedLegends, state?.config.altgrLegends, state?.modifiers?.shift, state?.modifiers?.capsLock]);
    useEffect(() => {
        document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent';
        document.body.style.margin = '0'; document.body.style.overflow = 'hidden';
    }, []);
    // Adaptive contrast: the Host sends what's under the overlay; restyle each key for the background around it.
    const adaptive = state?.config.adaptiveContrast === true;
    const appearance = state?.config.appearance;
    const [keyAppearance, setKeyAppearance] = useState<Map<number, Appearance>>();
    const darkLegend = useRef(new Map<number, boolean>());
    const lastBackdrop = useRef<Backdrop | null>(null);
    const keyAppearanceRef = useRef<Map<number, Appearance> | undefined>(undefined);
    keyAppearanceRef.current = keyAppearance;
    const labels = useRef(new Map<number, string>());
    labels.current = new Map(keys.map(k => [k.id, k.label]));
    useEffect(() => {
        if (!adaptive || !appearance) { setKeyAppearance(undefined); darkLegend.current.clear(); lastBackdrop.current = null; return; }
        const apply = (backdrop: Backdrop | null) => {
            lastBackdrop.current = backdrop;
            if (!backdrop) { setKeyAppearance(undefined); return; }
            const svg = document.querySelector('.trainer-native-surface svg') as SVGSVGElement | null;
            const viewBox = svg?.viewBox?.baseVal, box = svg?.getBoundingClientRect();
            const unitsToPixels = viewBox && box && viewBox.width ? Math.min(box.width / viewBox.width, box.height / viewBox.height) : 1;
            const pad = keyPad(appearance.width, unitsToPixels, innerWidth / backdrop.cols);
            const keyRects = [...document.querySelectorAll<SVGGElement>('.trainer-native-surface [data-key-id]')]
                .map(g => ({ id: Number(g.dataset.keyId), rect: g.querySelector('rect')?.getBoundingClientRect() }))
                .filter((k): k is { id: number; rect: DOMRect } => !!k.rect);
            const adapted = adaptKeys(backdrop, innerWidth, innerHeight, keyRects, appearance, darkLegend.current, pad);
            const next = new Map(keyAppearanceRef.current ?? []);
            for (const k of adapted) { darkLegend.current.set(k.id, k.dark); next.set(k.id, k.appearance); }
            // For tuning from DevTools: what each key read and chose.
            (window as unknown as { __adaptive?: unknown }).__adaptive = adapted.map(({ id, sample, busy, dark }) => ({ id, label: labels.current.get(id), ...sample, busy, dark }));
            setKeyAppearance(next);
        };
        const onBackdrop = (event: Event) => apply((event as CustomEvent<Backdrop | null>).detail);
        // A new appearance re-applies the last background at once instead of at the next sample.
        if (lastBackdrop.current) apply(lastBackdrop.current);
        window.addEventListener('keybard-host-backdrop', onBackdrop);
        return () => window.removeEventListener('keybard-host-backdrop', onBackdrop);
    }, [adaptive, appearance]);
    const bindingSignature = keys.map(k => `${k.id}:${k.code}:${k.layer}`).join(',');
    useEffect(() => {
        const before = new Map(previous.current.map(k => [k.id, `${k.code}:${k.layer}`]));
        setChanged(new Set(keys.filter(k => before.has(k.id) && before.get(k.id) !== `${k.code}:${k.layer}`).map(k => k.id)));
        previous.current = keys;
        const timer = setTimeout(() => setChanged(new Set()), state?.config.duration ?? 150);
        return () => clearTimeout(timer);
    }, [bindingSignature, state?.config.duration]);
    if (!state?.valid || !keys.length || !state.visible) return null;
    return <div className="trainer-native-surface"><OverlaySurface keys={keys} appearance={state.config.appearance}
        effect={state.config.effect} duration={state.config.duration} changed={changed}
        held={new Set(state.pressed)} hidden={new Set(state.practiceHidden)} target={state.practiceTarget ?? undefined}
        capitals={state.config.capitalAlphas === true} keyAppearance={keyAppearance} />
        <PointingOverlayLayer keys={keys} keymap={state.board?.keymap} config={state.config} pointing={(state.board as { pointing?: { left?: string; right?: string } } | null)?.pointing} look={(state as { pointingLook?: unknown }).pointingLook} /></div>;
}
