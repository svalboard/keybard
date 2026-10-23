import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OPEN_FIRMWARE_EVENT, useBoardSummary } from "./useHalvesDiffer";
import type { BoardSummary } from "./board-summary";
import { useFirmwareUpdates, type SideFixControl } from "./FirmwareUpdateProvider";
import { SideFix, sideProblem } from "./SideFix";

/** One-image firmware: a half without a side, or two on the same side. Keys are off until it's fixed. */
export function SidesBannerView({ board, control }: { board: BoardSummary; control?: SideFixControl }) {
    if (!board.sides) return null;
    return (
        <div role="alert" aria-label="Set which half is which" data-testid="sides-banner" className="flex flex-col gap-2 whitespace-normal rounded-md border border-kb-gray-border bg-kb-surface p-3 text-sm text-kb-ink shadow-sm">
            <SideFix sides={board.sides} busy={control?.busy} note={control?.note} onApply={(w) => control?.apply(w)} />
        </div>
    );
}

/** F9 on any connect: the halves run different firmware. The one firmware message that interrupts. */
export function HalvesDifferView({ board, onFinish }: { board: BoardSummary; onFinish: () => void }) {
    const line = board.halves.map((h) => `${h.hand === 0 ? "Left" : "Right"} half ${h.answered ? h.tag : "not answering"}`).join(" · ");
    return (
        <div role="alert" aria-label="Halves differ" className="flex flex-col gap-2 whitespace-normal rounded-md border border-kb-gray-border bg-kb-surface p-3 text-sm text-kb-ink shadow-sm">
            <p className="flex items-center gap-2 font-semibold text-kb-orange"><AlertTriangle className="h-4 w-4" aria-hidden />Halves differ</p>
            <p>{line}</p>
            <Button size="sm" variant="kb-primary" className="self-start" onClick={onFinish}>Finish update</Button>
        </div>
    );
}

export function HalvesDifferBanner() {
    const updates = useFirmwareUpdates();
    const own = useBoardSummary();
    const board = updates?.board ?? own;
    if (board?.sides && sideProblem(board.sides)) return <SidesBannerView board={board} control={updates?.sides} />;
    if (!board?.updater || !board.differ) return null;
    return <HalvesDifferView board={board} onFinish={() => window.dispatchEvent(new CustomEvent(OPEN_FIRMWARE_EVENT))} />;
}
