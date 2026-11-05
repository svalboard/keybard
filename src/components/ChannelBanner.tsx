import React from "react";
import { firmwareName } from "@/constants/firmware-releases";
import { SITES, useSiteVersion } from "@/utils/site-versions";

export const STABLE_URL = SITES.production.url;

/**
 * Marks the unstable build (VITE_CHANNEL=next, see .env.next) so nobody
 * mistakes it for keybard.svalboard.com, and says how to get the stable version:
 * the firmware that site carries (from its version.json, when it has been read)
 * and the site itself. Other builds show nothing.
 */
const ChannelBanner: React.FC = () => {
    const onNext = import.meta.env.VITE_CHANNEL === "next";
    const version = useSiteVersion(onNext ? "production" : null);
    if (!onNext) return null;

    return (
        <div
            role="note"
            className="fixed top-1 left-1/2 -translate-x-1/2 z-50 w-max max-w-[calc(100vw-1rem)] rounded-2xl bg-kb-yellow px-3 py-0.5 text-center text-xs font-medium text-kb-sidebar-dark shadow"
        >
            This is the Unstable release and may break. For the Stable release,{" "}
            {version?.firmware ? `flash ${firmwareName(version.firmware)} and use` : "use"}{" "}
            <a href={STABLE_URL} className="underline underline-offset-2">{SITES.production.host}</a>.
        </div>
    );
};

export default ChannelBanner;
