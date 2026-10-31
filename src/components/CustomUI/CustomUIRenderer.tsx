import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { CustomUIControl } from "./controls";
import { evaluateShowIf } from "@/utils/show-if-evaluator";

interface CustomUIRendererProps {
    items: CustomUIMenuItem[];
    values: Map<string, number>;
    onValueChange: (key: string, value: number) => void;
    onButtonClick?: (key: string) => void;
    /** When true, renders controls in a horizontal flow layout */
    horizontal?: boolean;
    /** When true, renders controls in a compact size (less padding, smaller text) */
    compact?: boolean;
}

/**
 * Recursively renders a menu structure into UI controls
 * Handles nested sections and conditional visibility via showIf
 */
export const CustomUIRenderer: React.FC<CustomUIRendererProps> = ({
    items,
    values,
    onValueChange,
    onButtonClick,
    horizontal = false,
    compact = false,
}) => {
    if (!items || !Array.isArray(items)) {
        return null;
    }

    // Container classes based on orientation and compactness
    const containerClasses = horizontal
        ? compact
            ? "flex flex-wrap gap-x-4 gap-y-1 items-start"
            : "flex flex-wrap gap-4 items-start"
        : "space-y-2";

    // Section classes based on orientation
    const sectionClasses = horizontal
        ? compact
            ? "flex flex-col gap-0.5 min-w-[140px] bg-muted/30 rounded px-2 py-1"
            : "flex flex-col gap-1 min-w-[180px]"
        : "flex flex-col gap-1 mb-2";

    // Section label classes
    const sectionLabelClasses = compact
        ? "text-xs font-semibold text-muted-foreground uppercase tracking-wide py-0.5"
        : "font-semibold text-lg text-slate-700 dark:text-neutral-200";

    return (
        <div className={containerClasses}>
            {items.map((item, index) => {
                // Check showIf conditional visibility
                if (item.showIf && !evaluateShowIf(item.showIf, values)) {
                    return null;
                }

                // Determine if this is a section (nested content) or a leaf control
                const isSection = isNestedContent(item.content);

                if (isSection) {
                    // Render section with label and nested items
                    return (
                        <div key={index} className={sectionClasses}>
                            {item.label && (
                                <h3 className={sectionLabelClasses}>
                                    {item.label}
                                </h3>
                            )}
                            {item.note && (
                                <p className={compact ? "text-xs text-muted-foreground max-w-[280px]" : "text-sm text-muted-foreground"}>
                                    {item.note}
                                </p>
                            )}
                            <CustomUIRenderer
                                items={item.content as CustomUIMenuItem[]}
                                values={values}
                                onValueChange={onValueChange}
                                onButtonClick={onButtonClick}
                                horizontal={horizontal}
                                compact={compact}
                            />
                        </div>
                    );
                }

                // Render leaf control
                return (
                    <CustomUIControl
                        key={index}
                        item={item}
                        values={values}
                        onValueChange={onValueChange}
                        onButtonClick={onButtonClick}
                        compact={compact}
                    />
                );
            })}
        </div>
    );
};

/**
 * Check if content is an array of nested menu items (vs a value reference array)
 */
function isNestedContent(content: CustomUIMenuItem['content']): content is CustomUIMenuItem[] {
    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }
    // Value reference arrays have a string as first element (the key)
    // Nested content arrays have objects as elements
    return typeof content[0] === 'object' && content[0] !== null;
}
