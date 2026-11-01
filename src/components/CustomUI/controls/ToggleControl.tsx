import OnOffToggle from "@/components/ui/OnOffToggle";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { cn } from "@/lib/utils";

interface ToggleControlProps {
    item: CustomUIMenuItem;
    value: number;
    onChange: (value: number) => void;
    compact?: boolean;
}

export const ToggleControl: React.FC<ToggleControlProps> = ({ item, value, onChange, compact = false }) => {
    return (
        <div className={cn(
            "flex flex-row items-center justify-between gap-2",
            compact ? "py-0.5" : "p-2 panel-layer-item"
        )}>
            <span title={item.description} className={compact ? "text-xs" : "text-md"}>{item.label}</span>
            <OnOffToggle
                label={item.label}
                description={item.description}
                value={value === 1}
                onToggle={(newValue) => onChange(newValue ? 1 : 0)}
                className={compact ? "scale-75 origin-right" : ""}
            />
        </div>
    );
};
