// The flow host for the real app: the WebHID connection Keybard has open, reconnecting
// through KeyboardContext after the restart, the backup, and putting the layout back
// through the import path (preflight, then syncWithKeyboard), with no review dialog.

import { useBackups, serializeForBackup } from "@/contexts/BackupContext";
import { useChanges } from "@/contexts/ChangesContext";
import { listPermittedDevices, useKeyboard } from "@/contexts/KeyboardContext";
import { HOST_ORIGIN } from "@/features/trainer/host";
import { PARANOID } from "@/lib/paranoid";
import { getBackupService } from "@/services/backup/backup.service";
import { fileService } from "@/services/file.service";
import { SvilUSB, usbInstance } from "@/services/usb.service";
import type { CheckRow } from "@/services/updater/checks";
import { noteResetNoticeCleared } from "@/services/updater/flow";
import { realClock, type UpdaterTransport } from "@/services/updater/transport";
import { WebHidUpdaterTransport } from "@/services/updater/webhid-transport";
import { usbSideHost } from "@/services/side-host";
import type { KeyboardInfo } from "@/types/keyboard.types";
import { getKeyLabel } from "@/utils/layers";
import { restoreLayoutToBoard } from "./restore";
import type { FirmwareUiHost, UpdateBackup } from "./useFirmwareUpdate";

/** <board name>-<installed release>-<date>.svil */
export function backupFileName(boardName: string, now = new Date()): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Svalboard";
    const pad = (n: number) => String(n).padStart(2, "0");
    // Named by board and when it was saved: a layout file, not a firmware version.
    return `${safe(boardName)}-layout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.svil`;
}

