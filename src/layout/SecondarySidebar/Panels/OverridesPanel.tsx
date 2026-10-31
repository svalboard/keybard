import { useBindingChanges } from "@/hooks/useBindingChanges";
import React from "react";
import { ArrowRight, Plus } from "lucide-react";
import OnOffToggle from "@/components/ui/OnOffToggle";
import SidebarItemRow from "@/layout/SecondarySidebar/components/SidebarItemRow";
import { useLayer } from "@/contexts/LayerContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { usePanels } from "@/contexts/PanelsContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { hoverBackgroundClasses, hoverBorderClasses, hoverHeaderClasses } from "@/utils/colors";
import { getKeyContents } from "@/utils/keys";
import { getKeyDisplayLabel } from "@/utils/key-display";
import { Key } from "@/components/Key";
import { KeyContent } from "@/types/keyboard.types";
import { cn } from "@/lib/utils";
import DescriptionBlock from "@/layout/SecondarySidebar/components/DescriptionBlock";

const ENABLED_BIT = 1 << 7;

const OverridesPanel: React.FC = () => {
    const { keyboard, setKeyboard } = useKeyboard();
    const persistBinding = useBindingChanges();
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

    const overrides = keyboard.key_overrides || [];

    const handleEdit = (index: number, slot?: "trigger" | "replacement") => {
        setItemToEdit(index);
        setBindingTypeToEdit("overrides");
        setAlternativeHeader(true);
        if (slot) {
            setInitialEditorSlot(slot);
        }
    };

    const findFirstEmptyOverride = (): number => {
        if (!keyboard.key_overrides) return 0;
        for (let i = 0; i < keyboard.key_overrides.length; i++) {
            const o = keyboard.key_overrides[i];
            const hasTrigger = o.trigger && o.trigger !== "KC_NO";
            const hasRepl = o.replacement && o.replacement !== "KC_NO";
            if (!hasTrigger && !hasRepl) return i;
        }
        return keyboard.key_overrides.length;
    };

    const handleAddOverride = () => {
        const emptyIndex = findFirstEmptyOverride();
        if (!keyboard.key_overrides || emptyIndex >= keyboard.key_overrides.length) return;
        handleEdit(emptyIndex);
    };

    const updateOverrideOption = async (index: number, bit: number, checked: boolean) => {
        if (!keyboard) return;
        const updatedKeyboard = JSON.parse(JSON.stringify(keyboard));
        let options = updatedKeyboard.key_overrides?.[index].options || 0;
        if (checked) options |= bit;
        else options &= ~bit;
        if (updatedKeyboard.key_overrides?.[index]) {
            updatedKeyboard.key_overrides[index].options = options;
        }
        setKeyboard(updatedKeyboard);

        await persistBinding(updatedKeyboard, "override", index);
    };

    const renderSmallKey = (keycode: string, content: KeyContent, idx: number, overrideIndex: number) => {
        const hasContent = (content?.top && content.top !== "KC_NO") || (content?.str && content.str !== "KC_NO" && content.str !== "");
        const label = getKeyDisplayLabel(keycode, content, internationalLayout);
        return (
            <div key={idx} className="relative w-[30px] h-[30px]">
                <Key
                    isRelative
                    x={0} y={0} w={1} h={1} row={-1} col={-1}
                    keycode={keycode || "KC_NO"}
                    label={label}
                    keyContents={content}
                    layerColor={hasContent ? "sidebar" : undefined}
                    className={hasContent ? "border-kb-key-border" : "bg-transparent border border-kb-gray-border"}
                    headerClassName={hasContent ? "bg-kb-sidebar-dark" : "text-black"}
                    variant="small"
                    onClick={() => handleEdit(overrideIndex, idx === 0 ? "trigger" : "replacement")}
                    disableTooltip={true}
                />
            </div>
        );
    };

    // Horizontal grid layout for bottom panel
    if (isHorizontal) {
        return (
            <div className="flex flex-row flex-wrap content-start gap-3 items-start pt-2">
                {overrides.map((override, i) => {
                    const isEnabled = (override.options & ENABLED_BIT) !== 0;
                    const isDefined = (override.trigger && override.trigger !== "KC_NO") || (override.replacement && override.replacement !== "KC_NO") || isEnabled;

                    if (!isDefined) return null;

                    const triggerContent = getKeyContents(keyboard, override.trigger || "KC_NO") as KeyContent;
                    const replacementContent = getKeyContents(keyboard, override.replacement || "KC_NO") as KeyContent;

                    return (
                        <div
                            key={i}
                            className={cn(
                                "relative flex flex-col bg-gray-50 dark:bg-neutral-800/60 rounded-lg p-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors min-w-[90px] group",
                                !isEnabled && "opacity-50"
                            )}
                            onClick={() => handleEdit(i)}
                        >
                            <div className="flex flex-row items-center justify-between mb-1">
                                <span className="text-xs font-bold text-slate-600 dark:text-neutral-300">OR {i}</span>
                                <OnOffToggle
                                    value={isEnabled}
                                    onToggle={(val) => updateOverrideOption(i, ENABLED_BIT, val)}
                                    className="scale-75 origin-right"
                                />
                            </div>
                            <div className="flex flex-row items-center justify-center gap-1">
                                {renderSmallKey(override.trigger || "KC_NO", triggerContent, 0, i)}
                                <ArrowRight className="w-3 h-3 text-gray-400 dark:text-neutral-400 mx-0.5" />
                                {renderSmallKey(override.replacement || "KC_NO", replacementContent, 1, i)}
                            </div>
                        </div>
                    );
                })}
                {/* Add new override button */}
                {findFirstEmptyOverride() < (overrides.length || 0) && (
                    <button
                        className="flex flex-col items-center justify-center bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-lg p-2 min-w-[60px] h-[70px] transition-colors border-2 border-dashed border-gray-300 dark:border-neutral-600 hover:border-gray-400 dark:hover:border-neutral-500"
                        onClick={handleAddOverride}
                        title="Add new override"
                    >
                        <Plus className="w-6 h-6 text-gray-400 dark:text-neutral-400" />
                    </button>
                )}
                {overrides.filter(o => (o.trigger && o.trigger !== "KC_NO") || (o.replacement && o.replacement !== "KC_NO")).length === 0 && (
                    <div className="text-center text-gray-500 dark:text-neutral-400 py-4 px-6">
                        No overrides configured.
                    </div>
                )}
            </div>
        );
    }

    // Vertical list layout for sidebar (original)
    return (
        <section className="space-y-3 flex flex-col pt-0">
            <div className="flex flex-col">
                <DescriptionBlock>
                    Reconfiguration of modifier-key combinations to send a different modifier-key combination or perform completely custom actions. e.g. Send delete when pressing shift + backspace
                </DescriptionBlock>
                {overrides.map((override, i) => {
                    const isEnabled = (override.options & ENABLED_BIT) !== 0;
                    const isDefined = (override.trigger && override.trigger !== "KC_NO") || (override.replacement && override.replacement !== "KC_NO");

                    const triggerContent = getKeyContents(keyboard, override.trigger || "KC_NO") as KeyContent;
                    const replacementContent = getKeyContents(keyboard, override.replacement || "KC_NO") as KeyContent;

                    const rowChildren = isDefined ? (
                        <div className="flex flex-row items-center w-full">
                            <div className="flex flex-row items-center gap-1 ml-4 overflow-hidden">
                                {renderSmallKey(override.trigger || "KC_NO", triggerContent, 0, i)}
                                <ArrowRight className="w-3 h-3 text-kb-ink mx-1" />
                                {renderSmallKey(override.replacement || "KC_NO", replacementContent, 1, i)}
                            </div>
                        </div>
                    ) : undefined;

                    const rowAction = isDefined ? (
                        <OnOffToggle
                            value={isEnabled}
                            onToggle={(val) => updateOverrideOption(i, ENABLED_BIT, val)}
                        />
                    ) : undefined;

                    // Still pass KeyContent type for consistency, though preview key is hidden
                    const keyContents = { type: "override" } as KeyContent;

                    return (
                        <SidebarItemRow
                            key={i}
                            index={i}
                            keyboard={keyboard}
                            label={i.toString()}
                            keyContents={keyContents}
                            onEdit={handleEdit}
                            hoverBorderColor={hoverBorderColor}
                            hoverBackgroundColor={hoverBackgroundColor}
                            hoverLayerColor={layerColorName}
                            hoverHeaderClass={hoverHeaderClass}
                            showPreviewKey={false}
                            action={rowAction}
                            dimmed={!!(isDefined && !isEnabled)}
                            className="py-4"
                        >
                            {rowChildren}
                        </SidebarItemRow>
                    );
                })}
                {overrides.length === 0 && (
                    <div className="text-center text-gray-500 dark:text-neutral-400 mt-10">
                        No overrides found.
                    </div>
                )}
            </div>
        </section>
    );
};

export default OverridesPanel;
