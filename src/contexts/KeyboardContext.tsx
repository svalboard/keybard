import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { KeyboardService, keyboardService } from "../services/keyboard.service";
import { svalService } from "../services/sval.service";

import { fileService } from "../services/file.service";
import { keyService } from "../services/key.service";
import { qmkService } from "../services/qmk.service";
import { SvilUSB, usbInstance } from "../services/usb.service";
import { customValueService } from "../services/custom-value.service";
import { getClosestPresetColor } from "../utils/color-conversion";
import type { KeyboardInfo } from "../types/keyboard.types";
import { seedComboNames } from "../utils/combo-names";
import { recallComboNames, rememberComboNames } from "../utils/combo-name-memory";
import type { KeyBlockWriter } from "../services/changes.service";
import { PARANOID, userIsLooking } from "../lib/paranoid";
import { LinuxHidAccessError } from "../utils/linux-hid-access";
import { UnsupportedFirmwareError, type UnsupportedFirmwareInfo } from "../utils/unsupported-firmware";
import { RAW_HID_USAGES } from "../services/hid-report";
import { usePointingDetection } from "../hooks/usePointingDetection";

interface KeyboardContextType {
    keyboard: KeyboardInfo | null;
    setKeyboard: React.Dispatch<React.SetStateAction<KeyboardInfo | null>>;
    originalKeyboard: KeyboardInfo | null;
    resetToOriginal: () => void;
    markAsSaved: (confirmed?: KeyboardInfo | null) => void;
    getKeyboardSnapshot: () => KeyboardInfo | null;
    connectionSessionId: number;
    connectionState: "idle" | "connecting" | "loading" | "connected" | "offline" | "error";
    connectionError: string | null;
    /** Shell commands that would fix connectionError, when there are any (the Linux udev rule). */
    connectionFix: string | null;
    /** Set when connectionError is the keyboard running firmware Keybard can't use. */
    connectionFirmware: UnsupportedFirmwareInfo | null;
    /** Clear connectionError (and its fix and firmware details) without touching the connection. */
    dismissConnectionError: () => void;
    isChangingTarget: boolean;
    runDeviceMaintenance: <T>(operation: () => Promise<T>) => Promise<T>;
    registerTargetChangeGuard: (guard: () => Promise<(discardPending?: boolean) => void>) => () => void;
    hasUnsavedChanges: boolean;
    isConnected: boolean;
    isWebHIDSupported: boolean;
    isImporting: boolean;
    setIsImporting: React.Dispatch<React.SetStateAction<boolean>>;
    loadedFrom: string | null;
    connect: (filters?: HIDDeviceFilter[]) => Promise<boolean>;
    /** Open an already-permitted device (from listPermittedDevices) without the chooser. */
    /**
     * Connect a permitted device. `discardEdits`: a firmware update's own reconnect, whose
     * backup already holds the layout; it never asks "discard your edits?" (a native
     * confirm that would freeze the page mid-update).
     */
    connectDevice: (device: HIDDevice, options?: { discardEdits?: boolean }) => Promise<boolean>;
    disconnect: () => Promise<void>;
    loadKeyboard: () => Promise<void>;
    loadFromFile: (file: File, source?: "file" | "demo") => Promise<boolean>;
    updateKey: (layer: number, row: number, col: number, keymask: number) => Promise<void>;
    /** Writes runs of keycodes a message at a time; null unless a keyboard is connected and loaded. */
    getKeyBlockWriter: () => KeyBlockWriter | null;
    pollMatrix: () => Promise<boolean[][]>;
    lastHeartbeat: number;
    activeLayerIndex: number | null;
    /** The board's default layer, when it reports one. */
    defaultLayerIndex: number | null;
}

const serializeDraft = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Map ? { __map: [...item.entries()] } : item);

/**
 * The draft compared against the board. On a connected board, combo names are
 * saved by local backups, never by Apply, so they are not an unsaved edit there.
 * In an offline layout they are: only an export keeps them.
 */
export const draftOf = (kb: KeyboardInfo | null, connected: boolean) => {
    if (!connected || !kb?.cosmetic?.combos) return serializeDraft(kb);
    const { combos: _names, ...cosmetic } = kb.cosmetic;
    return serializeDraft({ ...kb, cosmetic });
};

