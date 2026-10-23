// The editor's firmware updates. In development and on the test site, `?fwfake=1` backs them
// with the mock board (the harness's), so Settings > Firmware can be tried and reviewed
// without a keyboard. The mock is a dynamic import behind a build-time check: production
// and Paranoid builds drop it.

import { lazy, Suspense, type ReactNode } from "react";

import { FirmwareUpdateProvider } from "./FirmwareUpdateProvider";

/** Development, or the test site's build (its own storage namespace, set by its deploy). */
const FAKE_BUILD = import.meta.env.DEV || import.meta.env.VITE_STORAGE_NAMESPACE === "keybard-test";
const DevFakeFirmware = FAKE_BUILD ? lazy(() => import("./harness/DevFakeFirmware")) : null;

function wantsFake(): boolean {
    if (!FAKE_BUILD || typeof location === "undefined") return false;
    return new URLSearchParams(location.search).has("fwfake");
}

export function AppFirmwareUpdates({ children }: { children: ReactNode }) {
    if (DevFakeFirmware && wantsFake()) {
        return (
            <Suspense fallback={children}>
                <DevFakeFirmware>{children}</DevFakeFirmware>
            </Suspense>
        );
    }
    return <FirmwareUpdateProvider>{children}</FirmwareUpdateProvider>;
}
