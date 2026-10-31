import { useBindingChanges } from "@/hooks/useBindingChanges";
import { useChanges } from "@/contexts/ChangesContext";
import React, { useState, useEffect, useMemo } from "react";
import { Plus, ArrowRightFromLine } from "lucide-react";

import ComboIcon from "@/components/ComboIcon";
import OnOffToggle from "@/components/ui/OnOffToggle";
import SidebarItemRow from "@/layout/SecondarySidebar/components/SidebarItemRow";
import { Input } from "@/components/ui/input";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { useLayer } from "@/contexts/LayerContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { usePanels } from "@/contexts/PanelsContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { qmkService } from "@/services/qmk.service";
import { COMBO_TERM_QSID, ZERO_REPLACED_SETTINGS, effectiveSetting, parseSettingInput, settingRange } from "@/constants/qmk-settings";
import { keyboardService } from "@/services/keyboard.service";
import { hoverBackgroundClasses, hoverBorderClasses, hoverHeaderClasses } from "@/utils/colors";
import { getKeyContents } from "@/utils/keys";
import { getKeyDisplayLabel } from "@/utils/key-display";
import { Key } from "@/components/Key";
import { KeyContent, ComboOptions } from "@/types/keyboard.types";
import { cn } from "@/lib/utils";
import DescriptionBlock from "@/layout/SecondarySidebar/components/DescriptionBlock";
import { ComboPreviewRow } from "@/components/combo/ComboPreviewRow";
import { FoldGlyph } from "@/components/combo/FoldGlyph";
import { useComboPreview } from "@/contexts/ComboPreviewContext";
import { assignComboHues } from "@/utils/combo-hues";
import { comboInputs } from "@/utils/combo-membership";
import { comboSentence } from "@/utils/combo-labels";
import { comboName } from "@/utils/combo-names";

