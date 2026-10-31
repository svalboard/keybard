import type { HostBuild } from './host';

/** The Keybard Overlay release this Keybard offers; a connected host on another release is told about it. */
export const HOST_RELEASE_TAG = 'v4.3.4';
export const HOST_RELEASE = `https://github.com/svalboard/keybard/releases/tag/${HOST_RELEASE_TAG}`;
/** The Windows ZIP's name in a release. Releases before the rename only have the old name. */
export const hostZipName = (tag: string) => /^(vLaunch|keybard-host-)/.test(tag) ? 'KeybardHost-Windows.zip' : 'KeybardOverlay-Windows.zip';
export const HOST_DOWNLOAD = HOST_RELEASE.replace('/tag/', '/download/') + '/' + hostZipName(HOST_RELEASE_TAG);

/** Which Keybard Overlay is connected, and a pointer to the current release when it's an older one. */
export function HostVersion({ build }: { build: HostBuild | null }) {
    if (!build) return null;
    const outdated = build.version !== 'dev' && build.version !== HOST_RELEASE_TAG;
    const name = build.version === 'unknown' ? 'an older Keybard Overlay' : `Keybard Overlay ${build.version}`;
    return <p className="text-xs text-muted-foreground">
        Connected to {name}{build.keybardCommit ? ` · Keybard ${build.keybardCommit}` : ''}.
        {outdated && <> Keybard Overlay {HOST_RELEASE_TAG} is available: <a className="underline" href={HOST_RELEASE} target="_blank" rel="noreferrer">download it</a>.</>}
    </p>;
}
