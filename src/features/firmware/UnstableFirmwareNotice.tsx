import type { Site } from "@/constants/firmware-releases";
import { unstableFirmwareNotice } from "@/utils/site-versions";

/**
 * On the Stable site, a keyboard that runs Unstable firmware: the sentence
 * naming it and the Unstable Keybard that goes with it. Nothing otherwise.
 */
export function UnstableFirmwareText({ boardTag, buildSite }: { boardTag: string | null | undefined; buildSite?: Site }) {
    const n = unstableFirmwareNotice(boardTag, buildSite);
    if (!n) return null;
    return (
        <>
            {n.lead}
            <a href={n.url} target="_blank" rel="noopener" className="underline underline-offset-2">{n.host}</a>
            {n.tail}
        </>
    );
}

/** The same sentence as a notice, in the editor's notice card style. */
export function UnstableFirmwareNotice({ boardTag, buildSite }: { boardTag: string | null | undefined; buildSite?: Site }) {
    if (!unstableFirmwareNotice(boardTag, buildSite)) return null;
    return (
        <p role="status" data-testid="unstable-firmware-notice" className="whitespace-normal rounded-md border border-kb-gray-border bg-kb-surface p-3 text-sm text-kb-ink shadow-sm">
            <UnstableFirmwareText boardTag={boardTag} buildSite={buildSite} />
        </p>
    );
}
