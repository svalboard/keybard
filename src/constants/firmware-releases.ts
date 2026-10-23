// The Svalboard firmware releases this Keybard build carries, pinned by hash.
//
// Each site carries its own copies of the files inside its deploy (update-flow 3.2):
// - production (keybard.svalboard.com): the newest full release (v<N>) and the one before it;
// - next (next.keybard.svalboard.com): the newest prerelease (x<N>) and the same v releases;
// - dev builds: everything listed here.
// Only releases whose firmware speaks updater protocol 4 (one confirmation for both halves,
// settings reset) and ship one pair UF2 for both halves (x4 on) are listed: an install through Keybard always ends on one of them.
// A release lands here by PR, with its SHA-256 pins (tech doc 3.4). The list is empty
// until the first protocol-4 release exists.

export type ReleaseKind = "v" | "x";
export type Site = "production" | "next" | "dev";

export interface ReleaseFilePin {
    /** File name under <base>/firmware/<tag>/: the pair UF2 (svalboard_sval_<tag>.uf2). */
    uf2: string;
    /** SHA-256 of the .uf2, lowercase hex. A carried file that misses it is refused. */
    sha256: string;
    size: number;
}

export interface FirmwareReleasePin {
    /** The release tag: v3, v3.1, x4 ... */
    tag: string;
    kind: ReleaseKind;
    fwVersion: number;
    updaterProtocol: number;
    /** Sval (configurator) protocol of the firmware, when known. */
    svalProtocol?: number;
    /**
     * The release's one file for both halves (x4 on): a pair UF2 of the one image
     * (svalboard/either). Copied onto either half it installs both; Keybard installs from it too.
     */
    file: ReleaseFilePin;
    notesUrl: string;
}

/** Releases pinned into this build. Empty until a protocol-4 release ships. */
export const CARRIED_RELEASES: FirmwareReleasePin[] = [];

/** The updater protocol a carried release must speak. */
export const CARRIED_UPDATER_PROTOCOL = 4;

const TAG = /^([vx])(\d+(?:\.\d+)*)$/;

/** "v3.1" -> { kind: "v", parts: [3, 1] }; null for any other tag. */
export function parseReleaseTag(tag: string): { kind: ReleaseKind; parts: number[] } | null {
    const m = TAG.exec(tag);
    return m ? { kind: m[1] as ReleaseKind, parts: m[2].split(".").map(Number) } : null;
}

const newestFirst = (a: FirmwareReleasePin, b: FirmwareReleasePin) => b.fwVersion - a.fwVersion;

/** Which site this build is, from its build mode and channel. */
export function currentSite(env: { MODE?: string; VITE_CHANNEL?: string; BASE_URL?: string } = import.meta.env): Site {
    if (env.VITE_CHANNEL === "next" || (env.BASE_URL ?? "").includes("keybard-test")) return "next";
    if (env.MODE === "svalboard" || env.MODE === "paranoid") return "production";
    return "dev";
}

/** The releases a site offers, newest first. */
export function releasesForSite(site: Site, releases: FirmwareReleasePin[] = CARRIED_RELEASES): FirmwareReleasePin[] {
    const usable = releases.filter((r) => r.updaterProtocol >= CARRIED_UPDATER_PROTOCOL && parseReleaseTag(r.tag)?.kind === r.kind);
    if (site === "dev") return [...usable].sort(newestFirst);
    const full = usable.filter((r) => r.kind === "v").sort(newestFirst).slice(0, 2);
    if (site === "production") return full;
    const pre = usable.filter((r) => r.kind === "x").sort(newestFirst).slice(0, 1);
    return [...pre, ...full].sort(newestFirst);
}

/** The carried release whose pinned .uf2 has this SHA-256. */
export function matchPin(sha256: string, releases: FirmwareReleasePin[] = CARRIED_RELEASES): { release: FirmwareReleasePin } | null {
    const want = sha256.toLowerCase();
    const release = releases.find((r) => r.file.sha256 === want);
    return release ? { release } : null;
}

/** Where a carried file is served: same origin, inside this deploy. */
export function carriedFileUrl(release: FirmwareReleasePin, name: string, base: string = import.meta.env.BASE_URL ?? "/"): string {
    return `${base.endsWith("/") ? base : `${base}/`}firmware/${release.tag}/${name}`;
}
