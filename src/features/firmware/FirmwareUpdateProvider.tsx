// The firmware update, app-wide: one controller and one dialog for the editor, so an update
// started in Settings > Firmware keeps its dialog wherever the user is, and a reload mid-update
// picks it back up. Also the rail dot, and the "open Firmware" and "open Backups" requests.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { currentSite, releasesForSite, type FirmwareReleasePin } from "@/constants/firmware-releases";
import { serializeForBackup, useBackups } from "@/contexts/BackupContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { usePanels } from "@/contexts/PanelsContext";
import { requestSettingsSection } from "@/layout/SecondarySidebar/Panels/settings/anchor";
import type { Hand } from "@/services/updater/protocol";
import { usbInstance } from "@/services/usb.service";
import { WebHidUpdaterTransport } from "@/services/updater/webhid-transport";
import { usbSideHost } from "@/services/side-host";
import { readBoardSummary, type BoardSummary } from "./board-summary";
import { loadCarriedRelease } from "./carried";
import type { FailureAction } from "./failures";
import type { FirmwarePick } from "./FirmwareSection";
import { ManualInstall } from "./ManualInstall";
import { InFirmwareDialog } from "./parts";
import { UpdateDialog } from "./UpdateDialog";
import { backupFileName, downloadText, useAppFirmwareHost } from "./useAppFirmwareHost";
import { useFirmwareStatus, type FirmwareStatus } from "./useFirmwareStatus";
import { useFirmwareUpdate, type FirmwareUiHost } from "./useFirmwareUpdate";
import { useManualInstall } from "./useManualInstall";
import { OPEN_BACKUPS_EVENT, OPEN_FIRMWARE_EVENT, useBoardRead } from "./useHalvesDiffer";
import type { SideWrite } from "@/services/side-decision";
import { applySideWrites } from "./side-actions";

/** The side fix on the Firmware page and the banner (one-image firmware). */
export interface SideFixControl {
    busy: boolean;
    note: string | null;
    apply: (writes: SideWrite[]) => void;
}

export interface FirmwareUpdates {
    /** What the connected board runs (null: none, or still reading). */
    board: BoardSummary | null;
    /** A keyboard is connected and its firmware is still being read. */
    reading: boolean;
    /** Read the board again (Check again, opening the card); the summary stays while it runs. */
    recheck: () => void;
    /** A read asked for by recheck is running. */
    checking: boolean;
    releases: FirmwareReleasePin[];
    status: FirmwareStatus;
    install: (pick: FirmwarePick, onlyHand?: Hand) => void;
    openManual: (release: FirmwareReleasePin | null) => void;
    connect: () => void;
    /** Set which half is which (absent without a host). */
    sides?: SideFixControl;
}

const FirmwareUpdatesContext = createContext<FirmwareUpdates | null>(null);

/** The app's firmware updates; null outside the editor (the connect screen, tests). */
export function useFirmwareUpdates(): FirmwareUpdates | null {
    return useContext(FirmwareUpdatesContext);
}

/** Open Settings at a section, from anywhere in the editor. */
function useOpenSettingsSection() {
    const { setActivePanel, openDetails, setPanelToGoBack, setItemToEdit } = usePanels();
    return useCallback((id: string) => {
        requestSettingsSection(id);
        setActivePanel("settings");
        openDetails();
        setPanelToGoBack(null);
        setItemToEdit(null);
    }, [setActivePanel, openDetails, setPanelToGoBack, setItemToEdit]);
}

export interface FirmwareUpdateProviderProps {
    children: ReactNode;
    /** Dev and tests: a host other than the WebHID connection (the mock board). */
    host?: FirmwareUiHost | null;
    /** Dev and tests: the board summary, when the host isn't the app's connection. */
    readBoard?: () => Promise<BoardSummary | null>;
    releases?: FirmwareReleasePin[];
    files?: (pin: FirmwareReleasePin) => ReturnType<typeof loadCarriedRelease>;
    /** Dev and tests: the connection, when the host isn't the app's (key: null while none is open). */
    connection?: { key: string | null; connect: () => void };
}

/** This page load: a connection after a reload is a new one, whatever its session number. */
const PAGE_ID = Math.random().toString(36).slice(2, 10);

