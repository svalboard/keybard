// The Svalboard firmware releases this Keybard build carries, pinned by hash.
//
// Each site carries its own copies of the files inside its deploy (update-flow 3.2):
// - production (keybard.svalboard.com): the newest full release (v<N>) and the one before it;
// - next (next.keybard.svalboard.com): the newest prerelease (x<N>) and the same v releases;
// - dev builds: everything listed here.
// Only releases whose firmware speaks updater protocol 4 (one confirmation for both halves,
// settings reset) and ship one pair UF2 for both halves (x4 on) are listed: an install through Keybard always ends on one of them.
// A release lands here by PR, with its SHA-256 pins (tech doc 3.4), and its file goes in
// public/firmware/<tag>/ so every deploy carries it.

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

/** Releases pinned into this build. */
export const CARRIED_RELEASES: FirmwareReleasePin[] = [
    {
        tag: "x4.5",
        kind: "x",
        fwVersion: 20,
        updaterProtocol: 4,
        svalProtocol: 3,
        file: {
            uf2: "svalboard_sval_x4.5.uf2",
            sha256: "d1ded7749bed1d54dd0b0f5ad117f8718dd08cbb615e55e74c388300aa951a4b",
            size: 344064,
        },
        notesUrl: "https://github.com/svalboard/qmk/releases/tag/x4.5",
    },
];

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

/** The public site that serves a Keybard release tag: v on production, x on next; null for others. */
export function siteForTag(tag: string): "production" | "next" | null {
    const kind = parseReleaseTag(tag)?.kind;
    return kind === "v" ? "production" : kind === "x" ? "next" : null;
}

/** The newest firmware release a site carries, or null when it carries none. */
export function newestFirmwareFor(site: Site, releases: FirmwareReleasePin[] = CARRIED_RELEASES): string | null {
    return releasesForSite(site, releases)[0]?.tag ?? null;
}

/**
 * What a release deploy publishes as version.json: its Keybard release tag and
 * the newest firmware it carries (omitted when it carries none). The Keybard and
 * firmware tags can differ: a Keybard-only release carries an older firmware.
 * Only a build of the site that serves the tag has one (an x tag built for
 * production, as Keybard Overlay does, has none).
 */
export function versionFile(tag: string, site: Site, releases: FirmwareReleasePin[] = CARRIED_RELEASES): { tag: string; firmware?: string } | null {
    if (site === "dev" || siteForTag(tag) !== site) return null;
    const firmware = newestFirmwareFor(site, releases);
    return firmware ? { tag, firmware } : { tag };
}

/**
 * The two releases, by tag kind: v is Stable, x is Unstable. Keybard names a
 * release version as "<Release> <thing> <version>" ("Stable firmware v4.3.5",
 * "Unstable Keybard x4.4"), never a bare v or x version.
 */
export function releaseWord(tag: string | null | undefined): "Stable" | "Unstable" | null {
    const kind = tag ? parseReleaseTag(tag)?.kind : undefined;
    return kind === "v" ? "Stable" : kind === "x" ? "Unstable" : null;
}

/** "Stable firmware v4.3.5"; any other label (an old vLaunch tag, "build 19") as it is. */
export function firmwareName(tag: string): string {
    const word = releaseWord(tag);
    return word ? `${word} firmware ${tag}` : tag;
}

/** "Unstable Keybard x4.4"; any other label as it is. */
export function keybardName(tag: string): string {
    const word = releaseWord(tag);
    return word ? `${word} Keybard ${tag}` : tag;
}

/** What a connected keyboard runs, as a sentence part: "Runs Unstable firmware x4.4", or "Firmware: <label>". */
export function runsFirmware(label: string): string {
    return releaseWord(label) ? `Runs ${firmwareName(label)}` : `Firmware: ${label}`;
}
