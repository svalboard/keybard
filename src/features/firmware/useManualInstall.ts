// The manual install's controller: the backup when it opens (as the in-app install's
// sheet takes one), the layout choice, and the one real check: when the keyboard is
// connected again, read what each half runs. Both on the release: act on the layout
// choice. Otherwise the dialog names the half that still needs its file.
// The state is in sessionStorage, so the dialog the editor shows again after the
// reconnect carries on.

import { useCallback, useEffect, useRef, useState } from "react";

import type { FirmwareReleasePin } from "@/constants/firmware-releases";
import { announceFlowState, type FlowHost } from "@/services/updater/flow";
import {
    checkManual, manualInstalledSince, manualKeepsOnClose, manualPending, manualShouldCheck, newManualSession, runManualAfterwards, sessionManualStore,
    type ManualAfterwards, type ManualBoardRead, type ManualSession, type ManualStore,
} from "@/services/updater/manual";
import type { Hand } from "@/services/updater/protocol";
import type { UpdateBackup } from "./useFirmwareUpdate";

export interface ManualHost extends Pick<FlowHost, "restoreLayout" | "readStorageFlags" | "clearStorageReset"> {
    makeBackup(info: { fromTag: string; toTag: string }): Promise<UpdateBackup>;
}

let tabStore: ManualStore | null = null;
/** Backups, checks and restores running in this page, by session id: a remounted controller doesn't start them again. */
const backingUp = new Set<string>();
const checking = new Set<string>();
const restoring = new Set<string>();

export interface UseManualInstallOptions {
    /** The connection the keyboard is on now, null while none is. */
    connectionKey: string | null;
    /** Read what each half runs on the connection open now. */
    readBoard: () => Promise<ManualBoardRead | null>;
    /** What the board runs, for the backup's name and to name a half that still runs it. */
    fromTag: string;
    fromFw?: number | null;
    /** The board has no updater Keybard installs through. */
    once?: boolean;
    usualHand?: Hand;
    /** The board on this connection says new firmware reset its settings. */
    buildReset?: boolean;
    store?: ManualStore;
}

