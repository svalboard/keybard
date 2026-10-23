// The install flow: one confirm, then hands off (update-flow 5, protocol contract 2.8).
//
// The state lives outside the connection, in sessionStorage, so the dialog survives the
// keyboard's restart and a reload. Every screen is a pure function of this state.
//
// Rules this file enforces:
// - The chord is asked for at most once per update. A pair update asks for it at the
//   other half's pair ARM; the half with USB then installs on the held approval. If the
//   approval isn't there, the flow stops on F9 ("Halves differ") instead of asking again.
// - Every install backs up first (Wipe to a blank board needs none); the layout choice is
//   acted on with no prompt.
// - A pair update whose other half doesn't come back stops before the half with USB, so
//   one working half keeps its old release.
// - 0x2A (clear the reset notice) is sent last, after the restore or the defaults.

import { UpdaterClient, UpdaterStatusError } from "./client";
import type { Plan, Target } from "./checks";
import {
    ARM_MODE_PAIR, ARM_MODE_SINGLE, CHUNK_PIECE_MAX, HAND_SELF, Presence, RelayPhase, SETTINGS_RESET_BLANK, SETTINGS_RESET_BOTH, State, Status,
    handName, hex, otherHand, statusName, type Hand,
} from "./protocol";
import { manualOwnsResetNotice } from "./manual";
import { loadSvup, type SvupFile } from "./svup";
import { isUf2, loadFirmwareFile } from "./uf2";
import { SideSource, SideStatus, type Side, type SideValue } from "../side";
import {
    assessSides, currentSides, sidesSettling, explainSideStatus, planAfterUpdate, type HalfRole, type KnownSides,
    type SideAssessment, type SideWrite,
} from "../side-decision";
import type { SideHost } from "../side-host";
import { DisconnectedError, ReplyTimeoutError, type Clock, type UpdaterTransport } from "./transport";

/** The layout choice before an install: Keep my layout, Reset to the default layout, Wipe to a blank board. */
export type Afterwards = "restore" | "defaults" | "blank";

export type Stage =
    | "waiting" | "approve" | "preparing" | "sending" | "checking" | "copying" | "installing" | "restarting"
    | "reconnecting" | "checking-halves" | "checking-sides" | "restoring" | "done" | "stopped";

export type Step =
    | "start" | "approve" | "other-erase" | "other-send" | "other-verify" | "relay" | "other-install" | "other-restart"
    | "self-arm" | "self-erase" | "self-send" | "self-verify" | "self-install" | "reconnect" | "sides" | "check-halves"
    | "settings-reset" | "restore" | "done" | "failed";

export type FailureId = "F2" | "F3" | "F4" | "F5" | "F6" | "F9" | "F10" | "F11" | "F12" | "F14" | "F16" | "F17" | "F18" | "F19" | "F20" | "F21" | "F22" | "F23";

export interface Failure {
    id: FailureId;
    /** Which half a manual install is for (F10, F11). */
    hand?: Hand;
    /** What each half runs now, when known (F5, F9). */
    tags?: Partial<Record<Hand, string>>;
    detail?: string;
}

export interface RowState {
    hand: Hand;
    usb: boolean;
    stage: Stage;
    /** 0..1, or null for an indeterminate bar. */
    progress: number | null;
    fromTag: string;
    toTag: string;
}

export interface FlowFileRef {
    hand: Hand;
    name: string;
    sha256: string;
    tag: string;
    fwVersion: number;
}

export interface FlowResult {
    tags: Partial<Record<Hand, string>>;
    layout: "restored" | "defaults" | "blank";
    /** Lines the import preflight trimmed, e.g. "Combos: 6 of 8 (this firmware has 6)". */
    trimmed: string[];
    /** One-image firmware: each half's side after the update (absent on per-hand builds). */
    sides?: SidesResult | null;
}

export interface SidesResult {
    usb: SideValue | null;
    other: SideValue | null;
    /** Halves Keybard set (put back, or as the customer said). */
    wrote: HalfRole[];
    /** The halves took their sides from the per-hand build they ran. */
    migrated: boolean;
}

/** The flow waits for the customer: which half is plugged into the computer? Or: are these sides right? */
export interface SideAsk {
    /** confirm: the firmware chose the sides; "That's right" or "Swap". */
    reason: "unknown" | "same" | "confirm";
    /** Keybard knew the plugged-in half's side before: "Keep the plugged-in half as the left half?". */
    restore?: boolean;
    /** confirm: where the sides came from (the per-hand build, or the thumb PCBA). */
    from?: "migrated" | "strap" | null;
    /** The side to offer first, when Keybard can tell. */
    suggested: Side | null;
    /** The sides each half reports now. */
    usb: SideValue | null;
    other: SideValue | null;
    /** Why the last write didn't take (e.g. the thumb strap), in plain words. */
    note: string | null;
}

export interface FlowState {
    version: 1;
    id: string;
    phase: "running" | "result" | "failed" | "cancelled";
    target: Target;
    usbHand: Hand;
    title: string;
    toTag: string;
    fromTag: string;
    /** The version the half with USB ran before (absent in states saved before it was kept). */
    fromFw?: number;
    files: Partial<Record<Hand, FlowFileRef>>;
    afterwards: Afterwards;
    backup: { snapshotId?: string; fileName: string } | null;
    /** The board installs without the chord (INFO flags bit7). */
    noChord: boolean;
    step: Step;
    stepAt: number;
    /** When the approval step began (for the 30 s countdown). */
    approveAt: number | null;
    rows: RowState[];
    /** COMMIT accepted: the point of no return for that half. */
    committed: Hand[];
    halvesDone: Hand[];
    /** Times the user was asked for the chord in this update. Never more than 1. */
    approvalsAsked: number;
    settingsResetSent: boolean;
    sent2A: boolean;
    startedAt: number;
    finishedAt: number | null;
    result: FlowResult | null;
    failure: Failure | null;
    /** WebHID round trips and stage times, for update-technical.md 1.9. */
    measurements: Record<string, number>;
    /** One-image firmware: each half's side as read before the install. */
    sidesBefore?: KnownSides | null;
    /** sidesBefore came from SIDE (true) or from a per-hand build's updater hand (false). */
    sidesFromSide?: boolean;
    /** Set while the flow waits for the customer to say which half is which. */
    sideAsk?: SideAsk | null;
}

