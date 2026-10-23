// Sending the side fixes outside an update: from the Firmware page, the banner and the sheet.

import { SideStatus } from "@/services/side";
import type { SideHost } from "@/services/side-host";
import { explainSideStatus, type SideWrite } from "@/services/side-decision";
import type { Clock, UpdaterTransport } from "@/services/updater/transport";

export interface SideActionHost {
    sides?: SideHost;
    clock: Clock;
    /** Wait for the keyboard to come back after the half with USB restarts. */
    waitForDevice(timeoutMs: number): Promise<unknown>;
    /** The connection open now: Keybard waits for it to go away before waiting for the keyboard back. */
    transport?(): UpdaterTransport | null;
}

/**
 * Send the SETs in order (the other half first), waiting for each half to restart.
 * Returns null when every write took, or why one didn't, in plain words.
 */
export async function applySideWrites(host: SideActionHost, writes: SideWrite[]): Promise<string | null> {
    const sides = host.sides;
    if (!sides) return "This keyboard can't set its sides from Keybard.";
    const strap = (await sides.read())?.strap;
    for (const w of writes) {
        let status: number;
        // The half with USB restarts on its SET: watch from before it, so the old connection
        // is never taken for the keyboard being back.
        const t = w.role === "usb" ? host.transport?.() ?? null : null;
        let gone = !t;
        const off = t?.onDisconnect(() => { gone = true; }) ?? (() => undefined);
        try {
            status = await sides.write(w.role, w.side);
        } catch {
            off();
            return "The keyboard stopped answering. Reconnect it, then try again.";
        }
        if (status !== SideStatus.OK && status !== SideStatus.OTHER_ACCEPTED) {
            off();
            return explainSideStatus(status, { role: w.role, wanted: w.side, strap: w.role === "usb" ? strap : undefined });
        }
        if (w.role === "usb") {
            const until = host.clock.now() + 20_000;
            while (!gone && t?.connected() && host.clock.now() < until) await host.clock.sleep(250);
            off();
            await host.waitForDevice(30_000);
        } else {
            // The other half saves it and restarts; the split link is up again a few seconds later.
            const deadline = host.clock.now() + 20_000;
            await host.clock.sleep(500);
            while (host.clock.now() < deadline) {
                const r = await sides.read();
                if (r?.otherConnected && r.otherReported && r.otherSide === w.side) break;
                await host.clock.sleep(500);
            }
        }
    }
    return null;
}
