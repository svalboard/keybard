import { useBindingChanges } from "@/hooks/useBindingChanges";
import { useChanges } from "@/contexts/ChangesContext";
import React, { useState, useEffect } from "react";
import { ArrowRight, Plus, ArrowRightFromLine } from "lucide-react";

import OnOffToggle from "@/components/ui/OnOffToggle";
import SidebarItemRow from "@/layout/SecondarySidebar/components/SidebarItemRow";
import { Input } from "@/components/ui/input";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { qmkService } from "@/services/qmk.service";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { useLayer } from "@/contexts/LayerContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { usePanels } from "@/contexts/PanelsContext";
import { hoverBackgroundClasses, hoverBorderClasses, hoverHeaderClasses } from "@/utils/colors";
import { getKeyContents } from "@/utils/keys";
import { getKeyDisplayLabel } from "@/utils/key-display";
import { Key } from "@/components/Key";
import { KeyContent, LeaderOptions } from "@/types/keyboard.types";
import { keyboardService } from "@/services/keyboard.service";
import { cn } from "@/lib/utils";
import DescriptionBlock from "@/layout/SecondarySidebar/components/DescriptionBlock";

const LeadersPanel: React.FC = () => {
    const { keyboard, isConnected, setKeyboard } = useKeyboard();
    const { queue } = useChanges();
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
    const [savingTimeout, setSavingTimeout] = useState(false);
    const [savingPerKey, setSavingPerKey] = useState(false);
    const [timeoutInput, setTimeoutInput] = useState<string>("");

    const isHorizontal = layoutMode === "bottombar";

    // QMK Settings for Leader Key
    const LEADER_TIMEOUT_QSID = 28;
    const LEADER_PER_KEY_QSID = 29;
    const isTimeoutSupported = keyboard?.settings?.[LEADER_TIMEOUT_QSID] !== undefined;
    const isPerKeySupported = keyboard?.settings?.[LEADER_PER_KEY_QSID] !== undefined;
    const leaderTimeout = keyboard?.settings?.[LEADER_TIMEOUT_QSID] ?? 300;
    const perKeyTiming = (keyboard?.settings?.[LEADER_PER_KEY_QSID] ?? 0) !== 0;

    // Sync local input state when keyboard state changes externally
    useEffect(() => {
        setTimeoutInput(String(leaderTimeout));
    }, [leaderTimeout]);

    if (!keyboard) return null;

    const handleTimeoutBlur = async () => {
        if (!isConnected) return;
        const newVal = parseInt(timeoutInput) || 50;
        const clamped = Math.max(50, Math.min(5000, newVal));
        setTimeoutInput(String(clamped));
        if (clamped === leaderTimeout) return;

        setSavingTimeout(true);
        try {
            const updated = {
                ...keyboard,
                settings: { ...keyboard.settings, [LEADER_TIMEOUT_QSID]: clamped }
            };
            setKeyboard(updated);
            await queue(`QMK setting ${LEADER_TIMEOUT_QSID}`, async () => {
                await qmkService.push(updated, LEADER_TIMEOUT_QSID);
                await keyboardService.saveSvil();
            }, { writeKey: `qmk:${LEADER_TIMEOUT_QSID}` });
        } catch (err) {
            console.error("Failed to update leader timeout:", err);
        } finally {
            setSavingTimeout(false);
        }
    };

    const handlePerKeyToggle = async (checked: boolean) => {
        if (!isConnected) return;
        setSavingPerKey(true);
        try {
            const updated = {
                ...keyboard,
                settings: { ...keyboard.settings, [LEADER_PER_KEY_QSID]: checked ? 1 : 0 }
            };
            setKeyboard(updated);
            await queue(`QMK setting ${LEADER_PER_KEY_QSID}`, async () => {
                await qmkService.push(updated, LEADER_PER_KEY_QSID);
                await keyboardService.saveSvil();
            }, { writeKey: `qmk:${LEADER_PER_KEY_QSID}` });
        } catch (err) {
            console.error("Failed to update per-key timing:", err);
        } finally {
            setSavingPerKey(false);
        }
    };

    const layerColorName = keyboard?.cosmetic?.layer_colors?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];
    const hoverHeaderClass = hoverHeaderClasses[layerColorName] || hoverHeaderClasses["primary"];

    const leaders = keyboard.leaders || [];

    const handleEdit = (index: number, slot?: { type: "sequence" | "keycode"; index?: number }) => {
        setItemToEdit(index);
        setBindingTypeToEdit("leaders");
        setAlternativeHeader(true);
        if (slot) {
            setInitialEditorSlot(slot);
        }
    };

    const findFirstEmptyLeader = (): number => {
        if (!keyboard.leaders) return 0;
        for (let i = 0; i < keyboard.leaders.length; i++) {
            const e = keyboard.leaders[i];
            const hasSeq = e.sequence.some(k => k !== "KC_NO" && k !== "");
            const hasOut = e.output !== "KC_NO" && e.output !== "";
            if (!hasSeq && !hasOut) return i;
        }
        return keyboard.leaders.length;
    };

    const handleAddLeader = () => {
        const emptyIndex = findFirstEmptyLeader();
        if (!keyboard.leaders || emptyIndex >= keyboard.leaders.length) return;
        handleEdit(emptyIndex);
    };

    const isEnabled = (options: number) => {
        return (options & LeaderOptions.ENABLED) !== 0;
    };

    const handleToggleEnabled = async (index: number, e?: React.MouseEvent) => {
        e?.stopPropagation();
        if (!keyboard.leaders) return;

        const entry = keyboard.leaders[index];
        const newOptions = entry.options ^ LeaderOptions.ENABLED;

        const updatedLeaders = [...keyboard.leaders];
        updatedLeaders[index] = { ...entry, options: newOptions };

        const updatedKeyboard = {
            ...keyboard,
            leaders: updatedLeaders,
        };
        setKeyboard(updatedKeyboard);

        await persistBinding(updatedKeyboard, "leader", index);
    };


    const renderSmallKey = (keycode: string, index: number, slot: "sequence" | "output", seqIndex: number | undefined, isEditing: boolean) => {
        const content = getKeyContents(keyboard, keycode) as KeyContent;
        const hasContent = keycode !== "KC_NO" && keycode !== "";
        const isSelected = isEditing && itemToEdit === index;

        const label = getKeyDisplayLabel(keycode, content, internationalLayout);
        return (
            <div className="relative w-[30px] h-[30px]">
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
                    onClick={() => handleEdit(index, { type: slot === "sequence" ? "sequence" : "keycode", index: seqIndex })}
                    disableTooltip={true}
                />
            </div>
        );
    };

    const handleAssignLeaderKey = () => {
        if (!isBinding) return;
        assignKeycode("QK_LEADER");
    };

    // Custom key contents for the placeable key with explicit label
    const leaderKeyContents: KeyContent = { str: "Leader", type: "special" };

    // Horizontal layout for bottom panel
    if (isHorizontal) {
        return (
            <div className="flex flex-row gap-3 h-full items-start flex-wrap content-start">
                {/* Leader key */}
                <div className="flex flex-col gap-1 flex-shrink-0">
                    <div className="w-[45px] h-[45px]">
                        <Key
                            isRelative
                            x={0} y={0} w={1} h={1} row={-1} col={-1}
                            keycode="QK_LEADER"
                            label="Leader"
                            keyContents={leaderKeyContents}
                            layerColor="sidebar"
                            headerClassName="bg-kb-sidebar-dark"
                            variant="medium"
                            onClick={handleAssignLeaderKey}
                            disableTooltip={true}
                        />
                    </div>
                </div>

                {/* Leader entries */}
                <div className="flex flex-row gap-2 flex-wrap items-start">
                    {leaders.map((entry, i) => {
                        const enabled = isEnabled(entry.options);
                        const hasSequence = entry.sequence.some(k => k !== "KC_NO" && k !== "");
                        const hasOutput = entry.output !== "KC_NO" && entry.output !== "";
                        const isDefined = hasSequence || hasOutput;

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
                                <span className="text-[9px] font-bold text-slate-600 dark:text-neutral-300 mb-1">L{i}</span>
                                <div className="flex flex-row items-center gap-0.5">
                                    {entry.sequence.slice(0, 5).map((keycode, seqIdx) => {
                                        if (keycode === "KC_NO" || keycode === "") return null;
                                        return (
                                            <React.Fragment key={seqIdx}>
                                                {seqIdx > 0 && <ArrowRight className="w-3 h-3 text-kb-ink" />}
                                                {renderSmallKey(keycode, i, "sequence", seqIdx, false)}
                                            </React.Fragment>
                                        );
                                    })}
                                    <ArrowRightFromLine className="w-3 h-3 text-kb-ink mx-0.5" />
                                    {renderSmallKey(entry.output, i, "output", undefined, false)}
                                </div>
                            </div>
                        );
                    })}
                    {/* Add new leader button */}
                    {findFirstEmptyLeader() < (leaders.length || 0) && (
                        <button
                            className="flex flex-col items-center justify-center bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-lg p-2 min-w-[60px] h-[60px] transition-colors border-2 border-dashed border-gray-300 dark:border-neutral-600 hover:border-gray-400 dark:hover:border-neutral-500"
                            onClick={handleAddLeader}
                            title="Add new leader"
                        >
                            <Plus className="w-6 h-6 text-gray-400 dark:text-neutral-400" />
                        </button>
                    )}
                    {leaders.filter(e => e.sequence.some(k => k !== "KC_NO" && k !== "") || (e.output !== "KC_NO" && e.output !== "")).length === 0 && (
                        <div className="text-center text-gray-500 dark:text-neutral-400 py-2 px-4 text-sm">
                            No leader sequences configured.
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
                    Leader sequences trigger an output when you press a specific sequence of keys after the Leader key. Click on a key slot to assign a keycode.
                </DescriptionBlock>
                {/* Placeable Leader key */}
                <div className="pl-6 pr-2 flex sticky top-0 z-20 bg-kb-surface pb-3 pt-2">
                    <Key
                        isRelative
                        x={0} y={0} w={1} h={1} row={-1} col={-1}
                        keycode="QK_LEADER"
                        label="Leader"
                        keyContents={leaderKeyContents}
                        layerColor="sidebar"
                        className={cn(
                            "border-kb-key-border cursor-pointer",
                            isBinding && `hover:${hoverBorderColor} hover:${hoverBackgroundColor}`
                        )}
                        headerClassName="bg-kb-sidebar-dark"
                        onClick={handleAssignLeaderKey}
                        disableTooltip={true}
                    />
                </div>
                {/* Leader Timing Settings */}
                {isConnected && (isTimeoutSupported || isPerKeySupported) && (
                    <div className="pl-6 pr-2 pb-3 pt-4 border-t border-b border-gray-200 dark:border-neutral-700 space-y-3">
                        {isTimeoutSupported && (
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">Leader Timeout</span>
                                    <span className="text-xs text-muted-foreground">50-5000 ms</span>
                                </div>
                                <Input
                                    type="number"
                                    value={timeoutInput}
                                    min={50}
                                    max={5000}
                                    onChange={(e) => setTimeoutInput(e.target.value)}
                                    onBlur={handleTimeoutBlur}
                                    disabled={savingTimeout}
                                    className={cn("w-24 text-right select-text", savingTimeout && "opacity-50")}
                                />
                            </div>
                        )}
                        {isPerKeySupported && (
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">Per-key timing</span>
                                    <span className="text-xs text-muted-foreground">Reset timeout on each key</span>
                                </div>
                                <OnOffToggle
                                    value={perKeyTiming}
                                    onToggle={handlePerKeyToggle}
                                    className={cn(savingPerKey && "opacity-50")}
                                />
                            </div>
                        )}
                    </div>
                )}
                {leaders.map((entry, i) => {
                    const enabled = isEnabled(entry.options);
                    const hasSequence = entry.sequence.some(k => k !== "KC_NO" && k !== "");
                    const hasOutput = entry.output !== "KC_NO" && entry.output !== "";
                    const isDefined = hasSequence || hasOutput;
                    const isEditing = itemToEdit === i;

                    const rowChildren = (
                        <div className="flex flex-row items-center w-full">
                            <div className="flex flex-row items-center gap-1 ml-4 overflow-hidden">
                                {/* Sequence keys (up to 5) */}
                                {entry.sequence.slice(0, 5).map((keycode, seqIdx) => {
                                    if (keycode === "KC_NO" || keycode === "") return null;
                                    return (
                                        <React.Fragment key={seqIdx}>
                                            {seqIdx > 0 && <ArrowRight className="w-4 h-4 text-kb-ink mx-0.5" />}
                                            {renderSmallKey(keycode, i, "sequence", seqIdx, isEditing)}
                                        </React.Fragment>
                                    );
                                })}
                                {!hasSequence && (
                                    <div className="w-[30px] h-[30px] border border-dashed border-gray-300 dark:border-neutral-600 rounded flex items-center justify-center">
                                        <span className="text-xs text-gray-400 dark:text-neutral-400">...</span>
                                    </div>
                                )}
                                <ArrowRightFromLine className="w-4 h-4 text-kb-ink mx-1" />
                                {renderSmallKey(entry.output, i, "output", undefined, isEditing)}
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

                    const keyContents = { type: "leader" } as KeyContent;

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
                            dimmed={isDefined && !enabled}
                            className="py-4"
                        >
                            {rowChildren}
                        </SidebarItemRow>
                    );
                })}

                {leaders.length === 0 && (
                    <div className="text-center text-gray-500 dark:text-neutral-400 mt-10">
                        <p>No leader sequences configured.</p>
                        <p className="text-sm mt-2">This keyboard may not support leader sequences.</p>
                    </div>
                )}
            </div>
        </section>
    );
};

export default LeadersPanel;
