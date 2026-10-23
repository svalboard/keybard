// What happens to the layout after a reflash: put it back (the default: back up, install,
// put it back), start from the firmware's default layout, or start from a blank keyboard
// (every key empty on every layer, nothing else set; no backup needed).

import { useId } from "react";

import type { Afterwards } from "@/services/updater/flow";

export const LAYOUT_CHOICES: Array<{ value: Afterwards; label: string }> = [
    { value: "restore", label: "Restore my layout" },
    { value: "defaults", label: "Start from the default layout" },
    { value: "blank", label: "Start from a blank keyboard" },
];

export interface LayoutChoiceProps {
    value: Afterwards;
    onChange: (value: Afterwards) => void;
    /** Restore my layout needs a backup: off until it's saved, and after it failed. */
    keepDisabled: boolean;
    /** The choices offered (an install by hand can't clear the keyboard: it has no updater to ask). */
    choices?: Afterwards[];
    /** The group's accessible name. */
    label?: string;
}

export function LayoutChoice({ value, onChange, keepDisabled, choices = ["restore", "defaults", "blank"], label = "After the update" }: LayoutChoiceProps) {
    const group = useId();
    return (
        <div role="radiogroup" aria-label={label} className="flex flex-col gap-1" data-testid="layout-choice">
            {LAYOUT_CHOICES.filter((c) => choices.includes(c.value)).map((c) => {
                const disabled = c.value === "restore" && keepDisabled;
                return (
                    <label key={c.value} className={`flex items-center gap-2.5 text-sm ${disabled ? "text-muted-foreground" : "cursor-pointer"}`}>
                        <input type="radio" className="h-4 w-4 accent-kb-primary" name={group} value={c.value} checked={value === c.value} disabled={disabled} onChange={() => onChange(c.value)} />
                        {c.label}
                    </label>
                );
            })}
        </div>
    );
}
