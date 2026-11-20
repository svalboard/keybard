import type { ButtonHTMLAttributes } from "react";
import { Ban, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

/** neutral: outlined; on: filled with a plus; off: warning colors, a "no" mark and struck through. */
export type LayerPillState = "neutral" | "on" | "off";

/**
 * A layer as a clickable pill: the Auto Mouse layer pills and the app rule layer masks.
 * Each state reads without color too (icon, strike-through).
 */
export function LayerPill({ name, state, className, ...props }: { name: string; state: LayerPillState } & ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            type="button"
            data-state={state}
            {...props}
            className={cn(
                "inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kb-ink",
                state === "off" && "border-kb-warn-ink bg-kb-warn-bg text-kb-warn-ink hover:brightness-95",
                state === "on" && "border-kb-active bg-kb-active text-kb-active-fg hover:brightness-95",
                state === "neutral" && "border-kb-gray-border bg-transparent text-kb-ink hover:bg-kb-gray-border/40",
                className,
            )}
        >
            {state === "off" && <Ban className="h-3 w-3" aria-hidden />}
            {state === "on" && <Plus className="h-3 w-3" aria-hidden />}
            <span className={cn("select-none", state === "off" && "line-through")}>{name}</span>
        </button>
    );
}
