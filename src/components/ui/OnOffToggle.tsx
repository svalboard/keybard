import { cn } from "@/lib/utils";
import { FC } from "react";

interface Props {
    value: boolean;
    onToggle: (newValue: boolean) => void;
    className?: string;
    label?: string;
    description?: string;
    /** "sm" for the compact editor bar. */
    size?: "default" | "sm";
}

const OnOffToggle: FC<Props> = ({ value, onToggle, className, label, description, size = "default" }) => {
    return (
        <div
            role="group"
            aria-label={label}
            aria-description={description}
            className={cn("flex flex-row items-center bg-gray-100 dark:bg-neutral-800 rounded-full p-0.5 w-fit border border-gray-200 dark:border-neutral-500", className)}
            onClick={(e) => e.stopPropagation()}
        >
            <button
                type="button"
                aria-pressed={value}
                onClick={(e) => {
                    e.stopPropagation();
                    if (!value) onToggle(true);
                }}
                className={cn(
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 py-1 text-[10px] uppercase tracking-wide rounded-full transition-all font-bold",
                    size === "sm" ? "px-2" : "px-3",
                    value
                        ? "bg-kb-active text-kb-active-fg shadow-sm"
                        : "text-gray-500 hover:text-kb-ink dark:text-neutral-400 dark:hover:text-kb-ink"
                )}
            >
                ON
            </button>
            <button
                type="button"
                aria-pressed={!value}
                onClick={(e) => {
                    e.stopPropagation();
                    if (value) onToggle(false);
                }}
                className={cn(
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 py-1 text-[10px] uppercase tracking-wide rounded-full transition-all font-bold",
                    size === "sm" ? "px-2" : "px-3",
                    !value
                        ? "bg-kb-active text-kb-active-fg shadow-sm"
                        : "text-gray-500 hover:text-kb-ink dark:text-neutral-400 dark:hover:text-kb-ink"
                )}
            >
                OFF
            </button>
        </div>
    );
};

export default OnOffToggle;
