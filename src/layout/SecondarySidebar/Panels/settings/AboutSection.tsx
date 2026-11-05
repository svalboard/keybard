import React from "react";
import { MANUAL_URL } from "@/lib/manual";
import { PARANOID } from "@/lib/paranoid";
import { BUILD_SHA, RELEASE_TAG } from "@/utils/build-info";
import { currentSite, type Site } from "@/constants/firmware-releases";
import { useFirmwareUpdates } from "@/features/firmware/FirmwareUpdateProvider";
import { UnstableFirmwareText } from "@/features/firmware/UnstableFirmwareNotice";
import { releaseNotesUrl, releaseTable, SITES, sitesToRead, unstableFirmwareNotice, usingSentence, useSiteVersion } from "@/utils/site-versions";

/** The Svalboard community: a permanent Discord invite. */
export const COMMUNITY_URL = "https://svalboard.com/discord";

const linkClass = "underline underline-offset-2 hover:text-kb-ink";
// The small section label other Settings screens use (SectionLabel in features/firmware/parts.tsx).
const headClass = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";
// Under 25rem each row stacks: the release on its own line, then each value with its column name.
const stack = "@max-[25rem]:block";
const cell = `${stack} py-0.5 pr-3 align-baseline @max-[25rem]:py-0`;

/** A value's column name, shown only when the rows stack; screen readers have the table's own headers. */
function StackLabel({ children }: { children: string }) {
    return <span aria-hidden="true" data-stack-label="" className="mr-2 hidden font-normal text-muted-foreground @max-[25rem]:inline">{children}</span>;
}

/**
 * Keybard's own facts and links. One sentence says which Keybard this is, then
 * a table pairs each release (Stable: v, keybard.svalboard.com; Unstable: x,
 * next.keybard.svalboard.com) with its Keybard and firmware versions. This
 * site's values come from the build; the other site's from its version.json,
 * blank when not known. The current release's row is bold, its only marker. Paranoid reads nothing.
 */
const AboutSection: React.FC<{ tag?: string; sha?: string; paranoid?: boolean; buildSite?: Site; boardTag?: string | null }> = ({
    tag = RELEASE_TAG,
    sha = BUILD_SHA,
    paranoid = PARANOID,
    buildSite = currentSite(),
    boardTag,
}) => {
    const updates = useFirmwareUpdates();
    const board = boardTag !== undefined ? boardTag : updates?.board?.tag ?? null;
    const read = sitesToRead(tag, paranoid, buildSite);
    const production = useSiteVersion(read.includes("production") ? "production" : null);
    const next = useSiteVersion(read.includes("next") ? "next" : null);
    const rows = releaseTable({ tag, paranoid, buildSite, fetched: { production, next } });

    return (
        <div className="flex flex-col gap-2 px-3 py-2.5 text-sm" data-about="">
            <p className="text-kb-ink" data-about-using="">{usingSentence(tag, sha)}</p>
            {rows.length > 0 && (
                <div className="@container">
                    <table role="table" className="w-full border-collapse text-left" aria-label="Keybard releases" data-about-releases="">
                        <thead role="rowgroup" className="@max-[25rem]:sr-only">
                            <tr role="row">
                                <th scope="col" role="columnheader" className={`pb-1 pr-3 ${headClass}`}>Release</th>
                                <th scope="col" role="columnheader" className={`pb-1 pr-3 ${headClass}`}>Keybard</th>
                                <th scope="col" role="columnheader" className={`pb-1 pr-3 ${headClass}`}>Firmware</th>
                                <th scope="col" role="columnheader" className={`pb-1 ${headClass}`}>Site</th>
                            </tr>
                        </thead>
                        <tbody role="rowgroup" className={stack}>
                            {rows.map((r) => (
                                <tr
                                    role="row"
                                    key={r.site}
                                    data-release={r.release}
                                    data-current={r.current ? "" : undefined}
                                    className={`${stack} text-kb-ink @max-[25rem]:mb-2 @max-[25rem]:last:mb-0 ${r.current ? "font-semibold" : ""}`}
                                >
                                    <th scope="row" role="rowheader" className={`${stack} py-0.5 pr-3 align-baseline @max-[25rem]:py-0 ${r.current ? "font-semibold" : "font-normal"}`}>{r.release}</th>
                                    <td role="cell" className={cell}><StackLabel>Keybard</StackLabel><span className="font-mono">{r.keybard ?? ""}</span></td>
                                    <td role="cell" className={cell}><StackLabel>Firmware</StackLabel><span className="font-mono">{r.firmware ?? ""}</span></td>
                                    <td role="cell" className={`${cell} pr-0`}>
                                        <StackLabel>Site</StackLabel>
                                        <a href={SITES[r.site].url} target="_blank" rel="noopener" className={`${linkClass} whitespace-nowrap`}>{SITES[r.site].host}</a>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {unstableFirmwareNotice(board, buildSite) && (
                <p className="text-kb-ink" data-testid="about-unstable-firmware"><UnstableFirmwareText boardTag={board} buildSite={buildSite} /></p>
            )}
            <p className="flex flex-row flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                <a href={MANUAL_URL} target="_blank" rel="noopener" className={linkClass}>Manual</a>
                <a href={releaseNotesUrl(tag)} target="_blank" rel="noopener" className={linkClass}>Release notes</a>
                <a href={COMMUNITY_URL} target="_blank" rel="noopener" className={linkClass}>Svalboard community</a>
            </p>
        </div>
    );
};

export default AboutSection;