export function FirmwareUpdateProvider({ children, host: injected, readBoard, releases: givenReleases, files, connection }: FirmwareUpdateProviderProps) {
    const kb = useKeyboard();
    const backups = useBackups();
    const appHost = useAppFirmwareHost();
    const host = injected === undefined ? appHost : injected;
    const releases = useMemo(() => givenReleases ?? releasesForSite(currentSite()), [givenReleases]);
    const fw = useFirmwareUpdate(host, { releases });
    const openSection = useOpenSettingsSection();

    // The board: from the connection, re-read on each new connection, after each update or
    // dialog close, and on recheck (Check again, opening the card).
    const [refresh, setRefresh] = useState(0);
    const app = useBoardRead(refresh);
    const [injectedRead, setInjected] = useState<{ board: BoardSummary | null; refresh: number } | null>(null);
    const injectedKey = connection?.key;
    useEffect(() => {
        if (!readBoard) return;
        let cancelled = false;
        const asked = refresh;
        void readBoard().then(
            (b) => { if (!cancelled) setInjected({ board: b, refresh: asked }); },
            () => { if (!cancelled) setInjected((prev) => ({ board: prev?.board ?? null, refresh: asked })); },
        );
        return () => { cancelled = true; };
    }, [readBoard, refresh, injectedKey]);
    useEffect(() => { if (fw.ui.kind === "idle") setRefresh((n) => n + 1); }, [fw.ui.kind]);
    const board = readBoard ? injectedRead?.board ?? null : app.board;
    const checking = readBoard ? !!injectedRead?.board && injectedRead.refresh !== refresh : app.checking;
    // Not mid-update: the update reads the board itself, and its dialog says what it found.
    const idle = fw.ui.kind === "idle";
    const recheck = useCallback(() => { if (idle) setRefresh((n) => n + 1); }, [idle]);
    const status = useFirmwareStatus(board, { releases });

    // The manual install: a backup when it opens, the layout put back once the keyboard is.
    const connectionKey = connection ? connection.key : kb.isConnected && kb.keyboard ? `${PAGE_ID}:${kb.connectionSessionId}` : null;
    const connect = useCallback(() => (connection ? connection.connect() : void kb.connect()), [connection, kb]);
    const keyboardRef = useRef(kb.keyboard);
    keyboardRef.current = kb.keyboard;
    // On Connect: what each half runs, read fresh on the connection open now.
    const readBoardNow = useCallback(
        () => (readBoard ? readBoard() : readBoardSummary(new WebHidUpdaterTransport(usbInstance), keyboardRef.current, usbSideHost(usbInstance))),
        [readBoard],
    );
    const manual = useManualInstall(host, {
        connectionKey, readBoard: readBoardNow, fromTag: board?.tag || board?.legacyLabel || "", fromFw: board ? board.fwVersion : null, once: !!board && !board.updater && !board.unread, usualHand: board?.usbHand,
        buildReset: !connection && !!kb.keyboard?.storage_build_reset,
    });
    const setManual = manual.open;
    // Connect in the manual install: plug in again, or, already connected, check this connection.
    const manualConnect = useCallback(() => {
        if (connection) connection.connect();
        else if (kb.isConnected && kb.keyboard) manual.checkNow();
        else void kb.connect();
    }, [connection, kb, manual]);
    // The card reads the board again once the manual install closes or finishes.
    const manualPhase = manual.session && !manual.session.dismissed ? manual.session.phase : "closed";
    useEffect(() => { if (manualPhase === "done" || manualPhase === "closed") setRefresh((n) => n + 1); }, [manualPhase]);

    const install = useCallback((pick: FirmwarePick, onlyHand?: Hand) => {
        if (pick.kind === "files") return void fw.openSheet({ kind: "file", files: pick.files }, onlyHand);
        void (async () => {
            const loaded = await (files ?? loadCarriedRelease)(pick.release);
            await fw.openSheet({ kind: "release", release: pick.release, files: loaded }, onlyHand);
        })().catch((error) => console.warn("[firmware] couldn't load the release", error));
    }, [fw, files]);

    // Which half is which, from the Firmware page or the banner: send the fix, then read the board again.
    const [sideState, setSideState] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
    const applySides = useCallback((writes: SideWrite[], then?: () => void) => {
        if (!host) return;
        setSideState({ busy: true, note: null });
        void applySideWrites(host, writes)
            .catch(() => "The keyboard stopped answering. Reconnect it, then try again.")
            .then((note) => { setSideState({ busy: false, note }); setRefresh((n) => n + 1); then?.(); });
    }, [host]);

    // Requests from elsewhere: the halves-differ banner, the reset dialog's "Other backups".
    useEffect(() => {
        const toFirmware = () => openSection("firmware");
        const toBackups = () => openSection("backups");
        window.addEventListener(OPEN_FIRMWARE_EVENT, toFirmware);
        window.addEventListener(OPEN_BACKUPS_EVENT, toBackups);
        return () => {
            window.removeEventListener(OPEN_FIRMWARE_EVENT, toFirmware);
            window.removeEventListener(OPEN_BACKUPS_EVENT, toBackups);
        };
    }, [openSection]);

    const onFailureAction = (a: FailureAction) => {
        if (a === "retry") fw.retry();
        else if (a === "finish") fw.finish();
        else if (a === "reload") location.reload();
        else if (a === "manual" || a === "download") {
            // A half stuck as a drive (F10, F11): only that half's file and steps.
            const state = fw.ui.kind === "flow" ? fw.ui.state : null;
            const failure = state?.failure ?? null;
            const only = failure && (failure.id === "F10" || failure.id === "F11") ? failure.hand : undefined;
            const release = (state && releases.find((r) => r.tag === state.toTag)) || releases[0] || null;
            fw.close();
            manual.open(release, only);
        }
        else if (a === "backups") { fw.close(); openSection("backups"); }
        else fw.close();
    };

    // The automatic backup failed: let the user save the layout as a file now.
    const saveManually = useCallback(() => {
        if (!kb.keyboard) return;
        downloadText(serializeForBackup(kb.keyboard), backupFileName(backups.board?.name ?? kb.keyboard.name ?? "Svalboard"));
    }, [kb.keyboard, backups.board?.name]);

    const value = useMemo<FirmwareUpdates>(() => ({
        board, reading: !readBoard && kb.isConnected && !board, recheck, checking, releases, status, install, openManual: (r) => setManual(r), connect,
        sides: host ? { ...sideState, apply: applySides } : undefined,
    }), [board, readBoard, recheck, checking, releases, status, install, kb.isConnected, setManual, connect, host, sideState, applySides]);
    // An install closed before the keyboard came back stays out of sight until it does.
    const session = manual.session?.dismissed ? null : manual.session;

    return (
        <FirmwareUpdatesContext.Provider value={value}>
            {children}
            {host && (
                <UpdateDialog
                    ui={fw.ui}
                    now={() => host.clock.now()}
                    chordLegends={(h) => host.chordLegends(h)}
                    cancellable={!!fw.flow?.cancellable}
                    onAfterwards={fw.setAfterwards}
                    onStart={fw.start}
                    onCancel={() => (fw.ui.kind === "flow" ? fw.flow?.cancel() : fw.close())}
                    onClose={fw.close}
                    onFailureAction={onFailureAction}
                    onSaveManually={saveManually}
                    onFixSides={(w) => void fw.fixSides(w)}
                    onAnswerSide={fw.answerSide}
                />
            )}
            {session && (
                <Dialog open onOpenChange={(open) => { if (!open && session.phase !== "restoring") manual.close(); }}>
                    <DialogContent className="sm:max-w-[480px]" onInteractOutside={(e) => e.preventDefault()} aria-describedby={undefined}>
                        <InFirmwareDialog.Provider value>
                            <ManualInstall
                                release={releases.find((r) => r.tag === session.releaseTag) ?? null}
                                only={session.only}
                                usualHand={session.usualHand}
                                once={session.once}
                                backup={session.backup}
                                afterwards={session.afterwards}
                                onAfterwards={(a) => { if (a !== "blank") manual.setAfterwards(a); }}
                                check={session.check}
                                outcome={session}
                                onConnect={manualConnect}
                                onClose={manual.close}
                                onOpenBackups={() => { manual.forget(); openSection("backups"); }}
                                onSides={(w) => applySides(w, manual.checkNow)}
                                sidesBusy={sideState.busy}
                                sidesNote={sideState.note}
                            />
                        </InFirmwareDialog.Provider>
                    </DialogContent>
                </Dialog>
            )}
        </FirmwareUpdatesContext.Provider>
    );
}
