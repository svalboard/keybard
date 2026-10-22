import { BindingName } from "@/layout/SecondarySidebar/components/BindingName";
import React from "react";
import { ArrowRight, Plus } from "lucide-react";
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
    isPicker?: boolean;
}

/** A text action's chip shows at most this many characters. */
const TEXT_CHIP_CHARS = 14;
const shortText = (text: string) => text.length > TEXT_CHIP_CHARS ? `${text.slice(0, TEXT_CHIP_CHARS - 1)}…` : text;

const MacrosPanel: React.FC<Props> = ({ isPicker }) => {
    const { keyboard } = useKeyboard();
    const { assignKeycode } = useKeyBinding();
    const { selectedLayer } = useLayer();
    const { layoutMode, internationalLayout } = useLayoutSettings();
    const {
        setItemToEdit,
        setBindingTypeToEdit,
        setAlternativeHeader,
        setPanelToGoBack,
        setInitialEditorSlot,
    } = usePanels();

    const isHorizontal = layoutMode === "bottombar";

    if (!keyboard) return null;

    const findFirstEmptyMacro = (): number => {
        if (!keyboard.macros) return 0;
        for (let i = 0; i < keyboard.macros.length; i++) {
            if (!keyboard.macros[i]?.actions?.length) return i;
        }
        return keyboard.macros.length;
    };

    const handleAddMacro = () => {
        const emptyIndex = findFirstEmptyMacro();
        if (emptyIndex < (keyboard.macros?.length || 0)) {
            handleEdit(emptyIndex);
        }
    };

    const layerColorName = keyboard?.cosmetic?.layer_colors?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];
    const hoverHeaderClass = hoverHeaderClasses[layerColorName] || hoverHeaderClasses["primary"];

    const macros = keyboard.macros || [];

    const handleEdit = (index: number, actionIndex?: number) => {
        setItemToEdit(index);
        setBindingTypeToEdit("macros");
        setAlternativeHeader(true);
        setPanelToGoBack("macros");
        if (actionIndex !== undefined) {
            setInitialEditorSlot(actionIndex);
        }
    };

    const renderAction = (action: any, idx: number, macroIndex: number) => {
        const [type, value] = action;

        if (["tap", "down", "up"].includes(type)) {
            const actionKeycode = value || "KC_NO";
            const actionKeyContents = getKeyContents(keyboard!, actionKeycode);

            return (
                <div
                    className="w-[30px] h-[30px] relative flex-shrink-0 cursor-pointer"
                    key={idx}
                >
                    <Key
                        isRelative
                        x={0}
                        y={0}
                        w={1}
                        h={1}
                        row={-1}
                        col={-1}
                        keycode={actionKeycode}
                        label={getKeyDisplayLabel(actionKeycode, actionKeyContents, internationalLayout)}
                        keyContents={actionKeyContents}
                        variant="small"
                        layerColor="sidebar"
                        className="border-kb-key-border"
                        headerClassName="bg-kb-sidebar-dark"
                        onClick={() => handleEdit(macroIndex, idx)}
                        disableTooltip={true}
                    />
                </div>
            );
        } else if (type === "text") {
            return (
                <div
                    key={idx}
                    title={String(value)}
                    className="flex shrink-0 items-center justify-center bg-kb-sidebar-dark border border-kb-sidebar-dark rounded text-[10px] px-2 h-[30px] whitespace-nowrap shadow-sm font-medium text-white cursor-pointer"
                    onClick={(e) => {
                        e.stopPropagation();
                        handleEdit(macroIndex, idx);
                    }}
                >
                    {/* Shortened in text, not clipped, so the chip is never wider than it shows. */}
                    "{shortText(String(value))}"
                </div>
            );
        } else if (type === "delay") {
            return (
                <div
                    key={idx}
                    className="flex shrink-0 items-center justify-center bg-kb-sidebar-dark border border-kb-sidebar-dark rounded text-[10px] px-2 h-[30px] whitespace-nowrap shadow-sm font-medium text-white cursor-pointer"
                    onClick={(e) => {
                        e.stopPropagation();
                        handleEdit(macroIndex, idx);
                    }}
                >
                    {value}ms
                </div>
            );
        }
        return null;
    };

    // Horizontal grid layout for bottom panel
    if (isHorizontal) {
        return (
            <div className="flex flex-row flex-wrap content-start gap-3 items-start pt-2">
                {macros.map((macroEntry, i) => {
                    const actions = macroEntry?.actions || [];
                    const hasActions = actions.length > 0;
                    const customName = keyboard.cosmetic?.macros?.[i.toString()];

                    if (!hasActions) return null;

                    const macroKeycode = `M${i}`;
                    const macroKeyContents = getKeyContents(keyboard, macroKeycode) as KeyContent;

                    return (
                        <div
                            key={i}
                            className="relative flex flex-col bg-gray-50 dark:bg-neutral-800/60 rounded-lg p-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors min-w-[100px] max-w-[180px] group"
                            onClick={() => handleEdit(i)}
                        >
                            {/* Header with draggable macro key and label */}
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
                                        keycode={macroKeycode}
                                        label={i.toString()}
                                        keyContents={macroKeyContents}
                                        variant="small"
                                        layerColor="sidebar"
                                        className="border-kb-key-border"
                                        headerClassName="bg-kb-sidebar-dark"
                                        onClick={() => assignKeycode(macroKeycode)}
                                        disableTooltip={true}
                                    />
                                </div>
                                <BindingName kind="macro" index={i} name={customName} readOnly={isPicker} />
                            </div>
                            <div className="flex flex-row items-center gap-0.5 flex-wrap justify-center">
                                {actions.slice(0, 4).map((action, idx) => (
                                    <React.Fragment key={idx}>
                                        {idx > 0 && <ArrowRight className="w-2 h-2 text-gray-400 dark:text-neutral-400 flex-shrink-0" />}
                                        {renderAction(action, idx, i)}
                                    </React.Fragment>
                                ))}
                                {actions.length > 4 && (
                                    <span className="text-[10px] text-gray-400 dark:text-neutral-400 ml-1">+{actions.length - 4}</span>
                                )}
                            </div>
                        </div>
                    );
                })}
                {/* Add new macro button */}
                {findFirstEmptyMacro() < (macros.length || 0) && (
                    <button
                        className="flex flex-col items-center justify-center bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-lg p-2 min-w-[60px] h-[80px] transition-colors border-2 border-dashed border-gray-300 dark:border-neutral-600 hover:border-gray-400 dark:hover:border-neutral-500"
                        onClick={handleAddMacro}
                        title="Add new macro"
                    >
                        <Plus className="w-6 h-6 text-gray-400 dark:text-neutral-400" />
                    </button>
                )}
                {macros.filter(m => m?.actions?.length > 0).length === 0 && (
                    <div className="text-center text-gray-500 dark:text-neutral-400 py-4 px-6">
                        No macro keys configured.
                    </div>
                )}
            </div>
        );
    }

    // Vertical list layout for sidebar (original)
    return (
        <section className="space-y-3 flex flex-col pt-0">
            {isPicker && (
                <div className="pb-2">
                    <span className="font-semibold text-xl text-kb-ink">Macro Keys</span>
                </div>
            )}
            <div className="flex flex-col">
                <DescriptionBlock>
                    Send customizable sequences of keystrokes to trigger text strings, complex shortcuts, or automated actions with a single keypress.
                </DescriptionBlock>
                {macros.map((macroEntry, i) => {
                    const keycode = `M${i}`;
                    const keyContents = getKeyContents(keyboard, keycode) as KeyContent;

                    const actions = macroEntry?.actions || [];
                    const hasActions = actions.length > 0;

                    const rowChildren = hasActions ? (
                        <div className="flex flex-row flex-wrap items-center gap-1 ml-4 min-w-0">
                            {actions.map((action, idx) => (
                                <React.Fragment key={idx}>
                                    {idx > 0 && <ArrowRight className="w-3 h-3 text-gray-400 dark:text-neutral-400 flex-shrink-0" />}
                                    {renderAction(action, idx, i)}
                                </React.Fragment>
                            ))}
                        </div>
                    ) : undefined;

                    return (
                        <SidebarItemRow
                            key={i}
                            index={i}
                            keyboard={keyboard}
                            keycode={keycode}
                            label={i.toString()}
                            hasCustomName={!!keyboard.cosmetic?.macros?.[i.toString()]}
                            customName={keyboard.cosmetic?.macros?.[i.toString()]}
                            keyContents={keyContents}
                            onEdit={isPicker ? undefined : handleEdit}
                            onAssignKeycode={assignKeycode}
                            hoverBorderColor={hoverBorderColor}
                            hoverBackgroundColor={hoverBackgroundColor}
                            hoverLayerColor={layerColorName}
                            hoverHeaderClass={hoverHeaderClass}
                        >
                            <div className="flex flex-col min-w-0 w-full gap-1">
                                <BindingName kind="macro" index={i} name={keyboard.cosmetic?.macros?.[i.toString()]} readOnly={isPicker} />
                                {rowChildren}
                            </div>
                        </SidebarItemRow>
                    );
                })}
                {macros.length === 0 && (
                    <div className="text-center text-gray-500 dark:text-neutral-400 mt-10">
                        No macro keys found.
                    </div>
                )}
            </div>
        </section>
    );
};

export default MacrosPanel;
