import React, { useCallback, useEffect, useRef, useState } from "react";
import OnOffToggle from "@/components/ui/OnOffToggle";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { DEBUG_CONSOLE_OFF, DEBUG_CONSOLE_ON, DEBUG_CONSOLE_READ } from "@/services/debug-console";
import { keyboardService } from "@/services/keyboard.service";
import { cn } from "@/lib/utils";
import { ROW_GRID, RowText } from "./SettingRow";

export const DEBUG_CONSOLE_LABEL = "Debug console";
export const DEBUG_CONSOLE_DESCRIPTION = "Lasts until the board is unplugged.";

/**
 * The board's debug console (Sval 0x3E): Off or On. Each change goes to the
 * board at once, whether Live Updating is on or not, and the row then shows
 * what the board reads back. Shown only on firmware that has the command.
 */
const DebugConsoleRow: React.FC<{ highlight?: (text: string) => React.ReactNode }> = ({ highlight }) => {
    const { keyboard, isConnected } = useKeyboard();
    const supported = isConnected && keyboardService.hasDebugConsole(keyboard);
    const [on, setOn] = useState<boolean | null>(null);
    const [failed, setFailed] = useState(false);
    const busy = useRef(false);

    // What the board says now: read when the row appears and after every change.
    const readBack = useCallback(async (): Promise<boolean | null> => {
        const reply = await keyboardService.debugConsole(DEBUG_CONSOLE_READ).catch(() => null);
        return reply && reply.ok ? reply.on : null;
    }, []);

    useEffect(() => {
        if (!supported) return;
        let live = true;
        setOn(null);
        setFailed(false);
        readBack().then((value) => {
            if (!live) return;
            setOn(value ?? false);
            setFailed(value === null);
        });
        return () => { live = false; };
    }, [supported, keyboard, readBack]);

    const change = async (value: boolean) => {
        if (busy.current) return;
        busy.current = true;
        try {
            await keyboardService.debugConsole(value ? DEBUG_CONSOLE_ON : DEBUG_CONSOLE_OFF).catch(() => null);
            const now = await readBack();
            setOn(now ?? on);
            setFailed(now !== value);
        } finally {
            busy.current = false;
        }
    };

    if (!supported) return null;
    return (
        <div data-debug-console>
            <div className={cn(ROW_GRID, "px-3 py-2.5")}>
                <RowText label={DEBUG_CONSOLE_LABEL} description={DEBUG_CONSOLE_DESCRIPTION} highlight={highlight} />
                <div className="flex justify-end min-w-0" data-debug-console-state={on === null ? "reading" : on ? "on" : "off"}>
                    <OnOffToggle label={DEBUG_CONSOLE_LABEL} description={DEBUG_CONSOLE_DESCRIPTION} value={on === true} onToggle={change} />
                </div>
            </div>
            {failed && (
                <p role="alert" className="px-3 pb-2.5 text-xs text-kb-warn-ink">The board didn't confirm the change. Try again.</p>
            )}
        </div>
    );
};

export default DebugConsoleRow;
