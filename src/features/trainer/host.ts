import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardInfo } from '@/types/keyboard.types';
import type { Preferences } from './core';
import { appStorage } from '@/utils/app-storage';
import { PARANOID } from '@/lib/paranoid';

// The Keybard Overlay app serves its own copy of Keybard and the host API on this port.
// Any other copy (keybard.svalboard.com) calls it directly on loopback, which
// the host allows for that origin. Probing loopback can show a browser
// permission prompt, so hosted pages only connect after the user asks to.
export const HOST_ORIGIN = (import.meta.env.VITE_KEYBARD_HOST_ORIGIN as string | undefined) || 'http://127.0.0.1:5178';
const REMOTE_KEY = 'keybard-host-remote';
const servedByHost = () => typeof document !== 'undefined' && document.documentElement.dataset.keybardHost === 'true';
function rememberedRemote() { try { return appStorage.getItem(REMOTE_KEY) === '1'; } catch { return false; } }
export interface HostConfig extends Preferences { highlightPressed: boolean; manualDefault: number; capitalAlphas?: boolean; adaptiveContrast?: boolean;
    /** Keybard's Settings > General > Shifted Key Symbols and AltGr Symbols, which Keybard sends (like layoutId). */
    shiftedLegends?: boolean; altgrLegends?: boolean }
export interface HostSnapshot {
    modifiers?: { shift: boolean; capsLock: boolean } | null;
    apiVersion: number; config: HostConfig; revision: number; layoutRevision: number;
    board: (KeyboardInfo & { trainerLabels: Record<string, string> }) | null;
    selectedDevice: string | null; status: string; devices: { id: string; name: string; serial: string }[];
    active: number; default: number | null; valid: boolean; pressed: number[];
    practiceHidden: number[]; practiceTarget: number | null;
    matrixAvailable: boolean | null; visible: boolean; session: string;
}
/** The host's release and the Keybard it bundles. Hosts before vLaunch2 don't report them: 'unknown'. */
export interface HostBuild { version: string; keybardCommit: string | null }
declare global { interface Window { __keybardNativeState?: boolean } }
/**
 * The Keybard Overlay's state and commands. overlay: this page draws the overlay (?hostOverlay),
 * so its polls tell the Overlay app that the layer and held keys are on show and worth reading fast.
 */
