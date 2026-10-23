import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, PlugZap, Unplug } from "lucide-react";

import { useKeyboard, listPermittedDevices } from "@/contexts/KeyboardContext";
import KeybardLogo from "@/components/icons/KeybardLogo";
import { UnsupportedFirmwareCard } from "@/components/FirmwareUpdate";
import demoLayoutUrl from "@/default-layouts/sval-default.svil?url";
import { claimDemoStart, demoFromSearch, type DemoChoice, withDemoFeatures } from "@/lib/deepLinks";

const ConnectKeyboard = () => {
    const { isConnected, connect, connectDevice, disconnect, loadFromFile, isWebHIDSupported, connectionState, connectionError, connectionFix, connectionFirmware } = useKeyboard();
    const [fixCopied, setFixCopied] = useState(false);
    const [knownDevices, setKnownDevices] = useState<HIDDevice[]>([]);
    const [loading, setLoading] = useState(false);
    const [isDisconnecting, setIsDisconnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const connectButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => setFixCopied(false), [connectionFix]);

    useEffect(() => {
        if (!isConnected && !loading && connectButtonRef.current) {
            connectButtonRef.current.focus();
        }
    }, [isConnected, loading]);

    const handleConnect = async () => {
        setLoading(true);
        setError(null);
        try {
            await connect();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error occurred");
        } finally {
            setLoading(false);
        }
    };

    // Keyboards this origin already has permission for can be opened without the
    // chooser. Refresh the list whenever we are disconnected.
    useEffect(() => {
        if (isConnected) return;
        let cancelled = false;
        listPermittedDevices()
            .then((devices) => { if (!cancelled) setKnownDevices(devices); })
            .catch(() => { if (!cancelled) setKnownDevices([]); });
        return () => { cancelled = true; };
    }, [isConnected]);

    const handleConnectDevice = async (device: HIDDevice) => {
        setLoading(true);
        setError(null);
        try {
            await connectDevice(device);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error occurred");
        } finally {
            setLoading(false);
        }
    };

    const handleDisconnect = async () => {
        setLoading(true);
        setIsDisconnecting(true);
        setError(null);
        try {
            await disconnect();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error occurred");
        } finally {
            setLoading(false);
            setIsDisconnecting(false);
        }
    };

    const handleLoadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setLoading(true);
        setError(null);
        try {
            await loadFromFile(file);
        } catch (err) {
            if (err instanceof Error) {
                if (err.message === "Invalid JSON") {
                    setError("Invalid JSON");
                } else if (err.message === "Invalid file") {
                    setError("Invalid file");
                } else if (err.message === "File too large") {
                    setError("File too large (max 1MB)");
                } else {
                    setError(err.message);
                }
            } else {
                setError(String(err));
            }
        } finally {
            setLoading(false);
            // Reset input so same file can be selected again
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        }
    };

    const handleLoadDemo = async (choice: DemoChoice = "qwerty") => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(demoLayoutUrl);
            if (!response.ok) throw new Error("Failed to fetch demo file");
            // ?demo=combos: the same layout with a few combos, tap dances and macros.
            // Read as text (the layout is JSON), so the file is built from a string on every runtime.
            const text = await response.text();
            // The bundled file's real name; in Keybard Paranoid the URL is a data: URL.
            const filename = "sval-default.svil";
            const file = new File([choice === "combos" ? withDemoFeatures(text) : text], filename, { type: "application/octet-stream" });
            await loadFromFile(file, "demo");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load demo");
        } finally {
            setLoading(false);
        }
    };

    // ?demo / ?demo=combos (review links): load the example on start, once per page load.
    useEffect(() => {
        const demo = demoFromSearch(window.location.search);
        if (!demo || isConnected || !claimDemoStart()) return;
        void handleLoadDemo(demo);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
        <div className="h-full flex flex-col justify-center">
            <div className="flex flex-col items-center mb-2">
                <div className="flex flex-row items-center gap-4">
                    <svg width="30" height="30" viewBox="0 0 29 29" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                            d="M5.7998 0.884241V3.46595C5.7998 3.95425 6.1146 4.3501 6.50293 4.3501L22.4967 4.3501C22.885 4.3501 23.1998 3.95425 23.1998 3.46595V0.884241C23.1998 0.395941 22.885 9.58443e-05 22.4967 9.58443e-05L6.50293 9.58443e-05C6.1146 9.58443e-05 5.7998 0.395941 5.7998 0.884241Z"
                            className="fill-kb-ink"
                        ></path>
                        <path
                            d="M28.1162 5.7998H25.5345C25.0462 5.7998 24.6504 6.1146 24.6504 6.50293V22.4967C24.6504 22.885 25.0462 23.1998 25.5345 23.1998H28.1162C28.6045 23.1998 29.0004 22.885 29.0004 22.4967V6.50293C29.0004 6.1146 28.6045 5.7998 28.1162 5.7998Z"
                            className="fill-kb-ink"
                        ></path>
                        <path
                            d="M3.46585 5.7998H0.884147C0.395846 5.7998 0 6.1146 0 6.50293V22.4967C0 22.885 0.395846 23.1998 0.884147 23.1998H3.46585C3.95416 23.1998 4.35 22.885 4.35 22.4967V6.50293C4.35 6.1146 3.95416 5.7998 3.46585 5.7998Z"
                            className="fill-kb-ink"
                        ></path>
                        <path
                            d="M5.7998 25.5341V28.1159C5.7998 28.6042 6.1146 29 6.50293 29H22.4967C22.885 29 23.1998 28.6042 23.1998 28.1159V25.5341C23.1998 25.0458 22.885 24.65 22.4967 24.65H6.50293C6.1146 24.65 5.7998 25.0458 5.7998 25.5341Z"
                            className="fill-kb-ink"
                        ></path>
                        <path
                            d="M14.5 21.75C18.5041 21.75 21.75 18.5041 21.75 14.5C21.75 10.4959 18.5041 7.25 14.5 7.25C10.4959 7.25 7.25 10.4959 7.25 14.5C7.25 18.5041 10.4959 21.75 14.5 21.75Z"
                            className="fill-kb-ink"
                        ></path>
                    </svg>
                    <KeybardLogo className="!h-[32px] !w-auto" />
                </div>
            </div>
            <div className="p-10 max-w-xl mx-auto rounded-md border-dashed border-1 border-gray-300 dark:border-neutral-600">
                {!isWebHIDSupported && (
                    <div className="browser-not-supported">
                        <h2>Browser Not Supported</h2>
                        <p className="error-message">⚠️ Your browser does not support WebHID API, which is required for connecting to your keyboard.</p>
                        <p>Please use one of the following browsers:</p>
                        <ul>
                            <li>Google Chrome (version 89+)</li>
                            <li>Microsoft Edge (version 89+)</li>
                            <li>Opera (version 75+)</li>
                            <li>Brave</li>
                        </ul>
                        <p>Note: Firefox and Safari do not currently support WebHID.</p>
                    </div>
                )}
                    <>
                        <div className="flex flex-col gap-2 w-50 mx-auto">
                            {!isConnected || (loading && !isDisconnecting) ? (
                                <button
                                    ref={connectButtonRef}
                                    onClick={handleConnect}
                                    disabled={!isWebHIDSupported || loading || connectionState === "loading"}
                                    className="flex items-center justify-center gap-2 text-sm font-medium cursor-pointer transition-all bg-kb-primary text-white hover:bg-kb-primary/90 px-5 py-1.5 rounded-full w-full"
                                >
                                    {loading || connectionState === "loading" ? <><PlugZap className="h-4 w-4" /><span>Connecting...</span></> : <><Unplug className="h-4 w-4" /><span>Connect Keyboard</span></>}
                                </button>
                            ) : (
                                <button
                                    onClick={handleDisconnect}
                                    disabled={loading || connectionState === "loading"}
                                    className="flex items-center justify-center gap-2 text-sm font-medium cursor-pointer transition-all bg-kb-primary text-white hover:bg-kb-primary/90 px-5 py-1.5 rounded-full w-full"
                                >
                                    {loading ? "Disconnecting..." : "Disconnect"}
                                </button>
                            )}
                            {!isConnected && !loading && knownDevices.length > 0 && (
                                <div className="flex flex-col gap-1" data-testid="known-devices">
                                    <span className="text-[11px] text-muted-foreground text-center">or reconnect without the chooser</span>
                                    {knownDevices.map((device, index) => (
                                        <button
                                            key={`${device.vendorId}:${device.productId}:${index}`}
                                            onClick={() => handleConnectDevice(device)}
                                            className="flex items-center justify-center gap-2 text-sm font-medium cursor-pointer transition-all bg-kb-gray-medium text-slate-700 dark:text-neutral-200 hover:bg-kb-surface dark:hover:bg-neutral-700 px-5 py-1.5 rounded-full w-full"
                                            data-testid="known-device"
                                        >
                                            <PlugZap className="h-4 w-4" />
                                            <span>{device.productName || `Keyboard ${device.productId.toString(16)}`}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                            {!(loading && !isDisconnecting) && (
                                <>
                                    <p className="text-sm font-bold text-center text-gray-700 dark:text-neutral-200 my-1">or</p>
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={loading || connectionState === "loading"}
                                        className="flex items-center justify-center gap-2 text-sm font-medium cursor-pointer transition-all bg-kb-active text-gray-200 dark:text-neutral-900 hover:bg-gray-800 dark:hover:bg-neutral-300 px-5 py-1.5 rounded-full w-full"
                                    >
                                        {loading ? "Loading..." : "Load File"}
                                    </button>
                                    <input ref={fileInputRef} type="file" accept=".svil,.viable,.vil,.json" style={{ display: "none" }} onChange={handleLoadFile} />
                                    <button
                                        onClick={() => handleLoadDemo()}
                                        disabled={loading || connectionState === "loading"}
                                        className="flex items-center justify-center gap-2 text-sm font-medium cursor-pointer transition-all bg-kb-gray text-kb-ink hover:bg-kb-gray-medium px-5 py-1.5 rounded-full w-full border border-gray-300 dark:border-neutral-500"
                                    >
                                        {loading ? "Loading..." : "QWERTY Example"}
                                    </button>
                                </>
                            )}
                        </div>
                    </>

                {!error && connectionFirmware ? (
                    <UnsupportedFirmwareCard info={connectionFirmware} className="mt-8" onConnect={() => void handleConnect()} />
                ) : (error || connectionError) && (
                    <div
                        className="mt-8 flex flex-row items-center justify-center gap-2 text-kb-red"
                        role="alert"
                    >
                        <AlertTriangle className="w-5 h-5" />
                        <p className="font-medium">{error || connectionError}</p>
                    </div>
                )}

                {!error && connectionFix && (
                    <div className="mt-3 w-full max-w-2xl text-left">
                        <div className="relative rounded-md border border-kb-gray-border bg-kb-gray">
                            <pre aria-label="udev rule commands" className="overflow-x-auto p-3 pr-10 font-mono text-xs text-kb-ink whitespace-pre">{connectionFix}</pre>
                            <button
                                type="button"
                                aria-label={fixCopied ? "Copied" : "Copy commands"}
                                title={fixCopied ? "Copied" : "Copy commands"}
                                onClick={() => {
                                    navigator.clipboard?.writeText(connectionFix).then(() => setFixCopied(true), () => setFixCopied(false));
                                }}
                                className="absolute right-2 top-2 rounded p-1 text-kb-ink hover:bg-kb-gray-medium cursor-pointer"
                            >
                                {fixCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ConnectKeyboard;
