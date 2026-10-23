// Named side scenarios for the firmware harness and ?fwfake (development only):
//   &sides=ok            a one-image board, both sides known
//   &sides=migrate       a per-hand board; the update moves it to the one image (migrated)
//   &sides=same          both halves on the right side (the fix on the Firmware page)
//   &sides=unknown-other the half on the split cable has no side
//   &sides=unknown-usb   the half plugged in has no side
//   &sides=unknown-both  neither half has a side
//   &sides=strap-same    both right, and the plugged-in half's thumb cluster is a right one (status 4)
//   &sides=after-unknown per-hand board; after the update both halves come back unknown (put back)
//   &sides=ask           the sides weren't readable before; after the update neither has one (asks)
//   &sides=ask-same      the sides weren't readable before; after the update both are right (asks)
//   &sides=strap         after the update the other half claims right with a right thumb cluster (status 4, asks)

import { SideSource, Strap } from "../side";
import type { FakeSidesOptions } from "./fake-sides";

export function sidesScenario(name: string | null): FakeSidesOptions | undefined {
    switch (name) {
        case "ok": return { supported: true, usb: { source: SideSource.KEYBARD }, other: { source: SideSource.KEYBARD } };
        case "migrate": return { supported: false };
        case "same": return { supported: true, usb: { side: "right" }, other: { side: "right" } };
        case "unknown-other": return { supported: true, usb: { side: "right" }, other: { side: "unknown" } };
        case "unknown-usb": return { supported: true, usb: { side: "unknown" }, other: { side: "left" } };
        case "unknown-both": return { supported: true, usb: { side: "unknown" }, other: { side: "unknown" } };
        case "strap-same": return { supported: true, usb: { side: "right", strap: Strap.RIGHT, source: SideSource.STRAP }, other: { side: "right" } };
        case "after-unknown": return { supported: false, after: { usb: { side: "unknown" }, other: { side: "unknown" } } };
        case "ask": return { supported: true, unreadableBefore: true, after: { usb: { side: "unknown" }, other: { side: "unknown" } } };
        case "ask-same": return { supported: true, unreadableBefore: true, after: { usb: { side: "right" }, other: { side: "right" } } };
        case "strap": return { supported: false, after: { other: { side: "right", strap: Strap.RIGHT, source: SideSource.STRAP } } };
        default: return undefined;
    }
}
