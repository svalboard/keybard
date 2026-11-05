/**
 * Each Keybard release is served by one public site: v releases by
 * keybard.svalboard.com, x releases by next.keybard.svalboard.com. Every release
 * deploy publishes version.json at its site's root ({"tag":"v4.3.6","firmware":"v4.3.5"}:
 * the Keybard release and the newest firmware it carries, which can differ), so
 * a page can show the other site's real versions. Nothing here guesses: a site
 * whose file cannot be read is shown with no version.
 */
import { useEffect, useState } from "react";
import { currentSite, firmwareName, keybardName, newestFirmwareFor, parseReleaseTag, releaseWord, siteForTag, type Site } from "@/constants/firmware-releases";

export { siteForTag };
export type PublicSite = "production" | "next";

export const SITES: Record<PublicSite, { host: string; url: string }> = {
    production: { host: "keybard.svalboard.com", url: "https://keybard.svalboard.com/" },
    next: { host: "next.keybard.svalboard.com", url: "https://next.keybard.svalboard.com/" },
};

export const VERSION_FILE = "version.json";
export const RELEASES_URL = "https://github.com/svalboard/keybard/releases";

/** A site's published versions. */
export interface SiteVersion {
    tag: string;
    /** The newest firmware release the site carries; null when the file names none. */
    firmware: string | null;
}

/** This release's notes when the build has a tag, else the releases list. */
export function releaseNotesUrl(tag: string): string {
    return parseReleaseTag(tag) ? `${RELEASES_URL}/tag/${tag}` : RELEASES_URL;
}

/**
 * A site's version.json, only if its tag is a release that site serves. Its
 * firmware must be one that site can carry: keybard.svalboard.com carries only
 * v firmware; next carries both.
 */
export function parseVersionFile(data: unknown, site: PublicSite): SiteVersion | null {
    const { tag, firmware } = (data ?? {}) as { tag?: unknown; firmware?: unknown };
    if (typeof tag !== "string" || siteForTag(tag) !== site) return null;
    const kind = typeof firmware === "string" ? parseReleaseTag(firmware)?.kind : undefined;
    const carried = kind === "v" || (kind === "x" && site === "next");
    return { tag, firmware: carried ? (firmware as string) : null };
}

/** Read a site's version.json. Any failure (network, 404, bad JSON, wrong kind) is null. */
export async function fetchSiteVersion(site: PublicSite, fetchImpl: typeof fetch = fetch): Promise<SiteVersion | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetchImpl(SITES[site].url + VERSION_FILE, { cache: "no-store", signal: controller.signal });
        if (!res.ok) return null;
        return parseVersionFile(await res.json(), site);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// One read per site per page load, shared by the About section and the banner.
const cache = new Map<PublicSite, Promise<SiteVersion | null>>();

export function siteVersion(site: PublicSite): Promise<SiteVersion | null> {
    let p = cache.get(site);
    if (!p) {
        p = fetchSiteVersion(site);
        cache.set(site, p);
        // A failed read is not remembered: the next one (About opened later) tries again.
        p.then((v) => { if (!v && cache.get(site) === p) cache.delete(site); });
    }
    return p;
}

/** For tests. */
export function resetSiteVersions(): void {
    cache.clear();
}

/** A site's fetched versions: null while reading and when they are not known. */
export function useSiteVersion(site: PublicSite | null): SiteVersion | null {
    const [version, setVersion] = useState<{ site: PublicSite; value: SiteVersion | null } | null>(null);
    useEffect(() => {
        if (!site) return;
        let live = true;
        siteVersion(site).then((value) => { if (live) setVersion({ site, value }); });
        return () => { live = false; };
    }, [site]);
    return site && version?.site === site ? version.value : null;
}

/**
 * The public site this build is: the one serving its tag, when the build was
 * made for that site. A build with no tag, or a release built for somewhere else
 * (Keybard Overlay builds x tags for production), is no public site.
 */
export function ownSite(tag: string, buildSite: Site = currentSite()): PublicSite | null {
    const site = siteForTag(tag);
    return site && site === buildSite ? site : null;
}

/** The sites this build reads version.json from: the other public site, or both when it is none. */
export function sitesToRead(tag: string, paranoid: boolean, buildSite: Site = currentSite()): PublicSite[] {
    if (paranoid) return [];
    const own = ownSite(tag, buildSite);
    return own === "production" ? ["next"] : own === "next" ? ["production"] : ["production", "next"];
}

export interface ReleaseRow {
    site: PublicSite;
    release: "Stable" | "Unstable";
    /** The Keybard release that site serves; null when it is not known. */
    keybard: string | null;
    /** The newest firmware that site carries; null when it is not known. */
    firmware: string | null;
    /** This build is that site's release. */
    current: boolean;
}

const RELEASE_OF: Record<PublicSite, "Stable" | "Unstable"> = { production: "Stable", next: "Unstable" };

/**
 * The About table: Stable, then Unstable, each its Keybard and firmware
 * version and site. This site's values come from the build; the other's from
 * its version.json. Unknown values are null, never guessed. Paranoid reads
 * nothing, so it lists only its own release.
 */
export function releaseTable(opts: {
    tag: string;
    fetched: Partial<Record<PublicSite, SiteVersion | null>>;
    paranoid?: boolean;
    buildSite?: Site;
}): ReleaseRow[] {
    const paranoid = !!opts.paranoid;
    const own = ownSite(opts.tag, opts.buildSite ?? currentSite());
    const sites: PublicSite[] = paranoid ? (own ? [own] : []) : ["production", "next"];
    return sites.map((site) => {
        if (site === own) return { site, release: RELEASE_OF[site], keybard: opts.tag, firmware: paranoid ? null : newestFirmwareFor(own), current: true };
        const v = opts.fetched[site];
        return { site, release: RELEASE_OF[site], keybard: v?.tag ?? null, firmware: v?.firmware ?? null, current: false };
    });
}

/** "You're using Unstable Keybard x4.4." or, untagged, "You're using a development build, commit 1a2b3c4." */
export function usingSentence(tag: string, sha: string): string {
    if (releaseWord(tag)) return `You're using ${keybardName(tag)}.`;
    return sha ? `You're using a development build, commit ${sha}.` : "You're using a development build.";
}

/**
 * The line for a keyboard on Unstable firmware while this is the Stable site;
 * null otherwise. The host is a link where it is shown.
 */
export function unstableFirmwareNotice(boardTag: string | null | undefined, buildSite: Site = currentSite()): { lead: string; host: string; url: string; tail: string } | null {
    if (buildSite !== "production" || !boardTag || siteForTag(boardTag) !== "next") return null;
    return {
        lead: `Your keyboard runs ${firmwareName(boardTag)}. Unstable Keybard at `,
        host: SITES.next.host,
        url: SITES.next.url,
        tail: " goes with it.",
    };
}
