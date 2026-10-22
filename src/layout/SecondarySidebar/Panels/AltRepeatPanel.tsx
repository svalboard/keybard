import { useBindingChanges } from "@/hooks/useBindingChanges";
import React from "react";
import { ArrowRight, Plus } from "lucide-react";
import OnOffToggle from "@/components/ui/OnOffToggle";

import SidebarItemRow from "@/layout/SecondarySidebar/components/SidebarItemRow";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { useLayer } from "@/contexts/LayerContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { usePanels } from "@/contexts/PanelsContext";
import { hoverBackgroundClasses, hoverBorderClasses, hoverHeaderClasses } from "@/utils/colors";
import { getKeyContents } from "@/utils/keys";
import { getKeyDisplayLabel } from "@/utils/key-display";
import { Key } from "@/components/Key";
import { KeyContent, AltRepeatKeyOptions } from "@/types/keyboard.types";
import { cn } from "@/lib/utils";
import DescriptionBlock from "@/layout/SecondarySidebar/components/DescriptionBlock";

const AltRepeatPanel: React.FC = () => {
    const { keyboard, setKeyboard } = useKeyboard();
    const persistBinding = useBindingChanges();
    const { assignKeycode, isBinding } = useKeyBinding();
    const { selectedLayer } = useLayer();
    const { layoutMode, internationalLayout } = useLayoutSettings();
    const {
        setItemToEdit,
        setBindingTypeToEdit,
        setAlternativeHeader,
        itemToEdit,
        setInitialEditorSlot,
    } = usePanels();

    const isHorizontal = layoutMode === "bottombar";

    if (!keyboard) return null;

    const layerColorName = keyboard?.cosmetic?.layer_colors?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];
    const hoverHeaderClass = hoverHeaderClasses[layerColorName] || hoverHeaderClasses["primary"];

    const altRepeatKeys = keyboard.alt_repeat_keys || [];

    const handleEdit = (index: number, slot?: "keycode" | "alt_keycode") => {
        setItemToEdit(index);
        setBindingTypeToEdit("altrepeat");
        setAlternativeHeader(true);
        if (slot) {
            setInitialEditorSlot(slot);
        }
    };

    const findFirstEmptyAltRepeat = (): number => {
        if (!keyboard.alt_repeat_keys) return 0;
        for (let i = 0; i < keyboard.alt_repeat_keys.length; i++) {
            const e = keyboard.alt_repeat_keys[i];
            const hasKey = e.keycode !== "KC_NO" && e.keycode !== "";
            const hasAlt = e.alt_keycode !== "KC_NO" && e.alt_keycode !== "";
            if (!hasKey && !hasAlt) return i;
        }
        return keyboard.alt_repeat_keys.length;
    };

    const handleAddAltRepeat = () => {
        const emptyIndex = findFirstEmptyAltRepeat();
        if (!keyboard.alt_repeat_keys || emptyIndex >= keyboard.alt_repeat_keys.length) return;
        handleEdit(emptyIndex);
    };

    const isEnabled = (options: number) => {
        return (options & AltRepeatKeyOptions.ENABLED) !== 0;
    };

    const handleToggleEnabled = async (index: number, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!keyboard.alt_repeat_keys) return;

        const entry = keyboard.alt_repeat_keys[index];
        const newOptions = entry.options ^ AltRepeatKeyOptions.ENABLED;

        const updatedKeys = [...keyboard.alt_repeat_keys];
        updatedKeys[index] = { ...entry, options: newOptions };

        const updatedKeyboard = {
            ...keyboard,
            alt_repeat_keys: updatedKeys,
        };
        setKeyboard(updatedKeyboard);

        await persistBinding(updatedKeyboard, "altrepeat", index);
    };


    const renderSmallKey = (keycode: string, index: number, slot: "keycode" | "alt_keycode", isEditing: boolean) => {
        const content = getKeyContents(keyboard, keycode) as KeyContent;
        const hasContent = keycode !== "KC_NO" && keycode !== "";
        const isSelected = isEditing && itemToEdit === index;

        const label = getKeyDisplayLabel(keycode, content, internationalLayout);

        return (
            <div className="relative w-[40px] h-[40px] flex items-center justify-center">
                <Key
                    isRelative
                    x={0} y={0} w={1} h={1} row={-1} col={-1}
                    keycode={keycode}
                    label={label}
                    keyContents={content}
                    layerColor={hasContent ? "sidebar" : undefined}
                    className={cn(
                        hasContent ? "border-kb-key-border" : "bg-transparent border border-kb-gray-border",
                        isSelected && "ring-2 ring-blue-500"
                    )}
                    headerClassName={hasContent ? "bg-kb-sidebar-dark" : "text-black"}
                    variant="small"
                    onClick={() => handleEdit(index, slot)}
                    disableTooltip={true}
                />
            </div>
        );
    };

    const handleAssignAltRepeatKey = () => {
        if (!isBinding) return;
        assignKeycode("QK_ALT_REPEAT_KEY");
    };

    // Custom key contents for the placeable key with explicit label
    const altRepeatKeyContents: KeyContent = { str: "Alt-Repeat", type: "altrepeat" };

    // Horizontal layout for bottom panel
    if (isHorizontal) {
        return (
            <div className="flex flex-row gap-3 h-full items-start flex-wrap content-start">
                {/* Alt-Repeat key */}
                <div className="flex flex-col gap-1 flex-shrink-0">
                    <div className="w-[45px] h-[45px]">
                        <Key
                            isRelative
                            x={0} y={0} w={1} h={1} row={-1} col={-1}
                            keycode="QK_ALT_REPEAT_KEY"
                            label="Alt-Rep"
                            keyContents={altRepeatKeyContents}
                            layerColor="sidebar"
                            headerClassName="bg-kb-sidebar-dark"
                            variant="medium"
                            onClick={handleAssignAltRepeatKey}
                            disableTooltip={true}
                        />
                    </div>
                </div>

                {/* Alt-repeat entries */}
                <div className="flex flex-row gap-2 flex-wrap items-start">
                    {altRepeatKeys.map((entry, i) => {
                        const enabled = isEnabled(entry.options);
                        const hasKeycode = entry.keycode !== "KC_NO" && entry.keycode !== "";
                        const hasAltKeycode = entry.alt_keycode !== "KC_NO" && entry.alt_keycode !== "";
                        const isDefined = hasKeycode || hasAltKeycode;

                        if (!isDefined) return null;

                        return (
                            <div
                                key={i}
                                className={cn(
                                    "relative flex flex-col bg-gray-50 dark:bg-neutral-800/60 rounded-lg p-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors group",
                                    !enabled && "opacity-50"
                                )}
                                onClick={() => handleEdit(i)}
                            >
                                <span className="text-[9px] font-bold text-slate-600 dark:text-neutral-300 mb-1">AR {i}</span>
                                <div className="flex flex-row items-center gap-1">
                                    {renderSmallKey(entry.keycode, i, "keycode", false)}
                                    <ArrowRight className="w-2 h-2 text-gray-400 dark:text-neutral-400" />
                                    {renderSmallKey(entry.alt_keycode, i, "alt_keycode", false)}
                                </div>
                            </div>
                        );
                    })}
                    {/* Add new alt-repeat button */}
                    {findFirstEmptyAltRepeat() < (altRepeatKeys.length || 0) && (
                        <button
                            className="flex flex-col items-center justify-center bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-lg p-2 min-w-[60px] h-[60px] transition-colors border-2 border-dashed border-gray-300 dark:border-neutral-600 hover:border-gray-400 dark:hover:border-neutral-500"
                            onClick={handleAddAltRepeat}
                            title="Add new alt-repeat"
                        >
                            <Plus className="w-6 h-6 text-gray-400 dark:text-neutral-400" />
                        </button>
                    )}
                    {altRepeatKeys.filter(e => (e.keycode !== "KC_NO" && e.keycode !== "") || (e.alt_keycode !== "KC_NO" && e.alt_keycode !== "")).length === 0 && (
                        <div className="text-center text-gray-500 dark:text-neutral-400 py-2 px-4 text-sm">
                            No alt-repeat keys configured.
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <section className="space-y-3 flex flex-col pt-0">
            <div className="flex flex-col">
                <DescriptionBlock>
                    Alt-Repeat keys remap what happens when you press Alt-Repeat after a specific key. Click on a key slot to assign a keycode.
                </DescriptionBlock>
                {/* Placeable Alt-Repeat key */}
                <div className="pl-6 pr-2 flex sticky top-0 z-20 bg-kb-surface pb-3 pt-2">
                    <Key
                        isRelative
                        x={0} y={0} w={1} h={1} row={-1} col={-1}
                        keycode="QK_ALT_REPEAT_KEY"
                        label="Alt-Rep"
                        keyContents={altRepeatKeyContents}
                        layerColor="sidebar"
                        className={cn(
                            "border-kb-key-border cursor-pointer",
                            isBinding && `hover:${hoverBorderColor} hover:${hoverBackgroundColor} `
                        )}
                        headerClassName="bg-kb-sidebar-dark"
                        onClick={handleAssignAltRepeatKey}
                        disableTooltip={true}
                    />
                </div>
                {altRepeatKeys.map((entry, i) => {
                    const enabled = isEnabled(entry.options);
                    const hasKeycode = entry.keycode !== "KC_NO" && entry.keycode !== "";
                    const hasAltKeycode = entry.alt_keycode !== "KC_NO" && entry.alt_keycode !== "";
                    const isDefined = hasKeycode || hasAltKeycode;
                    const isEditing = itemToEdit === i;

                    const rowChildren = (
                        <div className="flex flex-row items-center w-full">
                            <div className="flex flex-row items-center gap-2 ml-4 overflow-hidden">
                                {renderSmallKey(entry.keycode, i, "keycode", isEditing)}
                                <div className="flex items-center justify-center h-[40px]">
                                    <ArrowRight className="w-4 h-4 text-muted-foreground" />
                                </div>
                                {renderSmallKey(entry.alt_keycode, i, "alt_keycode", isEditing)}
                            </div>
                        </div>
                    );

                    const rowAction = isDefined ? (
                        <OnOffToggle
                            value={enabled}
                            onToggle={(val) => {
                                if (val !== enabled) {
                                    handleToggleEnabled(i, { stopPropagation: () => { } } as any);
                                }
                            }}
                        />
                    ) : undefined;

                    const keyContents = { type: "altrepeat" } as KeyContent;

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
                            className={cn("py-4", !enabled && isDefined && "opacity-50")}
                        >
                            {rowChildren}
                        </SidebarItemRow>
                    );
                })}

                {altRepeatKeys.length === 0 && (
                    <div className="text-center text-gray-500 dark:text-neutral-400 mt-10">
                        <p>No alt-repeat keys configured.</p>
                        <p className="text-sm mt-2">This keyboard may not support alt-repeat keys.</p>
                    </div>
                )}
            </div>
        </section>
    );
};

export default AltRepeatPanel;