/** What the flow needs from the app (or the mock): the connection, the layout, backups. */
export interface FlowHost {
    clock: Clock;
    /** The open connection, or null. */
    transport(): UpdaterTransport | null;
    /** Wait for the keyboard to come back after a restart and reopen it (same product ID: no chooser). */
    waitForDevice(timeoutMs: number): Promise<UpdaterTransport | null>;
    /** Sval GET_INFO storage flags of the connection (bit 1 writes failing, bit 2 reset by a new build). */
    readStorageFlags(): Promise<number>;
    /** 0x2A: the reset notice was acted on. */
    clearStorageReset(): Promise<void>;
    /** Put the backup back through the import path; returns what the preflight trimmed. */
    restoreLayout(svil: string): Promise<{ trimmed: string[] }>;
    /** After a blank wipe (D44): every key on every layer reads KC_NO once the layout has loaded. */
    keymapBlank?(): Promise<boolean>;
    /** Hold a Web Lock and a Screen Wake Lock for the update; returns their release. */
    holdLocks?(): Promise<() => void>;
    /** SIDE (0x33): each half's side on the one-image firmware. Absent: never checked. */
    sides?: SideHost;
}

export interface FlowStore {
    load(): { state: FlowState; files: Partial<Record<Hand, Uint8Array>>; backupSvil: string | null } | null;
    save(state: FlowState): void;
    saveFiles(files: Partial<Record<Hand, Uint8Array>>, backupSvil: string | null): void;
    clear(): void;
}

const KEY = "keybard:firmware-update";

/** Sent on window when this tab's saved update changes, or the flow clears the reset notice. */
export const FLOW_STATE_EVENT = "keybard:firmware-update-state";

/** Tell listeners (the reset dialog) that this tab's update or manual install changed. */
export function announceFlowState() {
    try { if (typeof window !== "undefined") window.dispatchEvent(new Event(FLOW_STATE_EVENT)); } catch { /* nothing listens */ }
}

