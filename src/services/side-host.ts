// How the update flow and the board status reach SIDE (0x33): over Keybard's open
// connection (usb.service), or over the mock board (updater/fake-sides.ts).

import { SideClient, SideTarget, hasSideCommand, type Side, type SideReport, type SvalTransport } from "./side";
import type { HalfRole } from "./side-decision";
import { SvilUSB, usbInstance } from "./usb.service";

export interface SideHost {
    /** Whether the board answers SIDE now (GET_INFO byte 19 bit 6, read fresh: an update changes it). */
    supported(): Promise<boolean>;
    /** GET; null when the read fails. */
    read(): Promise<SideReport | null>;
    /** SET a half's side and restart it, so the side takes effect. Returns the status. */
    write(role: HalfRole, side: Side): Promise<number>;
}

/** SIDE over any Sval transport, with the feature byte read through `flags2`. */
export class SvalSideHost implements SideHost {
    private readonly client: SideClient;
    constructor(transport: SvalTransport, private readonly flags2: () => Promise<number>) {
        this.client = new SideClient(transport);
    }

    async supported(): Promise<boolean> {
        try {
            return hasSideCommand(await this.flags2());
        } catch {
            return false;
        }
    }

    async read(): Promise<SideReport | null> {
        try {
            return await this.client.get();
        } catch {
            return null;
        }
    }

    write(role: HalfRole, side: Side): Promise<number> {
        return this.client.set(role === "usb" ? SideTarget.THIS : SideTarget.OTHER, side, { restart: true });
    }
}

/** SIDE over the app's WebHID connection. */
export function usbSideHost(usb: SvilUSB = usbInstance): SideHost {
    const transport: SvalTransport = {
        sval: async (cmd, args) => (await usb.sendSvil(cmd, args, { uint8: true })) as Uint8Array,
    };
    // GET_INFO after the wrapper: [cmd echo][...]; firmware byte 19 is reply[18].
    const flags2 = async () => {
        if (!usb.isOpen()) return 0;
        const info = (await usb.sendSvil(SvilUSB.CMD_SVIL_GET_INFO, [], { uint8: true })) as Uint8Array;
        return info[18] ?? 0;
    };
    return new SvalSideHost(transport, flags2);
}
