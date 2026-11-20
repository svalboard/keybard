// The apps running on the computer, from Keybard Host (GET /api/host/apps), for the
// app rules picker. Only asked when the Host is already in use (hostBaseInUse); a Host
// without the endpoint (404), no Host, or anything unexpected gives null: no picker.
import { hostBaseInUse } from './host';

export type HostPlatform = 'windows' | 'macos' | 'linux';
export interface HostApp { key: string; name: string }
export interface HostApps { platform: HostPlatform; foreground: HostApp | null; apps: HostApp[] }

let token = '';

const isApp = (v: unknown): v is HostApp =>
    !!v && typeof (v as HostApp).key === 'string' && (v as HostApp).key.trim() !== '' && typeof (v as HostApp).name === 'string';

/** The reply checked and cleaned; null if it isn't one. */
export function parseHostApps(data: unknown): HostApps | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (d.platform !== 'windows' && d.platform !== 'macos' && d.platform !== 'linux') return null;
    if (!Array.isArray(d.apps)) return null;
    const seen = new Set<string>();
    const apps: HostApp[] = [];
    for (const a of d.apps) {
        if (!isApp(a) || seen.has(a.key)) continue;
        seen.add(a.key);
        apps.push({ key: a.key, name: a.name || a.key });
    }
    apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { platform: d.platform, foreground: isApp(d.foreground) ? { key: d.foreground.key, name: d.foreground.name } : null, apps };
}

async function bootstrap(base: string): Promise<boolean> {
    const r = await fetch(`${base}/api/host/bootstrap`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const data = await r.json();
    if (data.apiVersion !== 1 || typeof data.token !== 'string') return false;
    token = data.token;
    return true;
}

export async function fetchHostApps(): Promise<HostApps | null> {
    const base = hostBaseInUse();
    if (base === null) return null;
    try {
        if (!token && !await bootstrap(base)) return null;
        const get = () => fetch(`${base}/api/host/apps`, { cache: 'no-store', headers: { 'X-Keybard-Token': token }, signal: AbortSignal.timeout(2000) });
        let r = await get();
        // A restarted Host has a new token.
        if (r.status === 403 && await bootstrap(base)) r = await get();
        if (!r.ok) return null;
        return parseHostApps(await r.json());
    } catch {
        return null;
    }
}

/** Test hook: forget the cached token. */
export function resetHostAppsForTests(): void { token = ''; }
