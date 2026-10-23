// SIDE (0x33) on the mock board: each physical half's side, its source, its thumb strap,
// and what an update to the one image does to them. Speaks the real reply bytes
// (encodeSideGet), so the tests and the harness run the same codec as the keyboard.

import {
    CMD_SVIL_SIDE, SIDE_FLAG_RESTART, SideOp, SideSource, SideStatus, Strap, encodeSideGet, sideOf, strapSide,
    type SideValue, type SvalTransport,
} from "../side";
import { SvalSideHost } from "../side-host";
import type { HalfRole } from "../side-decision";
import type { FakeSvalboard } from "./fake-board";

export interface FakeSideHalf {
    side: SideValue;
    source: number;
    /** Strap class: 0 none, 1 left, 4 right. */
    strap: number;
}

export interface FakeSidesOptions {
    /** The board runs the one image now (SIDE advertised). Default false: a per-hand build. */
    supported?: boolean;
    usb?: Partial<FakeSideHalf>;
    other?: Partial<FakeSideHalf>;
    /** What each half reports once it runs a newer build (after an update). Default: it keeps its side (migrated). */
    after?: { usb?: Partial<FakeSideHalf>; other?: Partial<FakeSideHalf> };
    /** The other half hasn't reported its side yet, for this many GETs. */
    pendingReads?: number;
    /** GET fails until the update (so Keybard doesn't know the sides before it). */
    unreadableBefore?: boolean;
}

const half = (h: Partial<FakeSideHalf> | undefined, fallback: SideValue): FakeSideHalf => ({ side: h?.side ?? fallback, source: h?.source ?? SideSource.NONE, strap: h?.strap ?? Strap.NONE });

export class FakeSides implements SvalTransport {
    readonly halves: Record<HalfRole, FakeSideHalf>;
    private supportedBefore: boolean;
    private startFw: number;
    private afterApplied = false;
    private pendingReads: number;
    /** Every SET and CLEAR, for assertions. */
    readonly writes: Array<{ role: HalfRole; side: SideValue; status: number }> = [];
    readonly host: SvalSideHost;

    constructor(private readonly board: FakeSvalboard, private readonly o: FakeSidesOptions = {}) {
        const usbSide: SideValue = board.usbHand === 0 ? "left" : "right";
        const otherSide: SideValue = board.usbHand === 0 ? "right" : "left";
        this.halves = { usb: half(o.usb, usbSide), other: half(o.other, otherSide) };
        this.supportedBefore = o.supported ?? false;
        this.startFw = board.halves[board.usbHand].cfg.fwVersion;
        this.pendingReads = o.pendingReads ?? 0;
        this.host = new SvalSideHost(this, async () => (this.supported() ? 0x40 : 0));
    }

    /** The half with USB runs a build newer than at the start: the one image. */
    private updated(): boolean {
        return this.board.halves[this.board.usbHand].cfg.fwVersion !== this.startFw;
    }

    private applyAfter() {
        if (this.afterApplied || !this.updated()) return;
        this.afterApplied = true;
        for (const role of ["usb", "other"] as HalfRole[]) {
            const was = this.halves[role];
            const next = this.o.after?.[role];
            // Default: a per-hand half adopts its side (migrated); a half already on the one image keeps it.
            this.halves[role] = {
                side: next?.side ?? was.side,
                source: next?.source ?? (next?.side === undefined && !this.supportedBefore && was.side !== "unknown" ? SideSource.MIGRATED : was.source),
                strap: next?.strap ?? was.strap,
            };
        }
    }

    supported(): boolean {
        return this.supportedBefore || this.updated();
    }

    private otherConnected(): boolean {
        return this.board.linkUp();
    }

    async sval(cmd: number, args: number[]): Promise<Uint8Array> {
        if (!this.board.connected()) throw new Error("USB device not connected");
        if (!this.board.answering()) throw new Error("USB Command Timeout");
        if (cmd !== CMD_SVIL_SIDE || !this.supported()) throw new Error("Svil protocol error: code 1");
        this.applyAfter();
        const op = args[0];
        if (this.o.unreadableBefore && !this.updated()) throw new Error("USB Command Timeout");
        if (op === SideOp.GET) {
            const u = this.halves.usb;
            const ot = this.halves.other;
            const connected = this.otherConnected();
            const reported = connected && this.pendingReads <= 0;
            if (this.pendingReads > 0) this.pendingReads--;
            const pair = !connected ? "ok" : !reported ? "pending" : u.side === "unknown" || ot.side === "unknown" ? "no-side" : u.side === ot.side ? "same" : "ok";
            return encodeSideGet({
                side: u.side, source: u.source, strap: u.strap, recordSide: u.side, recordSource: u.source,
                otherConnected: connected, otherReported: reported, otherSide: reported ? ot.side : "unknown", pair,
                inputBlocked: pair !== "ok" || u.side === "unknown",
            });
        }
        if (op === SideOp.SET || op === SideOp.CLEAR) {
            const role: HalfRole = args[1] === 1 ? "other" : "usb";
            const side = op === SideOp.SET ? sideOf(args[2]) : "unknown";
            const restart = ((op === SideOp.SET ? args[4] : args[2]) & SIDE_FLAG_RESTART) !== 0;
            const status = this.write(role, side, op === SideOp.SET ? args[3] : SideSource.NONE, restart);
            this.writes.push({ role, side, status });
            const out = new Uint8Array(32);
            out.set([CMD_SVIL_SIDE, op, status]);
            return out;
        }
        const out = new Uint8Array(32);
        out.set([CMD_SVIL_SIDE, op, SideStatus.INVALID]);
        return out;
    }

    private write(role: HalfRole, side: SideValue, source: number, restart: boolean): number {
        if (role === "other" && !this.otherConnected()) return SideStatus.OTHER_NOT_CONNECTED;
        const h = this.halves[role];
        const strap = strapSide(h.strap);
        if (strap && strap !== side) return SideStatus.STRAP_DISAGREES;
        // The new side takes effect at the next start; this mock applies it at once and restarts.
        this.halves[role] = { ...h, side, source: side === "unknown" ? SideSource.NONE : source };
        if (restart) this.board.restartForSide(role);
        return role === "other" ? SideStatus.OTHER_ACCEPTED : SideStatus.OK;
    }
}