export function useHost({ overlay = false }: { overlay?: boolean } = {}) {
    const [state, setState] = useState<HostSnapshot | null>(null);
    const [error, setError] = useState('');
    const token = useRef('');
    const current = useRef<HostSnapshot | null>(null);
    const [busy, setBusy] = useState(false);
    const [build, setBuild] = useState<HostBuild | null>(null);
    const busyRef = useRef(false);
    const local = servedByHost() || !!window.__keybardNativeState;
    const base = local ? '' : HOST_ORIGIN;
    // Keybard Paranoid only talks to the Keybard Overlay that serves it, never across origins.
    const [attempt, setAttempt] = useState(() => (local || (!PARANOID && rememberedRemote()) ? 1 : 0));
    const asked = useRef(false);
    /** Fetch the host's write token and build; false if it isn't a host this Keybard can use. */
    const bootstrap = useCallback(async (signal?: AbortSignal) => {
        const r = await fetch(`${base}/api/host/bootstrap`, { signal, cache: 'no-store' });
        if (!r.ok) throw new Error('The overlay app refused the connection');
        const data = await r.json();
        if (data.apiVersion !== 1) return false;
        token.current = data.token;
        setBuild({ version: typeof data.version === 'string' ? data.version : 'unknown', keybardCommit: typeof data.keybardCommit === 'string' ? data.keybardCommit : null });
        return true;
    }, [base]);
    /**
     * POST to the host. A restarted host has a new token and keeps serving state to this page, so
     * a 403 means the token is stale: fetch the current one and try once more.
     */
    const post = useCallback(async (path: string, body: () => unknown) => {
        const send = () => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Keybard-Token': token.current }, body: JSON.stringify(body()) });
        let r = await send();
        if (r.status === 403 && await bootstrap()) r = await send();
        const data = await r.json(); if (!r.ok) throw new Error(data.error);
        return data;
    }, [base, bootstrap]);
    useEffect(() => {
        if (!attempt) return;
        let alive = true, timer: ReturnType<typeof setTimeout>;
        const abort = new AbortController();
        let lastReceived = Date.now();
        const watchdog = setInterval(() => { if (current.current && Date.now() - lastReceived > 1200) { current.current = null; setState(null); setError('Connection to the overlay app is stale. The preview is paused.'); } }, 200);
        function receive(data: HostSnapshot) {
            if (!alive || data.apiVersion !== 1) return;
            lastReceived = Date.now();
            setError(''); // updates are arriving again
            if (current.current?.session !== data.session) current.current = null;
            if (current.current && data.revision < current.current.revision) { data.revision = current.current.revision; data.config = current.current.config; }
            if (data.layoutRevision === current.current?.layoutRevision && !data.board) data.board = current.current.board;
            current.current = data; setState(data);
        }
        const native = !!window.__keybardNativeState;
        const onState = (event: Event) => receive((event as CustomEvent<HostSnapshot>).detail);
        const onHeartbeat = () => { lastReceived = Date.now(); if (!current.current) void poll(); };
        if (native) {
            window.addEventListener('keybard-host-state', onState);
            window.addEventListener('keybard-host-heartbeat', onHeartbeat);
        }
        async function poll() {
            try {
                const r = await fetch(`${base}/api/host/state?layout=${current.current?.layoutRevision ?? -1}${overlay ? '&overlay=1' : ''}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1200)]), cache: 'no-store' });
                if (!r.ok) throw new Error('Connection to the overlay app lost');
                receive(await r.json() as HostSnapshot);
            } catch {
                if (alive) { current.current = null; setState(null); setError('Connection to the overlay app lost. The preview is paused.'); }
            }
            if (alive && !native) timer = setTimeout(poll, 80);
        }
        void (async () => {
            try {
                if (!await bootstrap(abort.signal) || !alive) return;
                if (!local) { try { appStorage.setItem(REMOTE_KEY, '1'); } catch { /* storage unavailable */ } }
                setError(''); void poll();
            } catch {
                // Browser-only Keybard has no host endpoint; only report it when the user asked to connect.
                if (alive && asked.current) setError(`Could not reach the overlay app at ${HOST_ORIGIN}. Start Keybard Overlay, allow this site to access apps on your device if the browser asks, then try again.`);
            }
        })();
        return () => { alive = false; clearTimeout(timer); clearInterval(watchdog); abort.abort(); window.removeEventListener('keybard-host-state', onState); window.removeEventListener('keybard-host-heartbeat', onHeartbeat); };
    }, [attempt, base, local, bootstrap, overlay]);
    /** Connect a hosted Keybard page to a running Keybard Overlay (user-initiated). */
    const connect = useCallback(() => { if (PARANOID) return; asked.current = true; setError(''); setAttempt(n => n + 1); }, []);
    const command = useCallback(async (value: Record<string, unknown>) => {
        try {
            await post('/api/host/command', () => value); setError('');
        } catch (e) { setError(e instanceof Error ? e.message : 'The overlay app could not do that'); }
    }, [post]);
    const configure = useCallback(async (config: HostConfig | ((latest: HostConfig) => HostConfig)) => {
        if (!current.current || busyRef.current) return false;
        busyRef.current = true; setBusy(true);
        try {
            // The config and revision are read at send time: a retry after a host restart uses the new
            // host's, and a change made meanwhile (overlay menu, resize grip) isn't overwritten.
            let sent = typeof config === 'function' ? config(current.current.config) : config;
            const data = await post('/api/host/config', () => {
                if (typeof config === 'function' && current.current) sent = config(current.current.config);
                return { config: sent, revision: current.current?.revision ?? 0 };
            });
            if (!current.current) return false;
            current.current = { ...current.current, config: sent, revision: data.revision };
            setState(current.current); setError(''); return true;
        } catch (e) { setError(e instanceof Error ? e.message : 'Could not save host settings'); return false; }
        finally { busyRef.current = false; setBusy(false); }
    }, [post]);
    return { state, error, command, configure, busy, connect, local, build };
}

const HOST_REFRESH_DELAY_MS = 500;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshToken = '';
// Hosts before the refresh command only know reload, which blanks the overlay while it reads.
let refreshOp: 'refresh' | 'reload' = 'refresh';

/**
 * Tell Keybard Overlay the board's layout changed, so its overlay re-reads it. Called once a batch
 * of writes has reached the board; a burst of edits gives one re-read (about 0.6 s of USB reads).
 * Only where the host is already in use: Keybard served by it, or a hosted page the user
 * connected to it from the Overlay page. Never probes loopback otherwise.
 */
export function notifyHostLayoutChanged(): void {
    const local = servedByHost() || (typeof window !== 'undefined' && !!window.__keybardNativeState);
    if (!local && (PARANOID || !rememberedRemote())) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void sendHostRefresh(local ? '' : HOST_ORIGIN); }, HOST_REFRESH_DELAY_MS);
}

async function sendHostRefresh(base: string, retried = false): Promise<void> {
    try {
        if (!refreshToken) {
            const r = await fetch(`${base}/api/host/bootstrap`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
            if (!r.ok) return;
            const data = await r.json();
            if (data.apiVersion !== 1) return;
            refreshToken = data.token;
        }
        const r = await fetch(`${base}/api/host/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Keybard-Token': refreshToken },
            body: JSON.stringify({ op: refreshOp }), signal: AbortSignal.timeout(1500),
        });
        // A restarted host has a new token; an older one doesn't know refresh.
        if (r.status === 403 && !retried) { refreshToken = ''; return sendHostRefresh(base, true); }
        if (r.status === 400 && refreshOp === 'refresh') { refreshOp = 'reload'; return sendHostRefresh(base, retried); }
    } catch { /* Host not running: nothing to update. */ }
}

/** Test hook: forget the cached token and host version. */
export function resetHostRefreshForTests(): void {
    clearTimeout(refreshTimer);
    refreshToken = '';
    refreshOp = 'refresh';
}
