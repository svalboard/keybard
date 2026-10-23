import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { SVALBOARD_FIRMWARE_URL } from "@/constants/firmware";
import { currentSite, releasesForSite } from "@/constants/firmware-releases";
import { ManualInstall } from "@/features/firmware/ManualInstall";
import { InFirmwareDialog } from "@/features/firmware/parts";
import type { Afterwards } from "@/services/updater/flow";
import { PARANOID } from "@/lib/paranoid";
import type { UnsupportedFirmwareInfo } from "@/utils/unsupported-firmware";
import { cn } from "@/lib/utils";

/** The firmware download. Keybard Paranoid can't open links, so it shows the address instead. */
export function FirmwareLink() {
    if (PARANOID) return <code className="select-all break-all font-mono text-xs">{SVALBOARD_FIRMWARE_URL}</code>;
    return (
        <a href={SVALBOARD_FIRMWARE_URL} target="_blank" rel="noreferrer" className="font-medium text-kb-primary underline">
            the latest Svalboard firmware release
        </a>
    );
}

/**
 * Install by hand (M), in its own dialog: the way onto firmware Keybard updates. Keybard
 * isn't connected here (it can't use this firmware), so Connect closes the dialog and the
 * connect screen takes over: the new firmware connects, the old one shows this card again.
 */
function ManualInstallButton({ fromVial, onConnect }: { fromVial: boolean; onConnect?: () => void }) {
    const [open, setOpen] = useState(false);
    const [afterwards, setAfterwards] = useState<Afterwards>("defaults");
    const release = releasesForSite(currentSite())[0] ?? null;
    return (
        <>
            <Button size="sm" variant="kb-primary" className="self-start" onClick={() => setOpen(true)}>Install by hand</Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-[480px]" onInteractOutside={(e) => e.preventDefault()} aria-describedby={undefined}>
                    <InFirmwareDialog.Provider value>
                        <ManualInstall
                            release={release}
                            once
                            backup={null}
                            afterwards={afterwards}
                            onAfterwards={setAfterwards}
                            onConnect={() => { setOpen(false); onConnect?.(); }}
                            onClose={() => setOpen(false)}
                        />
                        {fromVial && <p className="text-sm">Once Keybard connects, click <strong>Import Layout</strong> above the keyboard and choose your saved .vil file.</p>}
                    </InFirmwareDialog.Provider>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** Why the keyboard couldn't connect, and how to get it onto firmware Keybard can use. */
export function UnsupportedFirmwareCard({ info, className, onDismiss, onConnect }: { info: UnsupportedFirmwareInfo; className?: string; onDismiss?: () => void; onConnect?: () => void }) {
    let title: string;
    let body: React.ReactNode;
    switch (info.kind) {
        case "svalboard-vial":
            title = "Update your Svalboard's firmware";
            body = (
                <>
                    <p>
                        This Svalboard is running the old Vial firmware{info.reportedVersion && <> (<span className="font-mono">{info.reportedVersion}</span>)</>}. Keybard needs Svalboard QMK firmware.
                    </p>
                    <p>First keep your layout: in Vial, choose <strong>File &gt; Save current layout</strong> to save a .vil file.</p>
                    <ManualInstallButton fromVial onConnect={onConnect} />
                </>
            );
            break;
        case "outdated-sval":
            title = "Update your Svalboard's firmware";
            body = (
                <>
                    <p>This Svalboard runs a pre-release Svalboard QMK build (Sval protocol {info.svilProto ?? "?"}) that this Keybard can't edit safely.</p>
                    <ManualInstallButton fromVial={false} onConnect={onConnect} />
                </>
            );
            break;
        case "other-qmk":
            title = "Not a Svalboard firmware";
            body = <p>This keyboard doesn't run Svalboard firmware. Keybard only configures keyboards running Svalboard QMK; use VIA or Vial for this one.</p>;
            break;
        case "no-response":
            title = "The keyboard didn't respond";
            body = (
                <ol className="list-decimal space-y-1 pl-5">
                    <li>Close other apps that may be using the keyboard: Vial, VIA, or another Keybard tab or window.</li>
                    <li>Unplug the keyboard, plug it back in, and wait a few seconds.</li>
                    <li>Connect again.</li>
                </ol>
            );
            break;
        default:
            title = "Keyboard firmware not recognized";
            body = (
                <>
                    <p>The keyboard didn't answer like Svalboard QMK firmware. If it is a Svalboard, it is probably still running the old Vial firmware. Save your layout in Vial first (<strong>File &gt; Save current layout</strong>).</p>
                    <ManualInstallButton fromVial onConnect={onConnect} />
                </>
            );
    }
    return (
        <div role="alert" aria-label={title} className={cn("rounded-md border border-kb-gray-border bg-kb-surface p-4 text-left text-sm text-kb-ink", className)}>
            <p className="mb-2 flex items-center gap-2 font-semibold text-kb-red">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="flex-1">{title}</span>
                {onDismiss && (
                    <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="rounded p-0.5 text-kb-ink hover:bg-kb-gray-medium cursor-pointer">
                        <X className="h-4 w-4" />
                    </button>
                )}
            </p>
            <div className="flex flex-col gap-2">{body}</div>
        </div>
    );
}
