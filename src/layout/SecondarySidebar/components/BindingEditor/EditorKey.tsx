import { FC, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Key } from "@/components/Key";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { useLayer } from "@/contexts/LayerContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { getKeyContents } from "@/utils/keys";
import { getKeyDisplayLabel } from "@/utils/key-display";
import { keyService } from "@/services/key.service";
import { hoverBackgroundClasses, hoverBorderClasses } from "@/utils/colors";
import { DragItem, useDrag } from "@/contexts/DragContext";
import { DelayedTooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface EditorKeyProps {
    keycode: string;
    label?: string; // Additional label to display (e.g. "Output", "1", "2")
    selected?: boolean;
    onClick: () => void;
    onClear?: () => void;
    size?: string; // Class for size, e.g. "w-[60px] h-[60px]"
    trashOffset?: string; // Class for trash icon positioning e.g. "-left-10"
    trashSize?: string; // Class for trash icon size e.g. "w-4 h-4"
    variant?: "default" | "medium" | "small";
    labelClassName?: string; // Class for the label text
    wrapperClassName?: string; // Class for the wrapper div
    showTrash?: boolean; // Whether the trash icon is enabled (defaults to true if onClear is provided)
    onDrop?: (item: DragItem) => void;
    /**
     * Dropping a filled slot outside any drop target blanks it through
     * onClear, like a layout key dragged into blank space. Defaults to true;
     * turn it off where onClear removes more than the key (macro actions).
     */
    clearOnDragOff?: boolean;
    /** The clear button sits in the key's top-right corner, inside it (the compact editor bar). */
    trashCorner?: boolean;
    /** Key size in px when it differs from the variant's own (the bar's 40px keys). */
    unitSize?: number;
    // Context for swapping
    editorType?: string;
    editorId?: number | string;
    editorSlot?: number | string;
}

const EditorKey: FC<EditorKeyProps> = ({
    keycode,
    label,
    selected = false,
    onClick,
    onClear,
    size = "w-[60px] h-[60px]",
    trashOffset = "-left-10",
    trashSize = "w-4 h-4",
    variant = "default",
    labelClassName = "text-sm font-bold text-slate-600 dark:text-neutral-300",
    wrapperClassName = "flex flex-col items-center gap-1 relative",
    showTrash = true,
    onDrop,
    clearOnDragOff = true,
    trashCorner = false,
    unitSize,
    editorType,
    editorId,
    editorSlot
}) => {
    const { keyboard } = useKeyboard();
    const { selectedLayer } = useLayer();
    const { isDragging, draggedItem, markDropConsumed } = useDrag();
    const [isDragHover, setIsDragHover] = useState(false);
    // Read onClear at drop time, not at drag start, so it sees current state.
    const onClearRef = useRef(onClear);
    onClearRef.current = onClear;

    const layerColorName = keyboard?.cosmetic?.layer_colors?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];

    const keyContents = getKeyContents(keyboard!, keyService.canonical(keycode));
    const hasContent = (keyContents?.top && keyContents.top !== "KC_NO") ||
        (keyContents?.str && keyContents.str !== "KC_NO" && keyContents.str !== "");
    const clearSource = hasContent && clearOnDragOff && onClear
        ? () => onClearRef.current?.()
        : undefined;

    // Determine visual style
    let keyColor: string | undefined;
    let keyClassName: string;
    let headerClass: string;

    if (selected) {
        keyColor = undefined;
        keyClassName = "border-2 border-red-600";
        headerClass = "bg-black/20";
    } else if (isDragHover && isDragging && onDrop) {
        // Drag Hover State: Double Border effect
        keyColor = undefined;
        keyClassName = "bg-red-500 border-kb-key-border ring-2 ring-red-500 ring-offset-1 ring-offset-background";
        headerClass = "bg-red-600 text-white";
    } else if (hasContent) {
        keyColor = "sidebar";
        keyClassName = "border-kb-key-border";
        headerClass = "bg-kb-sidebar-dark";
    } else {
        keyColor = undefined;
        keyClassName = "bg-transparent border-2 border-kb-ink";
        headerClass = "text-kb-ink";
    }

    const handleMouseEnter = () => {
        if (isDragging && onDrop) {
            setIsDragHover(true);
        }
    };

    const handleMouseLeave = () => {
        setIsDragHover(false);
    };

    const handleMouseUp = () => {
        if (isDragging && isDragHover && draggedItem && onDrop) {
            markDropConsumed();
            onDrop(draggedItem);
            setIsDragHover(false);
        }
    };

    const { internationalLayout } = useLayoutSettings();
    const slotLabel = getKeyDisplayLabel(keycode, keyContents, internationalLayout);

    return (
        <div className={wrapperClassName}>
            {label && <span className={labelClassName}>{label}</span>}
            <div
                className={`relative ${size} group/editorkey`}
                data-editor-slot=""
                data-editor-slot-selected={selected ? "" : undefined}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onMouseUp={handleMouseUp}
            >
                <Key
                    isRelative
                    x={0} y={0} w={1} h={1} row={-1} col={-1}
                    keycode={keycode || "KC_NO"}
                    label={slotLabel}
                    keyContents={keyContents}
                    selected={selected}
                    onClick={() => {
                        onClick();
                    }}
                    layerColor={keyColor}
                    className={keyClassName}
                    headerClassName={headerClass}
                    hoverBorderColor={hoverBorderColor}
                    hoverBackgroundColor={hoverBackgroundColor}
                    hoverLayerColor={layerColorName}
                    variant={variant}
                    unitSize={unitSize}
                    disableTooltip={true}
                    disableHover={isDragging}
                    dragItemData={{
                        editorType,
                        editorId,
                        editorSlot,
                        clearSource
                    }}
                />

                {hasContent && showTrash && onClear && (
                    <div className={`absolute ${trashCorner ? "top-0.5 right-0.5" : `${trashOffset} top-1/2 -translate-y-1/2`} flex items-center justify-center opacity-0 group-hover/editorkey:opacity-100 focus-within:opacity-100 transition-opacity z-10`}>
                        <DelayedTooltip>
                            <TooltipTrigger asChild>
                                <button
                                    aria-label="Clear key"
                                    className={`${trashCorner ? "p-0.5" : "p-1.5"} text-gray-400 dark:text-neutral-400 hover:bg-red-500 hover:text-white rounded-full bg-kb-gray-medium`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onClear();
                                    }}
                                    type="button"
                                >
                                    <Trash2 className={trashCorner ? "w-3 h-3" : trashSize} />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>Clear key</p>
                            </TooltipContent>
                        </DelayedTooltip>
                    </div>
                )}
            </div>
        </div>
    );
};

export default EditorKey;