export function useManualInstall(host: ManualHost | null, o: UseManualInstallOptions) {
    const storeRef = useRef<ManualStore>(o.store ?? (tabStore ??= sessionManualStore(undefined, announceFlowState)));
    const [session, setSession] = useState<ManualSession | null>(() => storeRef.current.load());
    const hostRef = useRef(host);
    hostRef.current = host;
    const readRef = useRef(o.readBoard);
    readRef.current = o.readBoard;
    const buildResetRef = useRef(!!o.buildReset);
    buildResetRef.current = !!o.buildReset;

    /** Change the saved session, only while it is still the open one. */
    const patch = useCallback((id: string, change: (s: ManualSession) => ManualSession) => {
        const now = storeRef.current.load();
        if (!now || now.id !== id) return;
        const next = change(now);
        storeRef.current.save(next);
        setSession(next);
    }, []);

    const open = useCallback((release: FirmwareReleasePin | null, only?: Hand) => {
        const h = hostRef.current;
        const connected = !!h && !!o.connectionKey;
        const s = newManualSession({
            releaseTag: release?.tag ?? null, releaseFw: release?.fwVersion ?? null, fromTag: o.fromTag, fromFw: o.fromFw ?? null,
            only, usualHand: o.usualHand, openKey: o.connectionKey, connected, once: o.once,
        });
        storeRef.current.save(s);
        setSession(s);
        if (!connected) return;
        backingUp.add(s.id);
        void h!.makeBackup({ fromTag: o.fromTag, toTag: release?.tag ?? "" }).then(
            (b) => patch(s.id, (x) => ({ ...x, backup: { state: "ok", fileName: b.fileName, snapshotId: b.snapshotId, svil: b.svil } })),
            // Gentle, as on the sheet: warn, and switch Restore my layout to the default layout.
            (e) => patch(s.id, (x) => ({ ...x, backup: { state: "failed", error: e instanceof Error ? e.message : String(e) }, afterwards: "defaults" })),
        ).finally(() => backingUp.delete(s.id));
    }, [o.connectionKey, o.fromTag, o.fromFw, o.once, o.usualHand, patch]);

    // After a reload mid-backup: that backup is gone with the page.
    useEffect(() => {
        if (session?.backup?.state === "pending" && !backingUp.has(session.id)) {
            patch(session.id, (x) => ({ ...x, backup: { state: "failed", error: "The backup didn't finish." }, afterwards: "defaults" }));
        }
    }, [session, patch]);

    const setAfterwards = useCallback((afterwards: ManualAfterwards) => {
        if (!session) return;
        patch(session.id, (x) => ((afterwards === "restore" && x.backup?.state !== "ok") || x.phase !== "steps" ? x : { ...x, afterwards }));
    }, [session, patch]);

    /** Act on the layout choice, once both halves run the release. */
    const finish = useCallback((id: string) => {
        const h = hostRef.current;
        const s = storeRef.current.load();
        if (!h || !s || s.id !== id || restoring.has(id)) return;
        restoring.add(id);
        patch(id, (x) => ({ ...x, phase: "restoring", error: null }));
        // The reset notice this connection's load reported is this install's to clear, whatever a later read says.
        void runManualAfterwards(h, s, { reportedReset: () => buildResetRef.current }).then(
            (result) => patch(id, (x) => ({ ...x, phase: "done", result })),
            (e) => patch(id, (x) => ({ ...x, phase: "failed", error: e instanceof Error ? e.message : String(e) })),
        ).finally(() => restoring.delete(id));
    }, [patch]);

    /** Read both halves on the connection open now. */
    const check = useCallback((key: string | null) => {
        const s = storeRef.current.load();
        if (!s || s.phase !== "steps" || checking.has(s.id)) return;
        checking.add(s.id);
        void readRef.current().catch(() => null).then((board) => {
            const result = checkManual(s, board);
            // A board Keybard couldn't read says nothing about the install: keep it (and its hold
            // on the reset notice) for the next Connect, never drop it on a missed answer.
            if (s.dismissed && (!board || board.unread) && !buildResetRef.current) return;
            if (s.dismissed) {
                // Closed before the keyboard came back: carry on only if the install happened.
                if (!manualInstalledSince(s, board, buildResetRef.current)) {
                    if (storeRef.current.load()?.id === s.id) { storeRef.current.clear(); setSession(null); }
                    return;
                }
            }
            patch(s.id, (x) => ({ ...x, dismissed: false, check: result, checkedKey: key }));
            if (!result.sides && !manualPending(s, result).length) finish(s.id);
        }).finally(() => checking.delete(s.id));
    }, [patch, finish]);

    // The keyboard is back on a new connection: check it, once per connection.
    useEffect(() => {
        if (session && manualShouldCheck(session, o.connectionKey)) check(o.connectionKey);
    }, [session, o.connectionKey, check]);

    // A reload mid-restore: the page that ran it is gone, so run it again (it writes only what differs).
    useEffect(() => {
        if (session?.phase === "restoring" && !restoring.has(session.id)) {
            patch(session.id, (x) => ({ ...x, phase: "steps" }));
            finish(session.id);
        }
    }, [session, patch, finish]);

    /** Connect while already connected: check the connection open now. */
    const checkNow = useCallback(() => check(o.connectionKey), [check, o.connectionKey]);

    // Closed while the keyboard is away (or not reconnected yet): keep the backup and the
    // layout choice, so however the person reconnects, the layout goes back.
    const close = useCallback(() => {
        const s = storeRef.current.load();
        if (s && manualKeepsOnClose(s)) {
            const next = { ...s, dismissed: true };
            storeRef.current.save(next);
            setSession(next);
            return;
        }
        storeRef.current.clear();
        setSession(null);
    }, []);

    /** Forget the install altogether (Open Backups). */
    const forget = useCallback(() => {
        storeRef.current.clear();
        setSession(null);
    }, []);

    return { session, open, setAfterwards, checkNow, close, forget };
}
