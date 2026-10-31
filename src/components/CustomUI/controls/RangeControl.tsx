import { useEffect, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { fromDisplay, roundedNote, storesExactly, toDisplay } from "@/utils/display-scale";

interface RangeControlProps {
    item: CustomUIMenuItem;
    value: number;
    onChange: (value: number) => void;
    compact?: boolean;
    /** Shown but grayed out and unusable (CustomUIMenuItem.disabledIf). */
    disabled?: boolean;
}

/**
 * The number box's width: the field's longest value (min or max, as shown)
 * plus room for the padding, border and the browser's spin buttons, never under 5 digits, so a value
 * is never cut off ("200(" for 2000).
 */
export function rangeInputWidth(min: number, max: number): string {
    const digits = Math.max(5, String(Math.trunc(min)).length, String(Math.trunc(max)).length);
    return `calc(${digits}ch + 3.25rem)`;
}

export const RangeControl: React.FC<RangeControlProps> = ({ item, value, onChange, compact = false, disabled = false }) => {
    // Options format: [min, max] or [min, max, step], in stored units. A displayScale
    // (for example 1000, stored seconds shown as ms) applies to what is shown and typed.
    const options = item.options as number[] | undefined;
    const scale = item.displayScale ?? 1;
    const storedMin = options?.[0] ?? 0;
    const storedMax = options?.[1] ?? 255;
    const storedStep = options?.[2] ?? 1;
    const min = toDisplay(storedMin, scale);
    const max = toDisplay(storedMax, scale);
    const step = toDisplay(storedStep, scale);
    const shown = toDisplay(value, scale);

    const [draft, setDraft] = useState(String(shown));
    const [note, setNote] = useState<string | null>(null);
    useEffect(() => { setDraft(String(shown)); }, [shown]);
    const commit = (raw: string) => {
        if (!raw.trim() || !Number.isFinite(Number(raw))) { setDraft(String(shown)); return; }
        const typed = Math.max(min, Math.min(max, Number(raw)));
        const stored = Math.max(storedMin, Math.min(storedMax, Math.round(fromDisplay(typed, scale) / storedStep) * storedStep));
        setNote(storesExactly(typed, step) ? null : roundedNote(stored, scale));
        setDraft(String(toDisplay(stored, scale)));
        if (stored !== value) onChange(stored);
    };
    const width = { width: rangeInputWidth(min, max) };
    const roundedLine = note && scale > 1 ? <span className="text-xs text-muted-foreground" data-range-rounded>{note}</span> : null;
    const input = (className: string) => (
        <Input
            type="number"
            aria-label={item.label}
            aria-description={item.description}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setNote(null); }}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === "Escape") { e.currentTarget.value = String(shown); setDraft(String(shown)); e.currentTarget.blur(); }
                if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={className}
            style={width}
            disabled={disabled}
            min={min}
            max={max}
            step={step}
            data-range-input
        />
    );

    if (compact) {
        // Compact: label on top, slider + input inline below
        return (
            <div className="flex flex-col gap-0.5 py-0.5" data-disabled={disabled || undefined}>
                <span title={item.description} className={disabled ? "text-xs text-muted-foreground" : "text-xs"}>{item.label}</span>
                <div className="flex flex-row items-center gap-1.5">
                    <Slider
                        aria-label={item.label}
                        aria-description={item.description}
                        value={[Number(draft) || min]}
                        onValueChange={(values) => setDraft(String(values[0]))}
                        onValueCommit={(values) => commit(String(values[0]))}
                        min={min}
                        max={max}
                        step={step}
                        disabled={disabled}
                        className="w-20"
                    />
                    {input("h-6 text-xs text-right px-1 shrink-0")}
                </div>
                {roundedLine}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2 p-2 panel-layer-item" data-disabled={disabled || undefined}>
            <span title={item.description} className={disabled ? "text-md text-muted-foreground" : "text-md"}>{item.label}</span>
            <div className="flex flex-row items-center gap-3">
                <Slider
                    aria-label={item.label}
                    aria-description={item.description}
                    value={[Number(draft) || min]}
                    onValueChange={(values) => setDraft(String(values[0]))}
                    onValueCommit={(values) => commit(String(values[0]))}
                    min={min}
                    max={max}
                    step={step}
                    disabled={disabled}
                    className="flex-grow"
                />
                {input("text-right shrink-0")}
            </div>
            {roundedLine}
        </div>
    );
};
