// Notes about a layout's settings after an import or a backup restore: settings a
// firmware release replaced (their values were carried over, so this is information,
// not a problem), and settings the connected firmware doesn't have at all.
import { PARANOID } from "@/lib/paranoid";
import { firmwareReleaseUrl, type SettingReplacement } from "@/services/settings-migrate";

const NOTE = "rounded-md border border-kb-gray-border bg-kb-surface p-2 text-sm text-kb-ink";

function ReleaseLink({ tag }: { tag: string }) {
    const url = firmwareReleaseUrl(tag);
    return (
        <p className="mt-1">
            Release details available at{" "}
            {PARANOID
                ? <code className="select-all break-all font-mono text-xs">{url}</code>
                : <a className="font-medium text-kb-primary underline break-all" href={url} target="_blank" rel="noreferrer">{url}</a>}
        </p>
    );
}

/** "The following settings in this layout have been replaced by:", one line per setting, then the release that did it. */
export function ReplacedSettingsNote({ replaced }: { replaced: SettingReplacement[] }) {
    if (!replaced.length) return null;
    const releases = [...new Set(replaced.flatMap((r) => (r.release ? [r.release] : [])))];
    return (
        <div className={NOTE} data-testid="settings-replaced">
            <p>The following settings in this layout have been replaced by:</p>
            <ul className="mt-1 list-disc pl-5">
                {replaced.map((r) => <li key={`${r.from}→${r.to}`}>{r.from} → {r.to}</li>)}
            </ul>
            {releases.map((tag) => <ReleaseLink key={tag} tag={tag} />)}
        </div>
    );
}

/** Settings with no counterpart on this firmware: one calm line, and their names under Details. */
export function UnavailableSettingsNote({ names, done }: { names: string[]; done: boolean }) {
    if (!names.length) return null;
    const one = names.length === 1;
    const line = one
        ? `One setting in this layout isn't available on this firmware, so it ${done ? "was" : "will be"} left unchanged.`
        : `A few settings in this layout aren't available on this firmware, so they ${done ? "were" : "will be"} left unchanged.`;
    return (
        <div className={NOTE} data-testid="settings-unavailable">
            <p>{line}</p>
            <details className="mt-1">
                <summary className="cursor-pointer text-xs font-medium">Details</summary>
                <ul className="mt-1 list-disc pl-5 text-xs">
                    {names.map((name) => <li key={name}>{name}</li>)}
                </ul>
            </details>
        </div>
    );
}

/** Both notes, as an import or restore reports them. */
export function ImportSettingsNotes({ replaced, unavailable, done }: { replaced?: SettingReplacement[]; unavailable?: string[]; done: boolean }) {
    return (
        <>
            <ReplacedSettingsNote replaced={replaced ?? []} />
            <UnavailableSettingsNote names={unavailable ?? []} done={done} />
        </>
    );
}