function toB64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function fromB64(text: string): Uint8Array {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

/** The flow state in sessionStorage: per tab, survives a reload, gone with the tab. */
export function sessionFlowStore(storage: Storage | null = typeof sessionStorage === "undefined" ? null : sessionStorage): FlowStore {
    const get = (k: string) => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
    const set = (k: string, v: string) => { try { storage?.setItem(k, v); } catch (e) { console.warn("[firmware] couldn't save the update state", e); } };
    const del = (k: string) => { try { storage?.removeItem(k); } catch { /* nothing to do */ } };
    return {
        load() {
            const raw = get(KEY);
            if (!raw) return null;
            try {
                const state = JSON.parse(raw) as FlowState;
                const filesRaw = JSON.parse(get(`${KEY}:files`) ?? "{}") as Partial<Record<Hand | "both", string>>;
                const files: Partial<Record<Hand, Uint8Array>> = {};
                // One file for both halves (a pair UF2) is stored once.
                if (filesRaw.both) { const b = fromB64(filesRaw.both); files[0] = b; files[1] = b; }
                for (const h of [0, 1] as Hand[]) if (filesRaw[h]) files[h] = fromB64(filesRaw[h]!);
                return { state, files, backupSvil: get(`${KEY}:backup`) };
            } catch { return null; }
        },
        save(state) {
            const before = get(KEY);
            set(KEY, JSON.stringify(state));
            // Only a change of update or phase matters to listeners, not each progress step.
            let prev: Pick<FlowState, "id" | "phase"> | null = null;
            try { prev = before ? JSON.parse(before) as FlowState : null; } catch { prev = null; }
            if (prev?.id !== state.id || prev?.phase !== state.phase) announceFlowState();
        },
        saveFiles(files, backupSvil) {
            const raw: Partial<Record<Hand | "both", string>> = {};
            // The backup first: it's small, and a full storage must not cost the restore.
            if (backupSvil !== null) set(`${KEY}:backup`, backupSvil);
            if (files[0] && files[0] === files[1]) raw.both = toB64(files[0]);
            else for (const h of [0, 1] as Hand[]) if (files[h]) raw[h] = toB64(files[h]!);
            set(`${KEY}:files`, JSON.stringify(raw));
        },
        clear() { del(KEY); del(`${KEY}:files`); del(`${KEY}:backup`); announceFlowState(); },
    };
}

/** Whether this tab has an update in flight. */
export function updateInFlight(store: FlowStore = sessionFlowStore()): boolean {
    const saved = store.load();
    return !!saved && saved.state.phase === "running";
}

/**
 * Whether this tab's update owns the board's reset notice: while it runs, and while its
 * dialog shows the result or the failure. The flow acts on the notice itself (the restore,
 * the defaults or the wipe, then 0x2A), so the reset dialog must not ask as well.
 */
export function updateOwnsResetNotice(storage: Storage | null = typeof sessionStorage === "undefined" ? null : sessionStorage): boolean {
    // A manual install open in this tab acts on the notice too, once the keyboard is back.
    if (manualOwnsResetNotice(storage)) return true;
    let raw: string | null = null;
    try { raw = storage?.getItem(KEY) ?? null; } catch { return false; }
    if (!raw) return false;
    try {
        const phase = (JSON.parse(raw) as FlowState).phase;
        return phase === "running" || phase === "result" || phase === "failed";
    } catch { return false; }
}

let clearedSession: { session: unknown } | null = null;

/** The update sent 0x2A on this connection: the layout loaded before it still shows the notice. */
export function noteResetNoticeCleared(session: unknown): void {
    clearedSession = { session };
    announceFlowState();
}

/** Whether an update cleared the reset notice on this connection. */
export function resetNoticeClearedOn(session: unknown): boolean {
    return !!clearedSession && clearedSession.session === session;
}

export function memoryFlowStore(): FlowStore & { snapshot: string | null } {
    let state: string | null = null;
    let files: Partial<Record<Hand, Uint8Array>> = {};
    let backup: string | null = null;
    return {
        get snapshot() { return state; },
        load() { return state ? { state: JSON.parse(state) as FlowState, files, backupSvil: backup } : null; },
        save(s) { state = JSON.stringify(s); },
        saveFiles(f, b) { files = f; if (b !== null) backup = b; },
        clear() { state = null; files = {}; backup = null; },
    };
}

/** The user cancelled before the first install. */
class Cancelled extends Error {}

/** Stops the flow with a failure screen. */
class Stop extends Error {
    constructor(readonly failure: Failure) {
        super(failure.id);
    }
}

/** Development builds log the flow's steps, so a hardware run shows where it went. */
const TRACE = !!import.meta.env?.DEV && import.meta.env?.MODE !== "test";
function trace(...args: unknown[]) {
    if (TRACE) console.info("[firmware]", ...args);
}

const POLL_MS = 250;
const CHORD_WAIT_MS = 35_000;
const RECONNECT_MS = 30_000;
/**
 * The other half answering after its restart, presence MATCH after the half with USB is
 * back, and a SIDE write's restart. On the mule the other half restarts in about 5 s and
 * presence matches about 6 s after the reconnect: this is more than twice the worst of those.
 */
const PRESENCE_MS = 20_000;
/**
 * From the op that restarts the half with USB (COMMIT, SETTINGS_RESET) to its USB going
 * away. After COMMIT the half writes the image first (its USB stays enumerated, silent,
 * while it does), so this is longer than the reboot itself.
 */
const RESTART_GONE_MS = 20_000;
/** How long the half with USB may take to answer with the new version after its COMMIT. */
const CONFIRM_MS = 60_000;

interface RestartWatch {
    seen(): boolean;
    stop(): void;
}

export interface StartInput {
    plan: Plan;
    afterwards: Afterwards;
    backup: { snapshotId?: string; fileName: string; svil: string } | null;
}

export class UpdateFlow {
    state: FlowState;
    private files: Partial<Record<Hand, SvupFile>> = {};
    private backupSvil: string | null = null;
    private listeners = new Set<(s: FlowState) => void>();
    private client: UpdaterClient | null = null;
    private running = false;
    private cancelRequested = false;

    /** Whether Cancel is still offered: until the first install starts. */
    get cancellable(): boolean {
        return this.state.phase === "running" && this.state.committed.length === 0 && !this.cancelRequested;
    }

    /** Stop before the first install; the board is told to ABORT. */
    cancel(): void {
        if (this.cancellable) this.cancelRequested = true;
    }

    private checkCancel() {
        if (this.cancelRequested && this.state.committed.length === 0) throw new Cancelled();
    }

    private constructor(private host: FlowHost, private store: FlowStore, state: FlowState) {
        this.state = state;
    }

    /** A new update from the sheet's plan. Nothing is sent until run(). */
    static create(host: FlowHost, store: FlowStore, input: StartInput): UpdateFlow {
        const { plan } = input;
        const usbHand = plan.board.usb.hand as Hand;
        const halves: Hand[] = plan.target === "both" ? [otherHand(usbHand), usbHand] : [plan.target];
        const files: Partial<Record<Hand, FlowFileRef>> = {};
        for (const h of halves) {
            const f = plan.files[h]!;
            files[h] = { hand: h, name: `svalboard_${f.manifest.tag || "firmware"}.uf2`, sha256: f.sha256, tag: f.manifest.tag, fwVersion: f.manifest.fwVersion };
        }
        // INFO page 1 (the tag) is this half's only; name the other half by its build when it differs.
        const other = plan.board.other;
        const otherTag = other && other.fwVersion !== plan.board.usb.fwVersion ? `build ${other.fwVersion}` : plan.fromTag;
        const now = host.clock.now();
        const state: FlowState = {
            version: 1,
            id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            phase: "running",
            target: plan.target,
            usbHand,
            title: plan.title,
            toTag: plan.toTag,
            fromTag: plan.fromTag,
            fromFw: plan.board.usb.fwVersion,
            files,
            // No backup: the layout can't be kept. A blank board needs none.
            afterwards: input.backup || input.afterwards === "blank" ? input.afterwards : "defaults",
            backup: input.backup ? { snapshotId: input.backup.snapshotId, fileName: input.backup.fileName } : null,
            noChord: plan.board.noChord,
            step: "start",
            stepAt: now,
            approveAt: null,
            rows: halves.map((h) => ({ hand: h, usb: h === usbHand, stage: "waiting", progress: 0, fromTag: h === usbHand ? plan.fromTag : otherTag, toTag: files[h]!.tag })),
            committed: [],
            halvesDone: [],
            approvalsAsked: 0,
            settingsResetSent: false,
            sent2A: false,
            startedAt: now,
            finishedAt: null,
            result: null,
            failure: null,
            measurements: {},
            sidesBefore: plan.sidesBefore ?? null,
            sidesFromSide: plan.sidesFromSide ?? true,
            sideAsk: null,
        };
        const flow = new UpdateFlow(host, store, state);
        flow.files = plan.files;
        flow.backupSvil = input.backup?.svil ?? null;
        const bytes: Partial<Record<Hand, Uint8Array>> = {};
        for (const h of halves) bytes[h] = plan.files[h]!.bytes;
        store.saveFiles(bytes, flow.backupSvil);
        store.save(state);
        return flow;
    }

    /** The update this tab had in flight before a reload, if any. */
    static async restore(host: FlowHost, store: FlowStore): Promise<UpdateFlow | null> {
        const saved = store.load();
        if (!saved) return null;
        const flow = new UpdateFlow(host, store, saved.state);
        // The file as it was chosen (a pair UF2), or the svup form the tests use.
        for (const h of [0, 1] as Hand[]) if (saved.files[h]) flow.files[h] = await (isUf2(saved.files[h]!) ? loadFirmwareFile(saved.files[h]!) : loadSvup(saved.files[h]!));
        flow.backupSvil = saved.backupSvil;
        return flow;
    }

    subscribe(listener: (s: FlowState) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private update(patch: Partial<FlowState>) {
        if (patch.step && patch.step !== this.state.step) trace(`step ${patch.step}`);
        if (patch.phase && patch.phase !== this.state.phase) trace(`phase ${patch.phase}`, patch.failure ?? patch.result ?? "");
        this.state = { ...this.state, ...patch };
        this.store.save(this.state);
        for (const l of [...this.listeners]) l(this.state);
    }

    private row(hand: Hand, patch: Partial<RowState>) {
        this.update({ rows: this.state.rows.map((r) => (r.hand === hand ? { ...r, ...patch } : r)) });
    }

    private step(step: Step) {
        this.checkCancel();
        this.update({ step, stepAt: this.host.clock.now() });
    }

    /** Forget the update (after Done, Close, or a failure the user dismissed). */
    dismiss() {
        this.store.clear();
    }

    private now() {
        return this.host.clock.now();
    }

    private connection(): UpdaterClient {
        const t = this.host.transport();
        if (!t || !t.connected()) throw new DisconnectedError();
        if (!this.client || this.client.transport !== t) {
            const previous = this.client;
            this.client = new UpdaterClient(t);
            if (previous?.tracking != null) this.client.track(previous.tracking, this.state.usbHand);
        }
        return this.client;
    }

    // ---- run ----------------------------------------------------------------------------------

    /**
     * Run from wherever the state is. A fresh flow installs; a restored one resumes
     * after the restart, or reports that it didn't finish (F6).
     */
    async run(): Promise<FlowState> {
        if (this.running) return this.state;
        this.running = true;
        const release = await this.host.holdLocks?.().catch(() => undefined);
        try {
            if (this.state.phase !== "running") return this.state;
            trace(this.state.step === "start" ? "start" : `resume at ${this.state.step}`, { target: this.state.target, afterwards: this.state.afterwards, toTag: this.state.toTag });
            if (this.state.step === "start") await this.install();
            else await this.resume();
            await this.after();
        } catch (error) {
            if (error instanceof Cancelled) {
                await this.abortQuietly();
                this.update({ phase: "cancelled", step: "failed", finishedAt: this.now() });
                this.store.clear();
                return this.state;
            }
            const failure = error instanceof Stop ? error.failure : this.unexpected(error);
            trace(`stopped at ${this.state.step}`, failure);
            await this.abortQuietly();
            this.update({ phase: "failed", step: "failed", failure, finishedAt: this.now(), rows: this.state.rows.map((r) => (r.stage === "done" ? r : { ...r, stage: "stopped", progress: null })) });
        } finally {
            release?.();
            this.running = false;
        }
        return this.state;
    }

    private unexpected(error: unknown): Failure {
        console.warn("[firmware] update stopped", error);
        const o = otherHand(this.state.usbHand);
        if (this.state.committed.includes(o) && !this.state.committed.includes(this.state.usbHand)) return this.halvesDiffer();
        // After the half with USB took COMMIT, Keybard can't say nothing was changed.
        if (this.state.committed.includes(this.state.usbHand)) return { id: "F23" };
        if (error instanceof UpdaterStatusError && (error.status === Status.OTHER_CLIENT || error.status === Status.BUSY)) return { id: "F3" };
        if (error instanceof UpdaterStatusError && error.status === Status.NOT_CONFIRMED) return { id: "F4" };
        if (error instanceof UpdaterStatusError && error.status === Status.UNAVAILABLE && this.state.target === "both") return { id: "F5", tags: this.fromTags(), detail: "The other half stopped answering." };
        return { id: "F5", tags: this.fromTags(), detail: error instanceof Error ? error.message : String(error) };
    }

    private fromTags(): Partial<Record<Hand, string>> {
        const out: Partial<Record<Hand, string>> = {};
        for (const r of this.state.rows) out[r.hand] = r.fromTag;
        return out;
    }

    private halvesDiffer(): Failure {
        const tags = this.fromTags();
        for (const h of this.state.committed) tags[h] = this.state.files[h]?.tag;
        return { id: "F9", tags };
    }

    private async abortQuietly() {
        const c = this.client;
        if (!c || c.tracking === null || this.state.committed.includes(this.state.usbHand)) return;
        try {
            const t = this.host.transport();
            if (t?.connected()) await c.abort(this.sessionHand ?? this.state.usbHand, c.tracking ?? 0);
        } catch { /* the board may be gone; its own timeout clears it */ }
    }

    private sessionHand: Hand | null = null;

    private async install() {
        const { target, usbHand } = this.state;
        const oHand = otherHand(usbHand);
        if (target === "both" || target === oHand) await this.installOther(target === "both");
        if (target === "both" || target === usbHand) await this.installUsb(target === "both");
    }

    /** Poll STATUS until `until` holds; an ERROR latched on the board ends the poll. */
    private async poll<T extends { state: number; lastError: number }>(read: () => Promise<T>, until: (s: T) => boolean, timeoutMs: number, onTick?: (s: T) => void): Promise<T> {
        const deadline = this.now() + timeoutMs;
        for (;;) {
            const s = await read();
            onTick?.(s);
            if (s.state === State.ERROR) throw new UpdaterStatusError("STATUS", s.lastError, s.state);
            if (until(s)) return s;
            this.checkCancel();
            if (this.now() >= deadline) throw new UpdaterStatusError("STATUS", Status.TIMEOUT, s.state);
            await this.host.clock.sleep(POLL_MS);
        }
    }

    private async waitForChord(c: UpdaterClient, hand: Hand) {
        this.update({ approvalsAsked: this.state.approvalsAsked + 1, approveAt: this.now() });
        this.step("approve");
        for (const r of this.state.rows) this.row(r.hand, { stage: "approve", progress: null });
        try {
            await this.poll(() => c.status(hand), (s) => s.chordMade, CHORD_WAIT_MS);
        } catch (error) {
            if (error instanceof UpdaterStatusError && (error.status === Status.NOT_CONFIRMED || error.status === Status.TIMEOUT)) throw new Stop({ id: "F4" });
            throw error;
        }
        for (const r of this.state.rows) this.row(r.hand, { stage: "waiting", progress: 0 });
    }

    /** BEGIN, erase, CHUNKs, END, verify and the CRC check, for one session. */
    private async transfer(c: UpdaterClient, hand: Hand, nonce: number, file: SvupFile, steps: { erase: Step; send: Step; verify: Step }) {
        this.step(steps.erase);
        this.row(hand, { stage: "preparing", progress: 0 });
        await c.begin(hand, nonce);
        await this.poll(() => c.status(hand), (s) => s.state === State.RECEIVING, 120_000, (s) => {
            if (s.sectorsToErase) this.row(hand, { progress: s.sectorsErased / s.sectorsToErase });
        });
        this.step(steps.send);
        const t0 = this.now();
        const image = file.image;
        let off = 0;
        let lastShown = -1;
        this.row(hand, { stage: "sending", progress: 0 });
        while (off < image.length) {
            const n = Math.min(CHUNK_PIECE_MAX, image.length - off);
            const { status, next } = await c.chunk(hand, off, image.subarray(off, off + n));
            if (status === Status.OK) off = next;
            else if (status === Status.OUT_OF_ORDER && next <= image.length) off = next;
            else throw new UpdaterStatusError("CHUNK", status);
            this.checkCancel();
            const pct = Math.floor((off / image.length) * 100);
            if (pct !== lastShown) { lastShown = pct; this.row(hand, { progress: off / image.length }); }
        }
        this.update({ measurements: { ...this.state.measurements, [`send_${handName(hand)}_ms`]: this.now() - t0 } });
        this.step(steps.verify);
        this.row(hand, { stage: "checking", progress: null });
        await c.end(hand, nonce);
        const s = await this.poll(() => c.status(hand), (st) => st.state === State.VERIFIED, 60_000);
        if (s.crcLo16 !== (file.crcBody & 0xffff)) throw new Stop({ id: "F5", tags: this.fromTags(), detail: "The keyboard's copy doesn't match the file." });
    }

    private checkArmHash(got: Uint8Array, file: SvupFile) {
        if (hex(got) !== hex(file.manifestSha512.subarray(0, 4))) throw new Stop({ id: "F5", tags: this.fromTags(), detail: "The keyboard received a different manifest." });
    }

    private async installOther(pair: boolean) {
        const usbHand = this.state.usbHand;
        const o = otherHand(usbHand);
        const c = this.connection();
        const fileO = this.files[o]!;
        this.sessionHand = o;
        await c.loadManifest(o, fileO.manifestBytes);
        if (pair) await c.loadManifest(usbHand, this.files[usbHand]!.manifestBytes, true);
        const arm = await c.arm(o, pair ? ARM_MODE_PAIR : ARM_MODE_SINGLE);
        this.checkArmHash(arm.manifestHash, fileO);
        if (pair) this.checkArmHash(arm.pairHash, this.files[usbHand]!);
        if (!arm.preApproved) await this.waitForChord(c, o);
        await this.transfer(c, o, arm.nonce, fileO, { erase: "other-erase", send: "other-send", verify: "other-verify" });

        // COMMIT #1: the copy over the split cable.
        this.step("relay");
        this.row(o, { stage: "copying", progress: 0 });
        await c.commit(o, arm.nonce, fileO.crcBody & 0xffff);
        const t0 = this.now();
        await this.poll(async () => { const r = await c.relay(o); return { ...r, lastError: r.error }; }, (r) => r.state === State.RELAYED, 180_000, (r) => {
            if (r.phase === RelayPhase.PAGES && r.imageLen) this.row(o, { progress: r.acked / r.imageLen });
        });
        this.update({ measurements: { ...this.state.measurements, relay_ms: this.now() - t0 } });

        // COMMIT #2: the other half installs. From here it runs the new release. A COMMIT
        // whose reply went missing may have been taken: it counts as sent, and STATUS says.
        await this.commitSent(() => c.commit(o, arm.nonce, fileO.crcBody & 0xffff));
        this.update({ committed: [...this.state.committed, o] });
        this.step("other-install");
        this.row(o, { stage: "installing", progress: null });
        if (pair) c.track(arm.nonce, usbHand); // keep REBINDing the held approval
        else c.untrack();
        await this.poll(() => c.status(usbHand), (s) => s.state === State.IDLE, 30_000);
        this.step("other-restart");
        this.row(o, { stage: "restarting", progress: null });
        const answered = await this.waitOtherAnswers(c, o);
        this.row(o, { stage: answered ? "done" : "restarting", progress: answered ? 1 : null });
        this.update({ halvesDone: answered ? [...this.state.halvesDone, o] : this.state.halvesDone });
        this.sessionHand = null;
        if (pair && !answered) {
            // Stop before the half with USB: it keeps its old release and keeps working, and
            // the halves-differ guidance says what to do next (Finish update).
            const u = handName(usbHand);
            throw new Stop({ ...this.halvesDiffer(), detail: `The ${handName(o)} half didn't answer after its install, so Keybard stopped before the ${u} half. The ${u} half still runs ${this.state.fromTag} and works.` });
        }
        if (!pair) {
            if (!answered) throw new Stop({ id: "F11", hand: o });
            // A one-half update of the other half: no restart of the half with USB.
            this.step("check-halves");
        }
    }

    private async waitOtherAnswers(c: UpdaterClient, o: Hand): Promise<boolean> {
        const deadline = this.now() + PRESENCE_MS;
        while (this.now() < deadline) {
            const info = await c.info(o).catch(() => null);
            if (info?.answered) return true;
            await this.host.clock.sleep(500);
        }
        return false;
    }

    private async installUsb(pair: boolean) {
        const usbHand = this.state.usbHand;
        const c = this.connection();
        const file = this.files[usbHand]!;
        this.step("self-arm");
        this.sessionHand = usbHand;
        if (pair) {
            // The held approval must be there: otherwise stop, never ask for the chord again.
            const st = await c.status(usbHand);
            if (!st.approvalHeld) throw new Stop(this.halvesDiffer());
        }
        await c.loadManifest(usbHand, file.manifestBytes);
        const arm = await c.arm(usbHand, ARM_MODE_SINGLE);
        this.checkArmHash(arm.manifestHash, file);
        if (!arm.preApproved) {
            if (pair || this.state.approvalsAsked > 0) throw new Stop(this.halvesDiffer());
            await this.waitForChord(c, usbHand);
        }
        await this.transfer(c, usbHand, arm.nonce, file, { erase: "self-erase", send: "self-send", verify: "self-verify" });
        // Watch from before COMMIT: the half writes the image, then restarts, and only that
        // restart says the old firmware is gone.
        const watch = this.watchRestart();
        try {
            // The half writes the image 100 ms after its reply, with USB silent: a reply that
            // doesn't arrive is a COMMIT it may well have taken, never "nothing was changed".
            await this.commitSent(() => c.commit(usbHand, arm.nonce, file.crcBody & 0xffff));
        } catch (error) {
            watch.stop();
            throw error;
        }
        c.untrack();
        this.sessionHand = null;
        this.update({ committed: [...this.state.committed, usbHand] });
        this.step("self-install");
        this.row(usbHand, { stage: "installing", progress: null });
        this.usbRestartSeen = await this.reconnect(watch);
    }

    /**
     * Send a COMMIT. A refusal (a status) throws: the board said no, nothing was installed.
     * No reply, or the board gone, returns: it may have taken it, and what follows checks.
     */
    private async commitSent(send: () => Promise<unknown>): Promise<void> {
        try {
            await send();
        } catch (error) {
            if (!(error instanceof ReplyTimeoutError || error instanceof DisconnectedError)) throw error;
            trace("no reply to COMMIT: checking whether the half took it", error);
        }
    }

    /** This page saw the half with USB restart after its COMMIT. */
    private usbRestartSeen = false;

    /**
     * Watch for the half with USB going away, from just before the op that restarts it: a
     * restart is known only when it's seen, never assumed from time passing.
     */
    private watchRestart(): RestartWatch {
        const t = this.host.transport();
        let gone = !t || !t.connected();
        const off = t?.onDisconnect(() => { gone = true; }) ?? (() => undefined);
        return { seen: () => gone || !this.host.transport()?.connected(), stop: off };
    }

    /**
     * Wait for the half with USB to restart and come back. With a watch from before the op,
     * waits for the restart itself (up to RESTART_GONE_MS); returns whether it was seen. A
     * connection still open then is the old one: the caller checks what it runs.
     */
    private async reconnect(watch?: RestartWatch): Promise<boolean> {
        const usbHand = this.state.usbHand;
        this.step("reconnect");
        this.row(usbHand, { stage: "restarting", progress: null });
        const w = watch ?? this.watchRestart();
        const gone = this.now() + (watch ? RESTART_GONE_MS : 5000);
        while (!w.seen() && this.now() < gone) await this.host.clock.sleep(POLL_MS);
        const restarted = w.seen();
        w.stop();
        trace(restarted ? "the keyboard went away" : "the keyboard is still on its old connection");
        const t0 = this.now();
        trace("waiting for the keyboard to come back");
        const t = await this.host.waitForDevice(RECONNECT_MS);
        trace(t ? `keyboard back after ${this.now() - t0} ms` : "keyboard didn't come back");
        if (!t) throw new Stop({ id: "F14", hand: usbHand });
        this.update({ measurements: { ...this.state.measurements, reconnect_ms: this.now() - t0 } });
        this.row(usbHand, { stage: "reconnecting", progress: null });
        this.client = new UpdaterClient(t);
        return restarted;
    }

    /**
     * After the half with USB took COMMIT: wait until it has installed the file. Installed
     * means it answers with the file's version after its restart: the restart was seen, or
     * its session is back to IDLE (a COMMIT it took leaves it COMMITTING until the restart),
     * or the version changed. A reinstall of the version it ran is no different: the same
     * version before the restart proves nothing, the same version after it is success.
     * "Nothing was changed" (F5) only when the board says it refused: its session latched an
     * error before any restart. Anything else waits, up to CONFIRM_MS, and then Keybard says
     * it couldn't confirm the update (F23).
     */
    private async confirmUsbVersion(want: FlowFileRef, restarted: boolean): Promise<void> {
        const deadline = this.now() + CONFIRM_MS;
        let watch: RestartWatch | null = restarted ? null : this.watchRestart();
        try {
            for (;;) {
                if (watch?.seen()) {
                    watch.stop();
                    watch = null;
                    restarted = true;
                    await this.reconnect();
                }
                const c = this.host.transport()?.connected() ? this.connection() : null;
                const info = c ? await c.info(HAND_SELF).catch(() => null) : null;
                if (info && !watch?.seen()) {
                    const versionChanged = this.state.fromFw !== undefined && want.fwVersion !== this.state.fromFw;
                    const installed = info.fwVersion === want.fwVersion && (restarted || versionChanged || info.state === State.IDLE);
                    trace(`the half with USB answers fw ${info.fwVersion} in state ${info.state} (restart seen: ${restarted}, installed: ${installed})`);
                    if (installed) return;
                    if (!restarted && info.state === State.ERROR) {
                        // The board refused the COMMIT when it came to write (or its session ended): it runs what it ran.
                        const tag = await c!.info1().then((p) => p.tag).catch(() => undefined);
                        throw new Stop({ id: "F5", tags: tag ? ({ [this.state.usbHand]: tag } as Partial<Record<Hand, string>>) : this.fromTags() });
                    }
                }
                if (this.now() >= deadline) throw new Stop({ id: "F23" });
                await this.host.clock.sleep(500);
            }
        } finally {
            watch?.stop();
        }
    }

    /** After a reload: pick up after the restart, or say the update didn't finish. */
    private async resume() {
        const { step, usbHand, target } = this.state;
        const after: Step[] = ["self-install", "reconnect", "sides", "check-halves", "settings-reset", "restore"];
        if (this.state.committed.includes(usbHand) || (target !== "both" && target !== usbHand && this.state.committed.length)) {
            if (step === "self-install" || step === "reconnect") {
                const t = this.host.transport();
                if (!t?.connected()) await this.reconnect();
            }
            return;
        }
        if (after.includes(step)) return;
        // Mid-install when the tab went away: the board's session timed out by itself.
        if (this.state.committed.length) throw new Stop({ ...this.halvesDiffer(), id: "F9" });
        throw new Stop({ id: "F6", tags: this.fromTags() });
    }

    // ---- sides (one-image firmware) -------------------------------------------------------------

    private answer: ((writes: SideWrite[]) => void) | null = null;
    private sidesResult: SidesResult | null = null;

    /** The customer's answer to "Which half is plugged into your computer?", as the SETs it takes. */
    answerSide(writes: SideWrite[]): void {
        const resolve = this.answer;
        this.answer = null;
        resolve?.(writes);
    }

    /** GET until the other half has reported: the split link is up only a while after a restart. */
    private async readSides(sides: SideHost): Promise<SideAssessment> {
        const deadline = this.now() + PRESENCE_MS;
        for (;;) {
            const a = assessSides(true, await sides.read());
            if (!sidesSettling(a) || this.now() >= deadline) return a;
            await this.host.clock.sleep(POLL_MS);
        }
    }

    /** One SET; the half restarts. Returns the status. */
    private async writeSide(sides: SideHost, w: SideWrite): Promise<number> {
        trace(`side: set the ${w.role} half to ${w.side} (${w.why})`);
        // The half with USB restarts on its SET: watch from before it.
        const watch = w.role === "usb" ? this.watchRestart() : null;
        let status: number;
        try {
            status = await sides.write(w.role, w.side);
        } catch (error) {
            watch?.stop();
            throw error;
        }
        if (status !== SideStatus.OK && status !== SideStatus.OTHER_ACCEPTED) { watch?.stop(); return status; }
        if (watch) {
            await this.reconnect(watch);
            this.step("sides");
        } else {
            // The other half saves it from its main loop and restarts: wait for it to report the new side.
            const deadline = this.now() + PRESENCE_MS;
            await this.host.clock.sleep(500);
            while (this.now() < deadline) {
                const r = await sides.read();
                if (r?.otherConnected && r.otherReported && r.otherSide === w.side) break;
                await this.host.clock.sleep(500);
            }
        }
        return status;
    }

    /**
     * After the install, on one-image firmware: read both sides. Keybard never writes a side
     * by itself. A half that came back unknown or changed, or two halves on one side: it asks
     * which half is plugged in, the likely answer first. Sides the firmware chose (from the
     * per-hand build or the thumb PCBA) are shown once: "That's right" or "Swap".
     */
    private async checkSides(): Promise<void> {
        const sides = this.host.sides;
        if (!sides || !(await sides.supported().catch(() => false))) return;
        this.step("sides");
        for (const r of this.state.rows) this.row(r.hand, { stage: "checking-sides", progress: null });
        const before: KnownSides = { ...(this.state.sidesBefore ?? { usb: null, other: null }) };
        const wrote = new Set<HalfRole>();
        let note: string | null = null;
        let restoreWording = true;
        // The firmware picked the sides in this update only when Keybard didn't know them from
        // SIDE before it: a per-hand build before (the sides migrate now), or sides that weren't
        // set or readable. Sides Keybard read before and finds again need no confirmation, even
        // when they came from the thumb PCBA.
        let firmwareChose = this.state.sidesFromSide === false || before.usb === null || before.other === null;
        /** The customer answered once: the firmware's choice needs no second confirmation. */
        let answered = false;
        let migrated = false;
        for (let round = 0; round < 5; round++) {
            const a = await this.readSides(sides);
            const report = await sides.read();
            const fromStrap = report?.source === SideSource.STRAP;
            const plan = planAfterUpdate(before, a, { firmwareChose: !answered && firmwareChose });
            migrated ||= plan.migrated || (firmwareChose && a.kind === "ok");
            if (plan.action === "none") {
                const done = currentSides(a);
                this.update({ sidesBefore: before, sideAsk: null });
                this.sidesResult = { usb: done.usb, other: done.other, wrote: [...wrote], migrated };
                return;
            }
            const now = currentSides(a);
            const ask: SideAsk = {
                reason: plan.action === "confirm" ? "confirm" : a.kind === "same" ? "same" : "unknown",
                suggested: plan.likelyUsb,
                restore: plan.restore && restoreWording,
                from: plan.action === "confirm" ? (fromStrap ? "strap" : "migrated") : null,
                ...now,
                note,
            };
            const writes = await new Promise<SideWrite[]>((resolve) => {
                this.answer = resolve;
                this.update({ sideAsk: ask });
            });
            this.update({ sideAsk: null });
            note = null;
            answered = true;
            if (!writes.length) {
                // "That's right": the customer confirmed the sides as they are.
                const done = currentSides(a);
                for (const role of ["usb", "other"] as HalfRole[]) {
                    const cur = done[role];
                    if (cur === "left" || cur === "right") before[role] = cur;
                }
                this.update({ sidesBefore: before, sideAsk: null });
                this.sidesResult = { usb: done.usb, other: done.other, wrote: [...wrote], migrated };
                return;
            }
            // What the customer said is now what Keybard knows.
            for (const role of ["usb", "other"] as HalfRole[]) {
                const w = writes.find((x) => x.role === role);
                const cur = now[role];
                before[role] = w ? w.side : cur === "left" || cur === "right" ? cur : null;
            }
            firmwareChose = false;
            const strap = report?.strap;
            for (const w of writes) {
                const status = await this.writeSide(sides, w);
                if (status === SideStatus.OK || status === SideStatus.OTHER_ACCEPTED) { wrote.add(w.role); continue; }
                note = explainSideStatus(status, { role: w.role, wanted: w.side, strap: w.role === "usb" ? strap : undefined });
                restoreWording = false;
                // Never retry a refused side. The half keeps the side its thumb PCBA gives it,
                // so the likely answer for the plugged-in half follows from that.
                if (w.role === "usb") { before.usb = null; before.other = null; } else { before.usb = w.side; before.other = null; }
                break;
            }
        }
        throw new Stop({ id: "F22", detail: note ?? undefined });
    }

    /** Both halves' versions and presence, then the Afterwards choice, then 0x2A. */
    private async after() {
        // First what the half with USB runs: everything after reads the new firmware.
        const wantFirst = this.state.files[this.state.usbHand];
        if (wantFirst && this.state.committed.includes(this.state.usbHand)) await this.confirmUsbVersion(wantFirst, this.usbRestartSeen);
        await this.checkSides();
        const { usbHand, target } = this.state;
        const o = otherHand(usbHand);
        this.step("check-halves");
        let c = this.connection();
        const usbRow = this.state.rows.find((r) => r.usb);
        if (usbRow) this.row(usbHand, { stage: "checking-halves", progress: null });
        const info = await c.info(HAND_SELF);
        const tags: Partial<Record<Hand, string>> = {};
        const page1 = await c.info1();
        tags[usbHand] = page1.tag;
        const wantUsb = this.state.files[usbHand];
        // Confirmed above after this flow's COMMIT: a read that differs now is a half that changed again.
        if (wantUsb && (info.fwVersion !== wantUsb.fwVersion)) throw new Stop(this.state.committed.includes(usbHand) ? { id: "F23" } : { id: "F5", tags: { [usbHand]: page1.tag } as Partial<Record<Hand, string>> });
        // Presence MATCH within 10 s; the other half's version from its INFO.
        const deadline = this.now() + PRESENCE_MS;
        let presence = (await c.status(usbHand)).presence;
        while (presence !== Presence.MATCH && this.now() < deadline) {
            await this.host.clock.sleep(500);
            presence = (await c.status(usbHand)).presence;
        }
        const oInfo = await c.info(o).catch(() => null);
        if (!oInfo?.answered) {
            if (target === "both" || target === o) throw new Stop({ id: "F11", hand: o });
        }
        const wantO = this.state.files[o];
        tags[o] = wantO && oInfo?.fwVersion === wantO.fwVersion ? wantO.tag : oInfo?.fwVersion === info.fwVersion ? page1.tag : undefined;
        if (presence !== Presence.MATCH) {
            const differ = { ...tags };
            if (!differ[o]) differ[o] = this.state.rows.find((r) => r.hand === o)?.fromTag;
            throw new Stop({ id: "F9", tags: differ });
        }
        for (const r of this.state.rows) this.row(r.hand, { stage: r.usb ? "checking-halves" : "done", progress: r.usb ? null : 1 });
        this.update({ halvesDone: [...new Set([...this.state.halvesDone, ...this.state.rows.map((r) => r.hand)])] });

        // Afterwards, as chosen on the sheet, with no prompt.
        let flags = await this.host.readStorageFlags();
        trace(`storage flags 0x${flags.toString(16)}`, { tags });
        if (flags & 0x02) throw new Stop({ id: "F17" });
        let trimmed: string[] = [];
        // "Restore my layout" with the backup lost (a reload with storage full): never reset
        // instead. The pre-update snapshot and the downloaded file still hold the layout.
        if (this.state.afterwards === "restore" && !this.backupSvil) {
            throw new Stop({ id: "F16", detail: `This tab lost its copy of the backup. Restore ${this.state.backup?.fileName ?? "the pre-update backup"} from Backups.` });
        }
        if (this.state.afterwards === "restore" && this.backupSvil) {
            this.step("restore");
            this.row(usbHand, { stage: "restoring", progress: null });
            try {
                trimmed = (await this.host.restoreLayout(this.backupSvil)).trimmed;
            } catch (error) {
                throw new Stop({ id: "F16", detail: error instanceof Error ? error.message : String(error) });
            }
        } else if (this.state.afterwards === "blank") {
            // Wipe to a blank board (D44): always, whatever the install already reset.
            if (!this.state.settingsResetSent) {
                this.step("settings-reset");
                this.row(usbHand, { stage: "restarting", progress: null });
                const watch = this.watchRestart();
                const r = await c.settingsReset(usbHand, SETTINGS_RESET_BOTH, SETTINGS_RESET_BLANK).catch((e) => { watch.stop(); throw e; });
                trace(`SETTINGS_RESET blank: status ${r.status} done 0x${r.done.toString(16)}`);
                if (r.status !== Status.OK) {
                    watch.stop();
                    throw new Stop({ id: "F20", detail: `The new firmware is installed, but the keyboard wasn't wiped: ${settingsResetProblem(r.status, r.done, usbHand, "wipe to a blank board")}.` });
                }
                this.update({ settingsResetSent: true });
                await this.reconnect(watch);
                c = this.connection();
                flags = await this.host.readStorageFlags();
                trace(`storage flags after the wipe 0x${flags.toString(16)}`);
                if (!(flags & 0x04)) console.warn("[firmware] blank wipe, but the reset notice isn't set");
            }
            const blank = this.host.keymapBlank ? await this.host.keymapBlank() : true;
            trace(`keymap blank: ${blank}`);
            if (!blank) {
                // A half with USB on a build from before D44 ignores the mode and resets to defaults.
                throw new Stop({ id: "F20", detail: "The new firmware is installed, but the keyboard came back with keys still set. Its firmware may not wipe to a blank board." });
            }
        } else if (!this.state.settingsResetSent && (!(flags & 0x04) || target !== "both")) {
            // An identical build kept the old settings, or only one half was installed: reset both (F-N2).
            this.step("settings-reset");
            this.row(usbHand, { stage: "restarting", progress: null });
            const watch = this.watchRestart();
            const r = await c.settingsReset(usbHand, SETTINGS_RESET_BOTH).catch((e) => { watch.stop(); throw e; });
            trace(`SETTINGS_RESET defaults: status ${r.status} done 0x${r.done.toString(16)}`);
            if (r.status !== Status.OK) watch.stop();
            if (r.status !== Status.OK) throw new Stop({ id: "F21", detail: `The new firmware is installed, but the layout wasn't reset to the default layout: ${settingsResetProblem(r.status, r.done, usbHand, "reset its layout")}.` });
            this.update({ settingsResetSent: true });
            await this.reconnect(watch);
            c = this.connection();
            flags = await this.host.readStorageFlags();
            if (!(flags & 0x04)) console.warn("[firmware] settings reset, but the reset notice isn't set");
        }
        // Last: tell the board the reset was acted on.
        await this.host.clearStorageReset();
        trace("0x2A sent: reset notice cleared");
        this.update({ sent2A: true });
        for (const r of this.state.rows) this.row(r.hand, { stage: "done", progress: 1 });
        this.update({
            phase: "result",
            step: "done",
            finishedAt: this.now(),
            result: { tags, layout: this.state.afterwards === "blank" ? "blank" : this.state.afterwards === "restore" && this.backupSvil ? "restored" : "defaults", trimmed, sides: this.sidesResult },
        });
    }
}

/**
 * Why SETTINGS_RESET didn't happen, from its status and done mask (bit0 the half with USB,
 * bit1 the other half): INVALID, UNAVAILABLE, BUSY and FLASH_ERR each mean something else.
 */
export function settingsResetProblem(status: number, done: number, usbHand: Hand, what: string): string {
    switch (status) {
        case Status.INVALID: return "the keyboard refused the request";
        case Status.UNAVAILABLE: return `the other half didn't answer, or its firmware can't ${what}. Nothing was changed`;
        case Status.BUSY: return "the keyboard was busy. Nothing was changed";
        case Status.FLASH_ERR: {
            const took = [usbHand, otherHand(usbHand)].filter((_, i) => done & (1 << i)).map((h) => `the ${handName(h)} half`);
            const failed = [usbHand, otherHand(usbHand)].filter((_, i) => !(done & (1 << i))).map((h) => `the ${handName(h)} half`);
            return `${failed.join(" and ") || "a half"} couldn't save the reset${took.length ? `; ${took.join(" and ")} took it` : ""}`;
        }
        default: return `the keyboard answered ${statusName(status)}`;
    }
}

/** A disconnect or timeout, as opposed to a refusal: used by the UI to word F5. */
export const isConnectionLoss = (error: unknown) => error instanceof DisconnectedError || error instanceof ReplyTimeoutError;
