import React, { useCallback, useEffect, useRef, useState } from "react";
import OnOffToggle from "@/components/ui/OnOffToggle";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { DEBUG_CONSOLE_OFF, DEBUG_CONSOLE_ON, DEBUG_CONSOLE_READ } from "@/services/debug-console";
import { keyboardService } from "@/services/keyboard.service";
import { cn } from "@/lib/utils";
import { ROW_GRID, RowText } from "./SettingRow";

export const DEBUG_CONSOLE_LABEL = "Debug console";
export const DEBUG_CONSOLE_DESCRIPTION = "Lasts until the board is unplugged.";
export const DEBUG_CONSOLE_READ_FAILED = "Couldn't read the debug console.";
export const DEBUG_CONSOLE_NOT_CONFIRMED = "The board didn't confirm the change. Try again.";

type Problem = "read" | "confirm" | null;

/**
 * The board's debug console (Sval 0x3E): Off or On. Each change goes to the
 * board at once, whether Live Updating is on or not, and the row then shows
 * what the board reads back. Shown only on firmware that has the command.
 */
const DebugConsoleRow: React.FC<{ highlight?: (text: string) => React.ReactNode }> = ({ highlight }) => {
    const { keyboard, isConnected } = useKeyboard();
    const supported = isConnected && keyboardService.hasDebugConsole(keyboard);
    // null: not known (still reading, or the board didn't answer).
    const [on, setOn] = useState<boolean | null>(null);
    const [reading, setReading] = useState(true);
    const [problem, setProblem] = useState<Problem>(null);
    const busy = useRef(false);
    // Bumped for every board (and on unmount): a reply for an earlier board is dropped.
    const generation = useRef(0);

    // What the board says now; null when it didn't answer.
    const readBack = useCallback(async (): Promise<boolean | null> => {
        const reply = await keyboardService.debugConsole(DEBUG_CONSOLE_READ).catch(() => null);
        return reply && reply.ok ? reply.on : null;
    }, []);

    useEffect(() => {
        const mine = ++generation.current;
        busy.current = false;
        if (!supported) return;
        setOn(null);
        setReading(true);
        setProblem(null);
        readBack().then((value) => {
            if (generation.current !== mine) return;
            setOn(value);
            setReading(false);
            setProblem(value === null ? "read" : null);
        });
        return () => { generation.current++; };
    }, [supported, keyboard, readBack]);

    const change = async (value: boolean) => {
        if (busy.current) return;
        const mine = generation.current;
        busy.current = true;
        try {
            await keyboardService.debugConsole(value ? DEBUG_CONSOLE_ON : DEBUG_CONSOLE_OFF).catch(() => null);
            if (generation.current !== mine) return; // another board now
            const now = await readBack();
            if (generation.current !== mine) return;
            if (now === null) {
                setOn(null);
                setProblem("read");
            } else {
                setOn(now);
                setProblem(now === value ? null : "confirm");
            }
        } finally {
            if (generation.current === mine) busy.current = false;
        }
    };

    if (!supported) return null;
    const shown = reading ? "reading" : on === null ? "unknown" : on ? "on" : "off";
    return (
        <div data-debug-console>
            <div className={cn(ROW_GRID, "px-3 py-2.5")}>
                <RowText label={DEBUG_CONSOLE_LABEL} description={DEBUG_CONSOLE_DESCRIPTION} highlight={highlight} />
                <div className="flex justify-end min-w-0" data-debug-console-state={shown}>
                    <OnOffToggle label={DEBUG_CONSOLE_LABEL} description={DEBUG_CONSOLE_DESCRIPTION} value={on === true} unknown={on === null} onToggle={change} />
                </div>
            </div>
            {problem && (
                <p role="alert" className="px-3 pb-2.5 text-xs text-kb-warn-ink">
                    {problem === "read" ? DEBUG_CONSOLE_READ_FAILED : DEBUG_CONSOLE_NOT_CONFIRMED}
                </p>
            )}
        </div>
    );
};

export default DebugConsoleRow;
