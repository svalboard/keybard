// The failure screens (update-flow 8). Each says what happened to the keyboard; its
// buttons are the exact next step.

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { FwTitle } from "./parts";
import type { Failure, FailureId } from "@/services/updater/flow";
import { handName, type Hand } from "@/services/updater/protocol";

export type FailureAction = "retry" | "close" | "reload" | "finish" | "manual" | "download" | "keep-waiting" | "copy-command" | "reconnect" | "backups" | "keep-defaults";

const half = (h: Hand | undefined) => (h === undefined ? "One half" : `${handName(h) === "left" ? "Left" : "Right"} half`);

interface FailureCopy {
    title: string;
    body: ReactNode;
    actions: Array<{ action: FailureAction; label: string; primary?: boolean }>;
}

/** Title, one line and buttons for a failure, filled in from what's known. */
export function failureCopy(f: Failure, o: { fromTag?: string; udevCommand?: string } = {}): FailureCopy {
    const tags = f.tags ?? {};
    const runs = o.fromTag ?? tags[1] ?? tags[0];
    const both = tags[0] !== undefined && tags[1] !== undefined ? `Left half ${tags[0]} · Right half ${tags[1]}` : "";
    const table: Record<FailureId, FailureCopy> = {
        F2: { title: "Firmware file failed its check", body: "Keybard won't install it. Reload Keybard and try again.", actions: [{ action: "reload", label: "Reload", primary: true }, { action: "close", label: "Close" }] },
        F3: { title: "Another app is using the keyboard", body: "Close other Keybard tabs and the overlay, then try again.", actions: [{ action: "retry", label: "Try again", primary: true }] },
        F4: { title: "The keys weren't pressed in time", body: "Nothing was changed. Try again, and press the two keys when Keybard asks.", actions: [{ action: "retry", label: "Try again", primary: true }, { action: "close", label: "Close" }] },
        // Only where Keybard knows nothing was installed: before any COMMIT, or the half came back on its old firmware.
        F5: { title: "Update stopped", body: <>{f.detail && <p>{f.detail}</p>}<p>{runs ? `Nothing was changed: your keyboard still runs ${runs}.` : "Nothing was changed."}</p></>, actions: [{ action: "retry", label: "Try again", primary: true }, { action: "close", label: "Close" }] },
        F6: { title: "Update didn't finish", body: "Nothing was changed.", actions: [{ action: "retry", label: "Try again", primary: true }, { action: "close", label: "Close" }] },
        F9: { title: "Halves differ", body: f.detail ? <>{both && <p>{both}</p>}<p>{f.detail}</p></> : both || "The halves run different firmware.", actions: [{ action: "finish", label: "Finish update", primary: true }] },
        F10: { title: `${half(f.hand)} needs its firmware installed by hand`, body: "A drive named RPI-RP2 opened.", actions: [{ action: "download", label: "Download the firmware file", primary: true }, { action: "manual", label: "Install by hand" }] },
        F11: { title: `${half(f.hand)} needs its firmware installed by hand`, body: `Plug the USB cable into the ${handName(f.hand ?? 0)} half's U port. It opens as a drive named RPI-RP2.`, actions: [{ action: "download", label: "Download the firmware file", primary: true }, { action: "manual", label: "Install by hand" }] },
        F12: { title: "Linux blocked the keyboard", body: "Run this command, then reconnect.", actions: [{ action: "copy-command", label: "Copy command" }, { action: "reconnect", label: "Reconnect", primary: true }] },
        F14: { title: "Keyboard didn't come back", body: `If a drive named RPI-RP2 opened, the ${handName(f.hand ?? 1)} half needs its firmware installed by hand.`, actions: [{ action: "keep-waiting", label: "Keep waiting", primary: true }, { action: "manual", label: "Install by hand" }] },
        F16: { title: "Layout not fully put back", body: <>{f.detail && <p>{f.detail}</p>}<p>Your backup is safe in Backups and Downloads.</p></>, actions: [{ action: "retry", label: "Try again", primary: true }, { action: "backups", label: "Open Backups" }, { action: "keep-defaults", label: "Keep defaults" }] },
        F17: { title: "Your keyboard can't save its layout", body: "Updates from Keybard are off until this is fixed.", actions: [{ action: "manual", label: "Install by hand" }, { action: "close", label: "Close", primary: true }] },
        F18: { title: "This keyboard installs firmware by hand", body: "", actions: [{ action: "manual", label: "Install by hand", primary: true }] },
        F19: { title: "This Keybard can't configure this firmware", body: "Reload Keybard to get a newer one.", actions: [{ action: "reload", label: "Reload", primary: true }] },
        F20: { title: "Keyboard not wiped", body: f.detail ?? "The new firmware is installed.", actions: [{ action: "retry", label: "Try again", primary: true }, { action: "close", label: "Close" }] },
        F22: { title: "Set which half is which", body: <>{f.detail && <p>{f.detail}</p>}<p>The new firmware is installed. Neither half types until each half knows its side.</p></>, actions: [{ action: "retry", label: "Set the sides", primary: true }, { action: "close", label: "Close" }] },
        // After a COMMIT, when the keyboard never said which firmware it runs: no claim either way.
        F23: { title: "Keybard couldn't confirm the update", body: "The keyboard didn't say which firmware it runs now. Close this, and the Firmware card reads it again.", actions: [{ action: "close", label: "Close", primary: true }] },
        F21: { title: "Layout not reset", body: f.detail ?? "The new firmware is installed.", actions: [{ action: "retry", label: "Try again", primary: true }, { action: "close", label: "Close" }] },
    };
    const copy = table[f.id];
    if (f.id === "F12" && o.udevCommand) copy.body = <>{copy.body}<code className="mt-2 block select-all break-all rounded bg-kb-gray-medium p-2 font-mono text-xs">{o.udevCommand}</code></>;
    return copy;
}

export function FailureView({ failure, onAction, fromTag, udevCommand }: { failure: Failure; onAction: (a: FailureAction) => void; fromTag?: string; udevCommand?: string }) {
    const copy = failureCopy(failure, { fromTag, udevCommand });
    return (
        <div role="alert" aria-label={copy.title} data-failure={failure.id} className="flex flex-col gap-3">
            <FwTitle><AlertTriangle className="mr-2 inline h-5 w-5 shrink-0 align-[-3px] text-kb-red" aria-hidden />{copy.title}</FwTitle>
            {copy.body && <div className="text-sm text-kb-ink">{copy.body}</div>}
            <div className="flex flex-wrap justify-end gap-2">
                {copy.actions.map((a) => (
                    <Button key={a.action} variant={a.primary ? "kb-primary" : "outline"} onClick={() => onAction(a.action)}>{a.label}</Button>
                ))}
            </div>
        </div>
    );
}