/** Save text to Downloads with no file picker: the sheet says where it went. */
export function downloadText(text: string, name: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Hold a Web Lock (a second Keybard tab stays out) and a Screen Wake Lock. */
export async function holdUpdateLocks(): Promise<() => void> {
    let releaseLock: (() => void) | null = null;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks) {
        await new Promise<void>((acquired) => {
            void locks.request("keybard-firmware-update", { ifAvailable: true }, (lock) => {
                acquired();
                if (!lock) return undefined;
                return new Promise<void>((done) => { releaseLock = done; });
            }).catch(() => acquired());
        });
    }
    let wake: { release: () => Promise<void> } | null = null;
    try { wake = await (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null; } catch { /* not granted: fine */ }
    return () => { releaseLock?.(); void wake?.release().catch(() => undefined); };
}

/** Ask Keybard Overlay to let go of the keyboard, where this page already uses it. */
async function pauseKeybardHost(): Promise<CheckRow | null> {
    const native = typeof window !== "undefined" && !!(window as Window & { __keybardNativeState?: unknown }).__keybardNativeState;
    const servedByHost = typeof location !== "undefined" && location.origin === HOST_ORIGIN;
    if (PARANOID || (!native && !servedByHost)) return null;
    try {
        const boot = await fetch(`/api/host/bootstrap`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
        if (!boot.ok) return null;
        const { token } = await boot.json();
        const r = await fetch(`/api/host/command`, { method: "POST", headers: { "Content-Type": "application/json", "X-Keybard-Token": token }, body: JSON.stringify({ op: "disconnect" }), signal: AbortSignal.timeout(1500) });
        return r.ok ? { id: "host", label: "Keybard Overlay paused", state: "ok" } : { id: "host", label: "Keybard Overlay is still using the keyboard.", state: "warn", detail: "Quit Keybard Overlay if the update stops." };
    } catch {
        return null;
    }
}

/** The chord keys by matrix position: Index South + Middle South (right [6,0]+[7,0], left [1,0]+[2,0]). */
const CHORD_KEYS: Record<0 | 1, Array<[number, number]>> = { 1: [[6, 0], [7, 0]], 0: [[1, 0], [2, 0]] };

/**
 * Layer-0 legends of the chord keys, from the board's own keymap. The default layout's
 * letters when the keymap isn't loaded; the key's place when it is empty (a blank board).
 */
export function chordLegendsFor(keyboard: KeyboardInfo | null, hand: 0 | 1): [string, string] {
    const fallback: [string, string] = hand === 1 ? ["M", ","] : ["V", "C"];
    const layer0 = keyboard?.keymap?.[0];
    const cols = keyboard?.cols;
    if (!keyboard || !layer0 || !cols) return fallback;
    const places = ["Index South", "Middle South"];
    return CHORD_KEYS[hand].map(([row, col], i) => {
        const code = layer0[row * cols + col];
        if (code === undefined) return fallback[i];
        if (code === 0) return places[i];
        const label = getKeyLabel(keyboard, code).label?.replace(/\s+/g, " ").trim();
        return label || fallback[i];
    }) as [string, string];
}

type AppState = { kb: ReturnType<typeof useKeyboard>; changes: ReturnType<typeof useChanges>; backups: ReturnType<typeof useBackups> };

/**
 * The app's state as the editor last rendered it, shared by every mount. The editor
 * unmounts while the keyboard reconnects and mounts again once the layout has loaded, so a
 * running update must read the new mount's state: a ref of the old mount stays on
 * "disconnected" forever, and the update then waits out its reconnect and stops.
 */
const shared: { current: AppState | null } = { current: null };
let appHost: FirmwareUiHost | null = null;

export function useAppFirmwareHost(): FirmwareUiHost {
    const kb = useKeyboard();
    const changes = useChanges();
    const backups = useBackups();
    shared.current = { kb, changes, backups };
    return (appHost ??= createAppHost(shared as { current: AppState }));
}

function createAppHost(ref: { current: AppState }): FirmwareUiHost {
    const transport = new WebHidUpdaterTransport(usbInstance);
    const live = (): UpdaterTransport | null => (usbInstance.isOpen() ? transport : null);
    const keyboardLoaded = () => ref.current.kb.isConnected && !!ref.current.kb.keyboard;
    return {
        clock: realClock,
        transport: live,
        async waitForDevice(timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (keyboardLoaded() && usbInstance.isOpen()) return transport;
                const [device] = await listPermittedDevices();
                if (device && !usbInstance.hasDevice(device)) await ref.current.kb.connectDevice(device, { discardEdits: true }).catch(() => false);
                await realClock.sleep(500);
            }
            return null;
        },
        async readStorageFlags() {
            const info = await usbInstance.sendSvil(SvilUSB.CMD_SVIL_GET_INFO, [], { uint8: true });
            return info[17] ?? 0;
        },
        async clearStorageReset() {
            try {
                await usbInstance.sendSvil(SvilUSB.CMD_SVIL_STORAGE_RESET_CLEAR, [], {});
            } finally {
                // The layout loaded on the reconnect still carries the notice: the update has
                // acted on it, so the reset dialog must not ask again on this connection, even
                // if 0x2A didn't get through (the board then asks on the next one).
                // (Not by editing the layout: that would count as an unsaved change.)
                noteResetNoticeCleared(ref.current.kb.connectionSessionId);
            }
        },
        async restoreLayout(svil) {
            // Wait for the reconnect's load, so the restore writes onto what the board holds now.
            const deadline = Date.now() + 20_000;
            while (!keyboardLoaded() && Date.now() < deadline) await realClock.sleep(250);
            const { kb: k, changes: ch } = ref.current;
            const current = k.keyboard;
            if (!current) throw new Error("The keyboard didn't finish loading.");
            return restoreLayoutToBoard(svil, { keyboard: current, setKeyboard: k.setKeyboard, queue: ch.queue, commit: ch.commit, markSaved: k.markAsSaved });
        },
        async keymapBlank() {
            // After the wipe's reconnect: wait for the load, then every key on every layer is KC_NO.
            const deadline = Date.now() + 20_000;
            while (!keyboardLoaded() && Date.now() < deadline) await realClock.sleep(250);
            const keymap = ref.current.kb.keyboard?.keymap;
            return !!keymap?.length && keymap.every((layer) => layer.every((code) => code === 0));
        },
        holdLocks: holdUpdateLocks,
        sides: usbSideHost(usbInstance),
        async makeBackup({ fromTag, toTag }): Promise<UpdateBackup> {
            const { kb: k, backups: b } = ref.current;
            if (!k.keyboard) throw new Error("No layout loaded.");
            const svil = serializeForBackup(k.keyboard);
            // Parse it back before Start is enabled.
            await fileService.loadFile(new File([svil], "check.svil", { type: "application/json" }));
            const boardName = b.board?.name ?? k.keyboard.name ?? "Svalboard";
            const fileName = backupFileName(boardName);
            let snapshotId: string | undefined;
            // Before the board is identified, keep it under its keyboard UID: the reset dialog
            // finds a fresh pre-update backup under any key, and the board may come back
            // under another one anyway.
            const boardKey = b.board?.key ?? (k.keyboard.kbid ? `uid:${k.keyboard.kbid.toUpperCase()}` : null);
            if (boardKey) {
                const meta = await getBackupService()?.saveSnapshot({ boardKey, boardName, svil, kind: "pre-update", pendingCount: 0, fromTag, toTag });
                snapshotId = meta?.id;
            }
            downloadText(svil, fileName);
            return { snapshotId, fileName, svil };
        },
        async prepareRows() {
            const row = await pauseKeybardHost();
            return row ? [row] : [];
        },
        boardName: () => ref.current.backups.board?.name ?? ref.current.kb.keyboard?.name ?? "Svalboard",
        chordLegends: (hand) => chordLegendsFor(ref.current.kb.keyboard, hand),
    };
}
