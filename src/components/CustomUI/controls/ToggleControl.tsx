import OnOffToggle from "@/components/ui/OnOffToggle";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { cn } from "@/lib/utils";

interface ToggleControlProps {
    item: CustomUIMenuItem;
    value: number;
    onChange: (value: number) => void;
    compact?: boolean;
    /** Shown but grayed out and unusable (CustomUIMenuItem.disabledIf). */
    disabled?: boolean;
}

export const ToggleControl: React.FC<ToggleControlProps> = ({ item, value, onChange, compact = false, disabled = false }) => {
    return (
        <div className={cn(
            "flex flex-row items-center justify-between gap-2",
            compact ? "py-0.5" : "p-2 panel-layer-item"
        )} data-disabled={disabled || undefined}>
            <span title={item.description} className={cn(compact ? "text-xs" : "text-md", disabled && "text-muted-foreground")}>{item.label}</span>
            <OnOffToggle
                label={item.label}
                description={item.description}
                value={value === 1}
                onToggle={(newValue) => onChange(newValue ? 1 : 0)}
                className={compact ? "scale-75 origin-right" : ""}
                disabled={disabled}
            />
        </div>
    );
};