const KeyboardContext = createContext<KeyboardContextType | undefined>(undefined);

// The raw HID interfaces Svalboard firmware exposes (also where the report length is read)
export const DEFAULT_HID_FILTERS: HIDDeviceFilter[] = RAW_HID_USAGES.map((u) => ({ ...u }));

/**
 * Keyboards this origin may open without the chooser: devices the user has
 * already granted, restricted to interfaces matching the given filters, one
 * entry per physical device.
 */
export async function listPermittedDevices(filters: HIDDeviceFilter[] = DEFAULT_HID_FILTERS): Promise<HIDDevice[]> {
    if (typeof navigator === "undefined" || !navigator.hid?.getDevices) return [];
    const devices = await navigator.hid.getDevices();
    const matches = (d: HIDDevice) => d.collections.some((c) => filters.some((f) =>
        (f.vendorId === undefined || d.vendorId === f.vendorId) &&
        (f.productId === undefined || d.productId === f.productId) &&
        (f.usagePage === undefined || c.usagePage === f.usagePage) &&
        (f.usage === undefined || c.usage === f.usage)));
    return devices.filter(matches);
}

export const KeyboardProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [keyboard, setKeyboardState] = useState<KeyboardInfo | null>(null);
    const [originalKeyboard, setOriginalKeyboard] = useState<KeyboardInfo | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [connectionState, setConnectionState] = useState<KeyboardContextType["connectionState"]>("idle");
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [connectionFix, setConnectionFix] = useState<string | null>(null);
    const [connectionFirmware, setConnectionFirmware] = useState<UnsupportedFirmwareInfo | null>(null);
    const reportConnectionFailure = useCallback((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        setConnectionError(failure.message);
        setConnectionFix(failure instanceof LinuxHidAccessError ? failure.udevCommand : null);
        setConnectionFirmware(failure instanceof UnsupportedFirmwareError ? failure.info : null);
        setConnectionState("error");
    }, []);
    const dismissConnectionError = useCallback(() => {
        setConnectionError(null);
        setConnectionFix(null);
        setConnectionFirmware(null);
    }, []);
    // The layout as last loaded (file, demo or board), and the version the
    // combo name memory last saw: edits after a load are compared to it.
    const loadedLayoutRef = useRef<KeyboardInfo | null>(null);
    const rememberedRef = useRef<KeyboardInfo | null>(null);
    useEffect(() => {
        if (!keyboard) return;
        const previous = keyboard === loadedLayoutRef.current ? null : rememberedRef.current;
        rememberedRef.current = keyboard;
        rememberComboNames(previous, keyboard);
    }, [keyboard]);
    const [connectionSessionId, setConnectionSessionId] = useState(0);
    // Counts loads from the board, so late pointing detection starts over on each.
    const [boardLoad, setBoardLoad] = useState(0);
    const sessionRef = useRef(0);
    // Keymap dimensions as the connected board reported them, for the session that read them.
    const deviceKeymapRef = useRef<{ session: number; layers: number; rows: number; cols: number } | null>(null);
    const targetChangeGuard = useRef<(() => Promise<(discardPending?: boolean) => void>) | null>(null);
    const targetChanging = useRef(false);
    const [isChangingTarget, setIsChangingTarget] = useState(false);
    const registerTargetChangeGuard = useCallback((guard: () => Promise<(discardPending?: boolean) => void>) => {
        targetChangeGuard.current = guard;
        return () => { if (targetChangeGuard.current === guard) targetChangeGuard.current = null; };
    }, []);
    const beginTargetChange = useCallback(async () => {
        if (targetChanging.current) throw new Error("Another connection change is still in progress.");
        targetChanging.current = true;
        setIsChangingTarget(true);
        try {
            const release = await targetChangeGuard.current?.();
            // Finish protocol reads on the old transport before another device can open.
            await inFlightLoadRef.current?.catch(() => undefined);
            return (discardPending = false) => { release?.(discardPending); targetChanging.current = false; setIsChangingTarget(false); };
        } catch (error) { targetChanging.current = false; setIsChangingTarget(false); throw error; }
    }, []);
    const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [lastHeartbeat, setLastHeartbeat] = useState<number>(0);
    const [activeLayerIndex, setActiveLayerIndex] = useState<number | null>(null);
    const [defaultLayerIndex, setDefaultLayerIndex] = useState<number | null>(null);
    const isWebHIDSupported = KeyboardService.isWebHIDSupported();

    // Tracks the in-flight loadKeyboard promise. Multiple components mounted
    // at the same time (KeyboardProvider's own auto-load effect, ConnectKeyboard,
    // KeyboardConnector, ...) all run loadKeyboard on isConnected → fire
    // concurrent Sval protocol reads over the same HID transport. The
    // chunked keyboard-definition fetch can get its chunks interleaved
    // between requests, leaving custom_keycodes (and other payload fields)
    // undefined or partial. Dedupe so callers share a single load.
    const inFlightLoadRef = useRef<Promise<void> | null>(null);

    const keyboardRef = useRef<KeyboardInfo | null>(null);
    const setKeyboard = useCallback<React.Dispatch<React.SetStateAction<KeyboardInfo | null>>>((update) => {
        const next = typeof update === "function" ? update(keyboardRef.current) : update;
        keyboardRef.current = next;
        setKeyboardState(next);
    }, []);
    const originalRef = useRef(originalKeyboard);
    originalRef.current = originalKeyboard;
    const connectedRef = useRef(isConnected);
    connectedRef.current = isConnected;
    const confirmTargetChange = useCallback(() => {
        const dirty = keyboardRef.current && originalRef.current &&
            draftOf(keyboardRef.current, connectedRef.current) !== draftOf(originalRef.current, connectedRef.current);
        return !dirty || window.confirm("You have unsaved edits. Discard them and change the editing target?");
    }, []);
    const nextSession = useCallback(() => {
        sessionRef.current += 1;
        setConnectionSessionId(sessionRef.current);
    }, []);

    const afterOpen = useCallback((success: boolean) => {
        if (success) {
            nextSession();
            setKeyboard(null);
            setOriginalKeyboard(null);
            setConnectionState("loading");
            usbInstance.onDisconnect = () => {
                console.log("Disconnect detected via listener");
                sessionRef.current += 1; // invalidate an interrupted load, retain the draft and queue
                setIsConnected(false);
                setConnectionState("offline");
                setConnectionError("Keyboard disconnected. Your local edits are retained; export a backup before reconnecting if needed.");
                setConnectionFirmware(null);
            };
        }
        setIsConnected(success);
        if (!success) setConnectionState(keyboardRef.current ? "offline" : "idle");
        return success;
    }, [nextSession]);

    // Switch the editing target to a device. Its firmware is checked first, on a
    // separate connection, so a board Keybard can't use leaves whatever is being
    // edited (an offline draft, or another connected board) exactly as it was,
    // and only a usable board gets as far as the "discard your edits?" prompt.
    const switchTo = useCallback(async (device: HIDDevice, options?: { discardEdits?: boolean }) => {
        setConnectionError(null);
        setConnectionFix(null);
        setConnectionFirmware(null);
        if (!usbInstance.hasDevice(device)) {
            try {
                await SvilUSB.checkFirmware(device);
            } catch (error) {
                console.error("Keyboard failed the firmware check:", error);
                const failure = error instanceof Error ? error : new Error(String(error));
                setConnectionError(failure.message);
                setConnectionFix(failure instanceof LinuxHidAccessError ? failure.udevCommand : null);
                setConnectionFirmware(failure instanceof UnsupportedFirmwareError ? failure.info : null);
                return false;
            }
        }
        if (!options?.discardEdits && !confirmTargetChange()) return false;
        setConnectionState("connecting");
        let release: ((discardPending?: boolean) => void) | undefined;
        let changed = false;
        try {
            release = await beginTargetChange();
            changed = await usbInstance.openDevice(device);
            return afterOpen(changed);
        } catch (error) {
            console.error("Failed to connect to keyboard:", error);
            reportConnectionFailure(error);
            return false;
        } finally { release?.(changed); }
    }, [afterOpen, confirmTargetChange, beginTargetChange, reportConnectionFailure]);

    const connect = useCallback(async (filters?: HIDDeviceFilter[]) => {
        let device: HIDDevice | null;
        try {
            device = await SvilUSB.requestDevice(filters || DEFAULT_HID_FILTERS);
        } catch (error) {
            console.error("Failed to choose a keyboard:", error);
            setConnectionError(error instanceof Error ? error.message : String(error));
            return false;
        }
        // Closing the chooser changes nothing.
        return device ? switchTo(device) : false;
    }, [switchTo]);

    const connectDevice = switchTo;

    const disconnect = useCallback(async () => {
        const release = await beginTargetChange();
        try {
            await usbInstance.close();
            setIsConnected(false);
            sessionRef.current += 1;
            setConnectionState(keyboardRef.current ? "offline" : "idle");
        } catch (error) {
            setConnectionError(error instanceof Error ? error.message : String(error));
            throw error;
        } finally { release(); }
    }, [beginTargetChange]);

    const loadKeyboard = useCallback(async () => {
        if (!isConnected) {
            console.log("loadKeyboard not connected");
            throw new Error("USB device not connected");
        }

        // If a load is already in flight, share its promise instead of
        // racing another set of HID reads.
        if (inFlightLoadRef.current) {
            return inFlightLoadRef.current;
        }

        const session = sessionRef.current;
        setConnectionState("loading");
        const loadPromise = (async () => {
            try {
                const kbinfo: KeyboardInfo = {
                    rows: 0,
                    cols: 0,
                };
                await keyboardService.init(kbinfo);
                const loadedInfo = await keyboardService.load(kbinfo);

                // Load QMK settings
                console.log("[KeyboardContext] About to load QMK settings...");
                try {
                    await qmkService.get(loadedInfo);
                    console.log("[KeyboardContext] QMK settings loaded:", loadedInfo.settings);
                } catch (error) {
                    console.warn("Failed to load QMK settings:", error);
                }

                // Load layer colors from keyboard using VIA custom values
                console.log("[KeyboardContext] Loading layer colors from keyboard...");
                try {
                    const layerColors = await usbInstance.getAllLayerColors();
                    // Convert to format with val (brightness) - default to max
                    loadedInfo.layer_colors = layerColors.map(c => ({
                        hue: c.hue,
                        sat: c.sat,
                        val: 255
                    }));
                    console.log("[KeyboardContext] Layer colors loaded:", loadedInfo.layer_colors);

                    // Also update cosmetic.layer_colors with the closest preset color names
                    // This is needed for the keyboard display to show correct colors
                    if (!loadedInfo.cosmetic) {
                        loadedInfo.cosmetic = { layer: {}, layer_colors: {} };
                    }
                    if (!loadedInfo.cosmetic.layer_colors) {
                        loadedInfo.cosmetic.layer_colors = {};
                    }
                    layerColors.forEach((c, idx) => {
                        const presetName = getClosestPresetColor(c.hue, c.sat, 255);
                        loadedInfo.cosmetic!.layer_colors![idx.toString()] = presetName;
                    });
                    console.log("[KeyboardContext] Cosmetic layer colors:", loadedInfo.cosmetic.layer_colors);
                } catch (error) {
                    console.warn("Failed to load layer colors:", error);
                }

                // Load all VIA3 custom values (DPI, scroll mode, automouse, etc.)
                if (loadedInfo.menus) {
                    console.log("[KeyboardContext] Loading VIA3 custom values from keyboard...");
                    try {
                        // Drop any values cached from a previous connect so a stale
                        // reading can't survive a reconnect within the same page session.
                        customValueService.clearCache();
                        loadedInfo.custom_values = await customValueService.loadAllMenuValues(loadedInfo.menus);
                        console.log("[KeyboardContext] Custom values loaded:", loadedInfo.custom_values.length, "entries");
                    } catch (error) {
                        console.warn("Failed to load custom values:", error);
                    }
                }

                if (session !== sessionRef.current) return;
                // A reload of the same board keeps its combo names (they are not
                // on the board) for the combos that did not change.
                if (deviceKeymapRef.current?.session === session) {
                    const names = seedComboNames(keyboardRef.current, loadedInfo);
                    if (names) loadedInfo.cosmetic = { ...loadedInfo.cosmetic, combos: names };
                }
                // Names remembered in this browser fill in the combos that have none.
                loadedInfo.cosmetic = recallComboNames(loadedInfo).cosmetic;
                loadedLayoutRef.current = loadedInfo;
                setKeyboard(loadedInfo);
                setBoardLoad((n) => n + 1);
                setConnectionState("connected");
                setConnectionError(null);
                setConnectionFirmware(null);
                // Store original state for revert functionality
                setOriginalKeyboard(structuredClone(loadedInfo));
                deviceKeymapRef.current = { session, layers: loadedInfo.layers ?? 0, rows: loadedInfo.rows, cols: loadedInfo.cols };
                // Set loadedFrom to device product name
                const deviceName = usbInstance.getDeviceName();
                setLoadedFrom(deviceName || loadedInfo.kbid || "Connected Device");
            } catch (error) {
                if (session === sessionRef.current) {
                    reportConnectionFailure(error);
                    try { await usbInstance.close(); } catch (closeError) { console.error("Failed to close connection after load error", closeError); }
                }
                throw error;
            }
        })();
        inFlightLoadRef.current = loadPromise;
        const clearLoad = () => {
            if (inFlightLoadRef.current === loadPromise) inFlightLoadRef.current = null;
        };
        void loadPromise.then(clearLoad, clearLoad);
        return loadPromise;
    }, [isConnected, reportConnectionFailure]);

    useEffect(() => {
        if (isConnected) {
            loadKeyboard().catch((error) => {
                console.error("Failed to auto-load keyboard:", error);
                setIsConnected(false);
            });
        }
    }, [isConnected, loadKeyboard]);

    const loadFromFile = useCallback(async (file: File, source: "file" | "demo" = "file") => {
        let release: ((discardPending?: boolean) => void) | undefined;
        let changed = false;
        try {
            const loaded = await fileService.loadFile(file);

            // Offline files own their metadata. Never borrow capabilities or layout
            // structure from a previously connected, possibly unrelated board.
            if (!confirmTargetChange()) return false;
            release = await beginTargetChange();
            svalService.setupCosmeticLayerNames(loaded);
            keyService.generateAllKeycodes(loaded);
            // Names remembered in this browser come back; the demo's example names give way to them.
            const kbinfo = recallComboNames(loaded, { replace: source === "demo" });
            loadedLayoutRef.current = kbinfo;
            if (KeyboardService.isWebHIDSupported()) await usbInstance.close();
            nextSession();
            changed = true;
            setConnectionError(null);
            setConnectionFirmware(null);
            setConnectionState("offline");
            setKeyboard(kbinfo);
            // Store original state for revert functionality
            setOriginalKeyboard(structuredClone(kbinfo));
            const filePath = source === "demo" ? "QWERTY example (demo)" : file.name;
            setLoadedFrom(filePath);
            setIsConnected(false);
            return true;
        } catch (error) {
            throw error instanceof Error ? error : new Error(String(error));
        } finally { release?.(changed); }
    }, [confirmTargetChange, nextSession, beginTargetChange]);

    const runDeviceMaintenance = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
        if (!isConnected || connectionState !== "connected") throw new Error("Connect a keyboard before performing maintenance.");
        const session = sessionRef.current;
        const release = await beginTargetChange();
        try {
            if (session !== sessionRef.current) throw new Error("The keyboard disconnected before maintenance could start.");
            return await operation();
        } finally { release(); }
    }, [isConnected, connectionState, beginTargetChange]);

    // Note: Auto-restore from localStorage was removed to ensure users always
    // see the "Connect or Load a File" page on refresh. Users should explicitly
    // connect to a device or load a file each session.

    const updateKey = useCallback(
        async (layer: number, row: number, col: number, keymask: number) => {
            if (!isConnected || connectionState !== "connected") {
                throw new Error("Keyboard is not ready for changes");
            }
            await keyboardService.updateKey(layer, row, col, keymask);
        },
        [isConnected, connectionState]
    );

    const getKeyBlockWriter = useCallback((): KeyBlockWriter | null => {
        const dims = deviceKeymapRef.current;
        if (!isConnected || connectionState !== "connected" || !dims || dims.session !== sessionRef.current) return null;
        const session = dims.session;
        return {
            layers: dims.layers,
            rows: dims.rows,
            cols: dims.cols,
            maxKeys: keyboardService.keymapBlockKeys(),
            write: async (index, keycodes) => {
                if (session !== sessionRef.current) throw new Error("Keyboard is not ready for changes");
                await keyboardService.updateKeyBlock(index, keycodes);
            },
        };
    }, [isConnected, connectionState]);

    const pollMatrix = useCallback(async () => {
        if (!keyboard || !isConnected) return [];
        const result = await keyboardService.pollMatrix(keyboard);
        setLastHeartbeat(Date.now());
        return result;
    }, [keyboard, isConnected]);

    useEffect(() => {
        let isActive = true;
        let timeoutId: number | undefined;

        const pollLayerState = async () => {
            if (!isActive) return;
            if (PARANOID && !userIsLooking()) {
                // Paranoid: don't watch the board while Keybard isn't in front of you.
            } else if (isConnected && keyboard && usbInstance.getDeviceName()) {
                try {
                    const { active, defaultLayer } = await keyboardService.getLayerIndexes(keyboard);
                    if (isActive) {
                        setActiveLayerIndex(active);
                        setDefaultLayerIndex(defaultLayer);
                    }
                } catch (error) {
                    console.warn("Layer state polling error:", error);
                }
            } else if (isActive) {
                setActiveLayerIndex(null);
                setDefaultLayerIndex(null);
            }

            if (isActive) {
                timeoutId = window.setTimeout(pollLayerState, 120);
            }
        };

        pollLayerState();

        return () => {
            isActive = false;
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        };
    }, [isConnected, keyboard]);

    // A pointing module the board finds after connect: board state, written into
    // the draft and the loaded copy alike, so it never reads as an unsaved edit.
    usePointingDetection({
        connected: isConnected && connectionState === "connected",
        boardLoad,
        getKeyboard: () => keyboardRef.current,
        apply: useCallback((patch: (kb: KeyboardInfo) => KeyboardInfo) => {
            const current = keyboardRef.current;
            if (!current) return;
            const next = patch(current);
            if (loadedLayoutRef.current === current) loadedLayoutRef.current = next;
            setKeyboard(next);
            setOriginalKeyboard((original) => original ? patch(original) : original);
        }, [setKeyboard]),
    });

    // Reset keyboard to original state (used by revert)
    const resetToOriginal = useCallback(() => {
        if (originalKeyboard) {
            // Combo names on a connected board are not part of what Apply reverts.
            const names = isConnected ? keyboardRef.current?.cosmetic?.combos : undefined;
            const reverted = structuredClone(originalKeyboard);
            if (names) reverted.cosmetic = { ...reverted.cosmetic, combos: names };
            setKeyboard(reverted);
        }
    }, [originalKeyboard, isConnected]);

    // Mark current state as saved (called after push/commit)
    const getKeyboardSnapshot = useCallback(() => keyboardRef.current ? structuredClone(keyboardRef.current) : null, []);
    const markAsSaved = useCallback((confirmed?: KeyboardInfo | null) => {
        if (confirmed) setOriginalKeyboard(structuredClone(confirmed));
    }, []);

    // Detect if there are unsaved changes by comparing current to original
    const hasUnsavedChanges = React.useMemo(() => {
        if (!keyboard || !originalKeyboard) return false;
        return draftOf(keyboard, isConnected) !== draftOf(originalKeyboard, isConnected);
    }, [keyboard, originalKeyboard, isConnected]);

    useEffect(() => {
        if (!hasUnsavedChanges) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [hasUnsavedChanges]);

    const value: KeyboardContextType = {
        keyboard,
        setKeyboard,
        originalKeyboard,
        resetToOriginal,
        markAsSaved,
        getKeyboardSnapshot,
        connectionState,
        connectionError,
        connectionFix,
        connectionFirmware,
        dismissConnectionError,
        connectionSessionId,
        registerTargetChangeGuard,
        isChangingTarget,
        runDeviceMaintenance,
        hasUnsavedChanges,
        isConnected: isConnected && connectionState === "connected",
        isWebHIDSupported,
        isImporting,
        setIsImporting,
        loadedFrom,
        connect,
        connectDevice,
        disconnect,
        loadKeyboard,
        loadFromFile,
        updateKey,
        getKeyBlockWriter,
        pollMatrix,
        lastHeartbeat,
        activeLayerIndex,
        defaultLayerIndex,
    };

    return <KeyboardContext.Provider value={value}>{children}</KeyboardContext.Provider>;
};

export const useKeyboard = (): KeyboardContextType => {
    const context = useContext(KeyboardContext);
    if (!context) {
        throw new Error("useKeyboard must be used within a KeyboardProvider");
    }
    return context;
};
