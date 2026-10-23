import React, { useEffect, useRef } from "react";
import { FirmwareSection } from "@/features/firmware/FirmwareSection";
import { useFirmwareUpdates } from "@/features/firmware/FirmwareUpdateProvider";
import { describeFirmware } from "@/constants/firmware";
import { useKeyboard } from "@/contexts/KeyboardContext";

/**
 * Settings > Firmware: what the board runs, and the way into an install (the sheet, the
 * progress, the result). The update itself runs in FirmwareUpdateProvider, so its dialog
 * outlives this page.
 */
const FirmwareRow: React.FC = () => {
    const updates = useFirmwareUpdates();
    const { keyboard, isConnected } = useKeyboard();
    const markSeen = updates?.status.markSeen;
    const dot = updates?.status.dot;

    // Opening Firmware is seeing the update: the rail dot goes for this release.
    useEffect(() => { if (dot) markSeen?.(); }, [dot, markSeen]);

    // Opening the card reads the board again, so what it shows is never stale (once per
    // opening; a first read still running needs no second one).
    const recheck = updates?.recheck;
    const hasBoard = !!updates?.board;
    const rechecked = useRef(false);
    useEffect(() => {
        if (rechecked.current || !hasBoard || !recheck) return;
        rechecked.current = true;
        recheck();
    }, [hasBoard, recheck]);

    if (!updates) {
        // Outside the editor's provider (never in the app): what the board runs, no install.
        const running = keyboard && isConnected ? describeFirmware(keyboard) : null;
        return <p className="px-3 py-2.5 text-sm text-muted-foreground">{running ?? "Connect a keyboard to see its firmware."}</p>;
    }

    if (updates.reading) {
        return <p className="px-3 py-2.5 text-sm text-muted-foreground">Reading the keyboard's firmware…</p>;
    }

    return (
        <div className="px-3 py-3">
            <FirmwareSection
                board={updates.board}
                releases={updates.releases}
                onInstall={updates.install}
                onManual={updates.openManual}
                onConnect={updates.connect}
                sides={updates.sides}
                onRecheck={updates.recheck}
                checking={updates.checking}
                heading={false}
            />
        </div>
    );
};

export default FirmwareRow;
