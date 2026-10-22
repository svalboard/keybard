import React from "react";
import { Plus } from "lucide-react";
import { Key } from "@/components/Key";

import SidebarItemRow from "@/layout/SecondarySidebar/components/SidebarItemRow";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { useLayer } from "@/contexts/LayerContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { usePanels } from "@/contexts/PanelsContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { hoverBackgroundClasses, hoverBorderClasses, hoverHeaderClasses } from "@/utils/colors";
import { getKeyContents } from "@/utils/keys";
import { getKeyDisplayLabel } from "@/utils/key-display";
import { KeyContent } from "@/types/keyboard.types";
import DescriptionBlock from "@/layout/SecondarySidebar/components/DescriptionBlock";

interface Props {
    /** Shown as a binding editor's picker: a click puts TD(n) in the slot and never opens another editor. */
    isPicker?: boolean;
}

const TapdancePanel: React.FC<Props> = ({ isPicker = false }) => {
    const { keyboard } = useKeyboard();
    const { assignKeycode } = useKeyBinding();
    const { selectedLayer } = useLayer();
    const { layoutMode, internationalLayout } = useLayoutSettings();
    const {
        setItemToEdit,
        setBindingTypeToEdit,
        setAlternativeHeader,
        setInitialEditorSlot,
    } = usePanels();

    const isHorizontal = layoutMode === "bottombar";

    if (!keyboard) return null;

    const layerColorName = keyboard?.cosmetic?.layer_colors?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];
    const hoverHeaderClass = hoverHeaderClasses[layerColorName] || hoverHeaderClasses["primary"];

    const tapdances = keyboard.tapdances || [];

    const handleEdit = (index: number, slot?: string) => {
        setItemToEdit(index);
        setBindingTypeToEdit("tapdances");
        setAlternativeHeader(true);
        if (slot) {
            setInitialEditorSlot(slot);
        }
    };

    // Shared small key renderer
    const renderSmallKey = (keycode: string, content: KeyContent, idx: number, tdIndex: number, slotName: string) => {
        const hasContent =
            (content?.top && content?.top !== "KC_NO") ||
            (content?.str && content?.str !== "" && content?.str !== "KC_NO");

        const label = getKeyDisplayLabel(keycode, content, internationalLayout);

        return (
            <div className="w-[30px] h-[30px] relative" key={idx}>
                <Key
                    isRelative
                    x={0}
                    y={0}
                    w={1}
                    h={1}
                    row={-1}
                    col={-1}
                    keycode={keycode || "KC_NO"}
                    label={label}
                    keyContents={content}
                    variant="small"
                    layerColor={hasContent ? "sidebar" : undefined}
                    className={
                        !hasContent ? "bg-transparent border border-kb-gray-border" : "border-kb-key-border"
                    }
                    headerClassName={!hasContent ? "hidden" : "bg-kb-sidebar-dark"}
                    onClick={isPicker ? () => assignKeycode(`TD(${tdIndex})`) : () => handleEdit(tdIndex, slotName)}
                    disableTooltip={true}
                />
            </div>
        );
    };

    const emptyIndex = tapdances.findIndex(td =>
        [td?.tap, td?.hold, td?.taphold, td?.doubletap].every(key => !key || key === "KC_NO")
    );

    // Horizontal grid layout for bottom panel
    if (isHorizontal) {
        return (
            <div className="flex flex-row flex-wrap content-start gap-3 items-start pt-2">
                {tapdances.map((tdEntry, i) => {
                    const td = tdEntry || ({} as any);
                    const states = [
                        { label: "Tap", key: td.tap },
                        { label: "Hold", key: td.hold },
                        { label: "T-H", key: td.taphold },
                        { label: "Dbl", key: td.doubletap },
                    ];
                    const stateContents = states.map((s) => getKeyContents(keyboard, s.key) as KeyContent);
                    const hasAssignment = stateContents.some(
                        (k) => (k?.top && k.top !== "KC_NO") || (k?.str && k.str !== "KC_NO" && k.str !== "")
                    );

                    if (!hasAssignment) return null;

                    const tdKeycode = `TD(${i})`;
                    const tdKeyContents = getKeyContents(keyboard, tdKeycode) as KeyContent;
                    const customName = keyboard.cosmetic?.tapdances?.[i.toString()];

                    return (
                        <div
                            key={i}
                            className="flex flex-col bg-gray-50 dark:bg-neutral-800/60 rounded-lg p-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors min-w-[100px]"
                            onClick={() => isPicker ? assignKeycode(tdKeycode) : handleEdit(i)}
                        >
                            {/* Header row with draggable TD key and label */}
                            <div className="flex flex-row items-center gap-2 mb-2">
                                <div className="w-[30px] h-[30px] relative" onClick={(e) => e.stopPropagation()}>
                                    <Key
                                        isRelative
                                        x={0}
                                        y={0}
                                        w={1}
                                        h={1}
                                        row={-1}
                                        col={-1}
                                        keycode={tdKeycode}
                                        label={i.toString()}
                                        keyContents={tdKeyContents}
                                        variant="small"
                                        layerColor="sidebar"
                                        className="border-kb-key-border"
                                        headerClassName="bg-kb-sidebar-dark"
                                        onClick={() => assignKeycode(tdKeycode)}
                                        disableTooltip={true}
                                    />
                                </div>
                                <span className="text-xs font-bold text-slate-600 dark:text-neutral-300 truncate">
                                    {customName || `Tap Dance ${i}`}
                                </span>
                            </div>
                            <div className="grid grid-cols-2 gap-1">
                                {stateContents.map((content, idx) => {
                                    const slotName = idx === 0 ? "tap" : idx === 1 ? "hold" : idx === 2 ? "taphold" : "doubletap";
                                    return (
                                        <div key={idx} className="flex flex-col items-center">
                                            <span className="text-[8px] text-gray-400 dark:text-neutral-400 mb-0.5">{states[idx].label}</span>
                                            {renderSmallKey(states[idx].key, content, idx, i, slotName)}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
                {!isPicker && emptyIndex >= 0 && (
                    <button
                        type="button"
                        title="Add new tap dance"
                        className="flex flex-col items-center justify-center bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-lg p-2 min-w-[60px] h-[80px] transition-colors border-2 border-dashed border-gray-300 dark:border-neutral-600 hover:border-gray-400 dark:hover:border-neutral-500"
                        onClick={() => handleEdit(emptyIndex)}
                    >
                        <Plus className="w-6 h-6 text-gray-400 dark:text-neutral-400" />
                    </button>
                )}
                {tapdances.filter(td => {
                    const states = [td?.tap, td?.hold, td?.taphold, td?.doubletap];
                    return states.some(k => k && k !== "KC_NO");
                }).length === 0 && (
                        <div className="text-center text-gray-500 dark:text-neutral-400 py-4 px-6">
                            No tap dance keys configured.
                        </div>
                    )}
            </div>
        );
    }

    // Vertical list layout for sidebar (original)
    return (
        <div className="space-y-3 pt-0 pb-8 relative flex flex-col">
            {isPicker && (
                <div className="pb-2">
                    <span className="font-semibold text-xl text-kb-ink">Tap Dance Keys</span>
                </div>
            )}
            <div className="flex flex-col">
                <DescriptionBlock>
                    Allows a single key to perform multiple, different actions based on the number of times it is tapped in sequence (e.g., tap once for 'A', twice for 'B', or hold for a modifier).
                </DescriptionBlock>
                {/* Header Row - Sticky */}
                <div className="sticky top-0 z-20 bg-kb-surface pt-4 pb-4 -mt-4 flex flex-row items-end pl-12 pr-12 mb-2">
                    {/* Four equal columns shared with the rows, wide enough for each label. */}
                    <div className="flex-grow grid grid-cols-4 justify-items-center w-full max-w-[272px] ml-6">
                        <span className="text-[11px] font-bold text-center whitespace-nowrap">Tap</span>
                        <span className="text-[11px] font-bold text-center whitespace-nowrap">Hold</span>
                        <span className="text-[11px] font-bold text-center whitespace-nowrap">Tap-Hold</span>
                        <span className="text-[11px] font-bold text-center whitespace-nowrap">Double-Tap</span>
                    </div>
                </div>

                <div className="flex flex-col">
                    {tapdances.map((tdEntry, i) => {
                    const keycode = `TD(${i})`;
                    const keyContents = getKeyContents(keyboard, keycode) as KeyContent;

                    // Use tdEntry directly from the map
                    const td = tdEntry || ({} as any);
                    const states = [
                        { label: "Tap", key: td.tap },
                        { label: "Hold", key: td.hold },
                        { label: "TapHold", key: td.taphold },
                        { label: "Double", key: td.doubletap },
                    ];

                    const stateContents = states.map((s) => getKeyContents(keyboard, s.key) as KeyContent);

                    // Check if any key is actually assigned (not just KC_NO/empty)
                    const hasAssignment = stateContents.some(
                        (k) => (k?.top && k.top !== "KC_NO") || (k?.str && k.str !== "KC_NO" && k.str !== "")
                    );

                    const rowChildren = hasAssignment ? (
                        <div className="grid grid-cols-4 justify-items-center w-full max-w-[272px] ml-6">
                            {stateContents.map((content, idx) => {
                                const slotName = idx === 0 ? "tap" : idx === 1 ? "hold" : idx === 2 ? "taphold" : "doubletap";
                                return renderSmallKey(states[idx].key, content, idx, i, slotName);
                            })}
                        </div>
                    ) : undefined;

                    return (
                        <SidebarItemRow
                            key={i}
                            index={i}
                            keyboard={keyboard}
                            keycode={keycode}
                            label={i.toString()}
                            keyContents={keyContents}
                            onEdit={isPicker ? undefined : handleEdit}
                            onAssignKeycode={assignKeycode}
                            hoverBorderColor={hoverBorderColor}
                            hoverBackgroundColor={hoverBackgroundColor}
                            hoverLayerColor={layerColorName}
                            hoverHeaderClass={hoverHeaderClass}
                        >
                            {rowChildren}
                        </SidebarItemRow>
                    );
                    })}
                    {tapdances.length === 0 && (
                        <div className="text-center text-gray-500 dark:text-neutral-400 mt-10">
                            No tap dance keys found.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default TapdancePanel;