const CombosPanel: React.FC = () => {
    const { keyboard, isConnected, setKeyboard } = useKeyboard();
    const { queue } = useChanges();
    const persistBinding = useBindingChanges();
    const { assignKeycode } = useKeyBinding();
    const { selectedLayer } = useLayer();
    const { layoutMode, internationalLayout } = useLayoutSettings();
    const {
        setItemToEdit,
        setBindingTypeToEdit,
        setAlternativeHeader,
        setInitialEditorSlot,
    } = usePanels();
    const [saving, setSaving] = useState(false);
    const [timeoutInput, setTimeoutInput] = useState<string>("");

    const isHorizontal = layoutMode === "bottombar";
    const { enabled: showComboIndicators, palette: comboPalette } = useComboPreview();
    const comboHues = useMemo(
        () => assignComboHues(keyboard, comboPalette),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [keyboard?.combos, keyboard?.keymap, keyboard?.cosmetic?.layer_colors, comboPalette],
    );

    if (!keyboard) return null;

    /** Combo `i` as a preview row (hover/focus previews it, click pins), or the row unchanged when it has no keys. */
    const previewRow = (i: number, row: React.ReactElement) => {
        const combo = keyboard.combos?.[i];
        const inputs = comboInputs(combo);
        if (!combo || !inputs.length) return row;
        const label = comboSentence({ index: i, enabled: isEnabled(combo.options), output: combo.output, inputs }, comboName(keyboard.cosmetic, i));
        return <ComboPreviewRow key={i} index={i} ariaLabel={label}>{row}</ComboPreviewRow>;
    };
    /** A named combo's name, as the title line of its row, over its keys. */
    const nameLine = (i: number, className?: string) => {
        const name = comboName(keyboard.cosmetic, i);
        return name ? <span className={cn("block truncate text-sm font-semibold leading-tight text-kb-ink", className)} data-combo-row-name="">{name}</span> : null;
    };
    const glyph = (i: number) => showComboIndicators && comboInputs(keyboard.combos?.[i]).length > 0
        ? <FoldGlyph hue={comboHues.get(i) ?? 0} disabled={!isEnabled(keyboard.combos![i].options)} />
        : null;

    const findFirstEmptyCombo = (): number => {
        if (!keyboard.combos) return 0;
        for (let i = 0; i < keyboard.combos.length; i++) {
            const combo = keyboard.combos[i] as any;
            const hasInputs = combo.keys?.some((k: string) => k && k !== "KC_NO");
            const hasOutput = combo.output && combo.output !== "KC_NO";
            if (!hasInputs && !hasOutput) return i;
        }
        return keyboard.combos.length; // All full, return next index (might be out of bounds)
    };

    const handleAddCombo = () => {
        const emptyIndex = findFirstEmptyCombo();
        if (emptyIndex < (keyboard.combos?.length || 0)) {
            handleEdit(emptyIndex);
        }
    };

    // QSID 2 = Combo timeout
    const COMBO_TIMEOUT_QSID = COMBO_TERM_QSID;
    const isTimeoutSupported = keyboard.settings?.[COMBO_TIMEOUT_QSID] !== undefined;
    const storedComboTimeout = keyboard.settings?.[COMBO_TIMEOUT_QSID];
    const comboTimeout = effectiveSetting(COMBO_TIMEOUT_QSID, storedComboTimeout) ?? ZERO_REPLACED_SETTINGS[COMBO_TIMEOUT_QSID];
    const comboRange = settingRange(COMBO_TIMEOUT_QSID);

    // Sync local input state when keyboard state changes externally
    useEffect(() => {
        setTimeoutInput(String(comboTimeout));
    }, [comboTimeout]);

    const handleTimeoutBlur = async () => {
        if (!isConnected) return;
        const clamped = parseSettingInput(COMBO_TIMEOUT_QSID, timeoutInput, comboTimeout);
        setTimeoutInput(String(clamped));
        if (clamped === storedComboTimeout) return;

        setSaving(true);
        try {
            const updated = {
                ...keyboard,
                settings: { ...keyboard.settings, [COMBO_TIMEOUT_QSID]: clamped }
            };
            setKeyboard(updated);
            await queue(`QMK setting ${COMBO_TIMEOUT_QSID}`, async () => {
                await qmkService.push(updated, COMBO_TIMEOUT_QSID);
                await keyboardService.saveSvil();
            }, { writeKey: `qmk:${COMBO_TIMEOUT_QSID}` });
        } catch (err) {
            console.error("Failed to update combo timeout:", err);
        } finally {
            setSaving(false);
        }
    };

    const layerColorName = keyboard?.cosmetic?.layer_colors?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];
    const hoverHeaderClass = hoverHeaderClasses[layerColorName] || hoverHeaderClasses["primary"];

    const combos = keyboard.combos || [];

    const handleEdit = (index: number, slot?: number) => {
        setItemToEdit(index);
        setBindingTypeToEdit("combos");
        setAlternativeHeader(true);
        if (slot !== undefined) {
            setInitialEditorSlot(slot);
        }
    };

    const isEnabled = (options: number) => {
        return (options & ComboOptions.ENABLED) !== 0;
    };

    const handleToggleEnabled = async (index: number, e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (!keyboard.combos) return;

        const entry = keyboard.combos[index];
        const newOptions = entry.options ^ ComboOptions.ENABLED;

        const updatedCombos = [...keyboard.combos];
        updatedCombos[index] = { ...entry, options: newOptions };

        const updatedKeyboard = { ...keyboard, combos: updatedCombos };
        setKeyboard(updatedKeyboard);

        await persistBinding(updatedKeyboard, "combo", index);
    };

    const isKeyAssigned = (content: KeyContent | undefined) => {
        if (!content) return false;
        const top = content.top;
        const str = content.str;
        return (top && top !== "KC_NO" && top !== "TRNS") || (str && str !== "KC_NO" && str !== "");
    };

    // Shared small key renderer
    const renderSmallKey = (keycode: string, content: KeyContent, idx: number, comboIndex: number, slot: number) => {
        const hasContent = isKeyAssigned(content);
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
                    onClick={() => handleEdit(comboIndex, slot)}
                    disableTooltip={true}
                />
            </div>
        );
    };

    // Horizontal grid layout for bottom panel
    if (isHorizontal) {
        return (
            <div className="flex flex-row flex-wrap content-start gap-3 items-start pt-2">
                {combos.map((comboEntry, i) => {
                    const combo = comboEntry as any as import("@/types/keyboard.types").ComboEntry;

                    const inputs = [0, 1, 2, 3].map(idx => ({
                        keycode: combo.keys?.[idx] || "KC_NO",
                        content: getKeyContents(keyboard, combo.keys?.[idx] || "KC_NO") as KeyContent,
                        id: idx
                    })).filter(k => isKeyAssigned(k.content));

                    const resultKeycode = combo.output || "KC_NO";
                    const result = getKeyContents(keyboard, resultKeycode) as KeyContent;
                    const hasAssignment = inputs.length > 0 || isKeyAssigned(result);

                    if (!hasAssignment) return null;

                    const enabled = isEnabled(combo.options);

                    return previewRow(i,
                        <div
                            key={i}
                            className={cn(
                                "relative flex flex-col bg-gray-50 dark:bg-neutral-800/60 rounded-lg p-2 cursor-pointer in-data-[lit=true]:ring-2 in-data-[lit=true]:ring-kb-gray-border hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors min-w-[100px] group",
                                !enabled && "opacity-50"
                            )}
                            onClick={() => handleEdit(i)}
                        >
                            {/* Header with icon and label */}
                            <div className="flex flex-row items-center gap-2 mb-2">
                                <div className="w-5 h-5 text-slate-600 dark:text-neutral-300 flex-shrink-0">
                                    <ComboIcon />
                                </div>
                                <span className="text-xs font-bold text-slate-600 dark:text-neutral-300">Combo {i}</span>
                                {glyph(i)}
                                <OnOffToggle
                                    value={enabled}
                                    onToggle={() => handleToggleEnabled(i)}
                                    className="ml-auto scale-75 origin-right"
                                />
                            </div>
                            {nameLine(i, "-mt-1 mb-1.5 pl-7 max-w-[180px]")}
                            <div className="flex flex-row items-center justify-center gap-1 flex-wrap">
                                {inputs.map((input, idx) => (
                                    <React.Fragment key={input.id}>
                                        {idx > 0 && <Plus className="w-2 h-2 text-gray-400 dark:text-neutral-400" />}
                                        {renderSmallKey(input.keycode, input.content, input.id, i, input.id)}
                                    </React.Fragment>
                                ))}
                                <ArrowRightFromLine className="w-3 h-3 text-gray-400 dark:text-neutral-400 mx-1" />
                                {renderSmallKey(resultKeycode, result, 4, i, 4)}
                            </div>
                        </div>
                    );
                })}
                {/* Add new combo button */}
                {findFirstEmptyCombo() < (combos.length || 0) && (
                    <button
                        className="flex flex-col items-center justify-center bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-lg p-2 min-w-[60px] h-[80px] transition-colors border-2 border-dashed border-gray-300 dark:border-neutral-600 hover:border-gray-400 dark:hover:border-neutral-500"
                        onClick={handleAddCombo}
                        title="Add new combo"
                    >
                        <Plus className="w-6 h-6 text-gray-400 dark:text-neutral-400" />
                    </button>
                )}
                {combos.filter(combo => {
                    const c = combo as any;
                    const inputs = [0, 1, 2, 3].map(idx => c.keys?.[idx]).filter(k => k && k !== "KC_NO");
                    return inputs.length > 0 || (c.output && c.output !== "KC_NO");
                }).length === 0 && (
                        <div className="text-center text-gray-500 dark:text-neutral-400 py-4 px-6">
                            No combos configured.
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
                    A chording type solution for adding custom actions. It lets you hit multiple keys at once and produce a different effect. For instance, hitting A and B within the combo term would hit ESC instead, or have it perform even more complex tasks.
                </DescriptionBlock>
                {/* Combo Timeout Setting */}
                {isTimeoutSupported && isConnected && (
                    <div className="px-3 pb-3 pt-3 border-t border-b border-gray-200 dark:border-neutral-700">
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex flex-col">
                                <span className="text-sm font-medium">Combo Timeout</span>
                                <span className="text-xs text-muted-foreground">{comboRange.min}-{comboRange.max} ms</span>
                            </div>
                            <Input
                                type="number"
                                aria-label="Combo Timeout"
                                value={timeoutInput}
                                min={comboRange.min}
                                max={comboRange.max}
                                onChange={(e) => setTimeoutInput(e.target.value)}
                                onBlur={handleTimeoutBlur}
                                disabled={saving}
                                className={cn("w-24 text-right select-text", saving && "opacity-50")}
                            />
                        </div>
                    </div>
                )}
                {combos.map((comboEntry, i) => {
                    const combo = comboEntry as any as import("@/types/keyboard.types").ComboEntry;

                    const inputs = [0, 1, 2, 3].map(idx => ({
                        keycode: combo.keys?.[idx] || "KC_NO",
                        content: getKeyContents(keyboard, combo.keys?.[idx] || "KC_NO") as KeyContent,
                        id: idx
                    })).filter(k => isKeyAssigned(k.content));

                    const resultKeycode = combo.output || "KC_NO";
                    const result = getKeyContents(keyboard, resultKeycode) as KeyContent;
                    const hasAssignment = inputs.length > 0 || isKeyAssigned(result);

                    const enabled = isEnabled(combo.options);

                    const keysRow = hasAssignment ? (
                        <div className="flex flex-row items-center gap-1 ml-4 overflow-hidden min-w-0 flex-1">
                            {glyph(i) && <span className="inline-flex w-[18px] justify-center mr-1">{glyph(i)}</span>}
                            {inputs.map((input, idx) => (
                                <React.Fragment key={input.id}>
                                    {idx > 0 && <Plus className="w-3 h-3 text-kb-ink" />}
                                    {renderSmallKey(input.keycode, input.content, input.id, i, input.id)}
                                </React.Fragment>
                            ))}
                            <ArrowRightFromLine className="w-3 h-3 text-kb-ink mx-1" />
                            {renderSmallKey(resultKeycode, result, 4, i, 4)}
                            <OnOffToggle
                                value={enabled}
                                onToggle={() => handleToggleEnabled(i)}
                                className="ml-auto mr-2"
                            />
                        </div>
                    ) : undefined;
                    const name = keysRow ? nameLine(i, cn("ml-4 mb-1.5", glyph(i) && "pl-[22px]")) : null;
                    const rowChildren = name ? <div className="flex flex-col min-w-0 w-full">{name}{keysRow}</div> : keysRow;

                    const keyContents = { type: "combo" } as KeyContent;

                    return previewRow(i,
                        <SidebarItemRow
                            key={i}
                            index={i}
                            keyboard={keyboard}
                            label={i.toString()}
                            keycode={resultKeycode || "KC_NO"}
                            keyContents={keyContents}
                            onEdit={handleEdit}
                            onAssignKeycode={assignKeycode}
                            hoverBorderColor={hoverBorderColor}
                            hoverBackgroundColor={hoverBackgroundColor}
                            hoverLayerColor={layerColorName}
                            hoverHeaderClass={hoverHeaderClass}
                            showPreviewKey={false}
                            className={cn("py-4", !enabled && "opacity-50")}
                        >
                            {rowChildren}
                        </SidebarItemRow>
                    );
                })}

                {combos.length === 0 && (
                    <div className="text-center text-gray-500 dark:text-neutral-400 mt-10">
                        No combos found.
                    </div>
                )}
            </div>
        </section>
    );
};

export default CombosPanel;
