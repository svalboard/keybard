import PendingChangesPopover from "@/components/PendingChangesPopover";
import EditingTargetStatus from "@/components/EditingTargetStatus";
import { useLayoutImport } from "@/hooks/useLayoutImport";
import { LayoutImport } from "@/components/icons/LayoutImport";
import { LayoutExport } from "@/components/icons/LayoutExport";
import MatrixTesterIcon from "@/components/icons/MatrixTesterSvg";
import BoxIcon from "@/components/icons/BoxIcon";
import LayoutMultiLayersIcon from "@/components/icons/LayoutMultiLayersIcon";
import ThumbGrid3x2Icon from "@/components/icons/ThumbGrid3x2Icon";
import LayersActiveIcon from "@/components/icons/LayersActive";
import LayersDefaultIcon from "@/components/icons/LayersDefault";
import SquareArrowLeftIcon from "@/components/icons/SquareArrowLeft";
import SquareArrowRightIcon from "@/components/icons/SquareArrowRight";
import TelescopeIcon from "@/components/icons/TelescopeIcon";
import { ArrowLeft, ChevronDown, Unplug, Undo2, Zap } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { focusedLayer, isTabMarkedLive } from "@/utils/layer-indicator";
import { useChanges } from "@/contexts/ChangesContext";
import { useSettings } from "@/contexts/SettingsContext";
import { cn } from "@/lib/utils";
import { svalService } from "@/services/sval.service";
import { KEYMAP } from "@/constants/keygen";

import ExportDialog from "@/components/ExportDialog";

import { FC, useState, useEffect, useRef } from "react";
import { usePanels } from "@/contexts/PanelsContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { describeFirmware } from "@/constants/firmware";


interface LayerSelectorProps {
    selectedLayer: number;
    setSelectedLayer: (layer: number) => void;
    isMultiLayersActive: boolean;
    onToggleMultiLayers: () => void;
    showAllLayers: boolean;
    onToggleShowLayers: () => void;
    isLayerOrderReversed: boolean;
    onToggleLayerOrder: () => void;
    layerActiveState?: boolean[];
    onToggleLayerOn: (layer: number) => void;
    isAllTransparencyActive: boolean;
    onToggleAllTransparency: () => void;
    /** Tighter spacing above the toolbar (the L picker gives the height to its tray). */
    compact?: boolean;
}

interface OverviewStateSnapshot {
    isMultiLayersActive: boolean;
    is3DMode: boolean;
    isThumb3DOffsetActive: boolean;
    isAllTransparencyActive: boolean;
    showAllLayers: boolean;
    isLayerOrderReversed: boolean;
    selectedLayer: number;
}

/**
 * Component for selecting and managing active layers in the keyboard editor.
 * Displays a horizontal bar of layer tabs with a filter toggle for hiding blank layers.
 */
const LayerSelector: FC<LayerSelectorProps> = ({
    selectedLayer: _selectedLayer,
    setSelectedLayer,
    isMultiLayersActive,
    onToggleMultiLayers,
    showAllLayers,
    onToggleShowLayers,
    isLayerOrderReversed,
    onToggleLayerOrder,
    layerActiveState,
    onToggleLayerOn,
    isAllTransparencyActive,
    onToggleAllTransparency,
    compact = false,
}) => {
    const { keyboard, isConnected, connect, resetToOriginal, activeLayerIndex, loadedFrom } = useKeyboard();
    const firmware = isConnected && keyboard ? describeFirmware(keyboard) : null;
    const editingTarget = `${isConnected ? "Editing keyboard" : "Offline draft"}: ${loadedFrom || keyboard?.name || "Layout"}${isConnected ? (firmware ? `. Firmware: ${firmware}` : "") : ". Export to keep edits."}`;
    const { undo, undoLabel, commit, getPendingCount, clearAll, isSaving, error: saveError, setInstant, isInstant } = useChanges();
    const { updateSetting } = useSettings();
    const { is3DMode, setIs3DMode, isThumb3DOffsetActive, setIsThumb3DOffsetActive } = useLayoutSettings();
    const { activePanel, setActivePanel, setOpen, setItemToEdit, setPanelToGoBack } = usePanels();

    const { selectedTarget, clearSelection } = useKeyBinding();

    const liveUpdating = isInstant;
    // The tab marked here is the layer that has focus. With several layers shown, a key
    // selected in one of them gives it focus; the board's live layer never moves it.
    const selectedLayer = focusedLayer({ displayedLayer: _selectedLayer, selectedTarget, isMultiLayersActive });
    const transparentKeyGlyph = KEYMAP["KC_TRNS"]?.str || "▽";



    // Import/Export / Connect state
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isExportOpen, setIsExportOpen] = useState(false);

    const { handleFileImport, importReview } = useLayoutImport();

    // Track container width for collapsing behavior
    const containerRef = useRef<HTMLDivElement>(null);
    const [, setContainerWidth] = useState(0);

    const [windowHeight, setWindowHeight] = useState(window.innerHeight);
    const [toolbarPinned, setToolbarPinned] = useState(false);
    const [ignoreHover, setIgnoreHover] = useState(false);
    const [isOverviewActive, setIsOverviewActive] = useState(false);
    const overviewSnapshotRef = useRef<OverviewStateSnapshot | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });
        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, []);

    // Track window height for hover-only mode
    useEffect(() => {
        const handleResize = () => setWindowHeight(window.innerHeight);
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    // Short windows use an explicit toolbar disclosure.
    const isVerticallyConstrained = windowHeight < 550;
    const showFullBar = !isVerticallyConstrained || toolbarPinned;

    const getDisplayOrderForState = (
        nextShowAllLayers: boolean,
        nextIsLayerOrderReversed: boolean,
        nextSelectedLayer: number = selectedLayer
    ): number[] => {
        if (!keyboard) return [];
        const allLayerIds = Array.from({ length: keyboard.layers || 16 }, (_, i) => i);
        const visibleLayerIds = allLayerIds.filter((i) => {
            const layerData = keyboard.keymap?.[i];
            const isTransparentLayer = layerData ? layerData.every((keycode) => keycode === (KEYMAP["KC_TRNS"]?.code ?? 1)) : true;
            // The overview shows several layers, so the board's live layer doesn't keep a tab.
            const isLayerActive = isTabMarkedLive({ layer: i, isMultiLayersActive: true, activeLayerIndex, layerActiveState });

            if (!nextShowAllLayers && isTransparentLayer && i !== nextSelectedLayer && !isLayerActive) {
                return false;
            }
            return true;
        });
        return nextIsLayerOrderReversed ? [...visibleLayerIds].reverse() : visibleLayerIds;
    };

    const disableOverviewWithoutRestore = () => {
        if (!isOverviewActive) return;
        overviewSnapshotRef.current = null;
        setIsOverviewActive(false);
    };

    const handleOverviewToggle = () => {
        if (isOverviewActive) {
            const snapshot = overviewSnapshotRef.current;
            overviewSnapshotRef.current = null;
            setIsOverviewActive(false);
            if (!snapshot) return;

            if (isMultiLayersActive !== snapshot.isMultiLayersActive) onToggleMultiLayers();
            if (is3DMode !== snapshot.is3DMode) setIs3DMode(snapshot.is3DMode);
            if (isThumb3DOffsetActive !== snapshot.isThumb3DOffsetActive) setIsThumb3DOffsetActive(snapshot.isThumb3DOffsetActive);
            if (isAllTransparencyActive !== snapshot.isAllTransparencyActive) onToggleAllTransparency();
            if (showAllLayers !== snapshot.showAllLayers) onToggleShowLayers();
            if (isLayerOrderReversed !== snapshot.isLayerOrderReversed) onToggleLayerOrder();
            if (_selectedLayer !== snapshot.selectedLayer) setSelectedLayer(snapshot.selectedLayer);
            return;
        }

        overviewSnapshotRef.current = {
            isMultiLayersActive,
            is3DMode,
            isThumb3DOffsetActive,
            isAllTransparencyActive,
            showAllLayers,
            isLayerOrderReversed,
            selectedLayer: _selectedLayer,
        };
        setIsOverviewActive(true);

        if (activePanel === "matrixtester") {
            setActivePanel(null);
        }
        if (!isMultiLayersActive) onToggleMultiLayers();
        if (!is3DMode) setIs3DMode(true);
        if (!isThumb3DOffsetActive) setIsThumb3DOffsetActive(true);
        if (!isAllTransparencyActive) onToggleAllTransparency();
        if (showAllLayers) onToggleShowLayers();
        if (!isLayerOrderReversed) onToggleLayerOrder();

        const overviewDisplayOrder = getDisplayOrderForState(false, true);
        if (overviewDisplayOrder.length > 0) {
            setSelectedLayer(overviewDisplayOrder[0]);
        }
    };

    // If tracked controls change while overview is active, auto-disable overview and keep current states.
    useEffect(() => {
        if (!isOverviewActive) return;
        const stillInOverviewPreset =
            isMultiLayersActive &&
            is3DMode &&
            isThumb3DOffsetActive &&
            isAllTransparencyActive &&
            !showAllLayers &&
            isLayerOrderReversed;

        if (!stillInOverviewPreset) {
            overviewSnapshotRef.current = null;
            setIsOverviewActive(false);
        }
    }, [
        isOverviewActive,
        isMultiLayersActive,
        is3DMode,
        isThumb3DOffsetActive,
        isAllTransparencyActive,
        showAllLayers,
        isLayerOrderReversed
    ]);

    if (!keyboard) return null;

    const handleSelectLayer = (layer: number) => () => {
        setSelectedLayer(layer);
        // A tab click moves focus to its layer, away from a key selected in another one.
        if (isMultiLayersActive && selectedTarget?.type === "keyboard" && selectedTarget.layer !== layer) clearSelection?.();
    };

    const shouldRenderLayerTab = (i: number) => {
        const layerData = keyboard.keymap?.[i];
        const isTransparentLayer = layerData ? layerData.every((keycode) => keycode === (KEYMAP["KC_TRNS"]?.code ?? 1)) : true;
        const isLayerActive = isTabMarkedLive({ layer: i, isMultiLayersActive, activeLayerIndex, layerActiveState });

        const shouldHideTransparent = !showAllLayers;
        if (shouldHideTransparent && isTransparentLayer && i !== selectedLayer && !isLayerActive) {
            return false;
        }
        return true;
    };

    const renderLayerTab = (i: number) => {
        if (!shouldRenderLayerTab(i)) return null;

        const layerShortName = svalService.getLayerNameNoLabel(keyboard, i);
        const isActive = selectedLayer === i;
        const isLayerActive = isTabMarkedLive({ layer: i, isMultiLayersActive, activeLayerIndex, layerActiveState });

        return (
            <button
                key={`layer-tab-${i}`}
                type="button"
                aria-label={`Layer ${i}: ${layerShortName}`}
                aria-pressed={isActive}
                onClick={handleSelectLayer(i)}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    onToggleLayerOn(i);
                }}
                className={cn(
                    "px-4 py-1 rounded-full transition-colors text-sm font-medium cursor-pointer border-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 whitespace-nowrap",
                    isActive
                        ? "bg-gray-800 text-white dark:bg-neutral-200 dark:text-neutral-900 shadow-md scale-105"
                        : "bg-transparent text-gray-600 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700"
                )}
            >
                <span className={cn("select-none", isLayerActive && "underline underline-offset-2")}>
                    {layerShortName}
                </span>
            </button>
        );
    };

    const allLayerIds = Array.from({ length: keyboard.layers || 16 }, (_, i) => i);
    const visibleLayerIds = allLayerIds.filter(shouldRenderLayerTab);
    const displayOrder = isLayerOrderReversed ? [...visibleLayerIds].reverse() : visibleLayerIds;

    // Keep toolbar and layer rows compact; constrained rows can scroll.
    // When vertically constrained: explicit disclosure keeps controls reachable.
    return (
        <div
            ref={containerRef}
            className={cn(
                "w-full flex-shrink-0 relative z-20 transition-all duration-200",
                showFullBar ? (compact ? "pt-1" : "pt-[22px]") : "pt-0"
            )}
            onClick={(e) => e.stopPropagation()}
        >
            <EditingTargetStatus />
            {importReview}
            {/* Collapsed toolbar disclosure for short windows */}
            {!showFullBar && (
                <button type="button" aria-label="Show editor controls" title="Show editor controls" aria-expanded={false}
                    className="flex w-full items-center justify-center text-gray-500 dark:text-neutral-400 hover:text-kb-ink cursor-pointer h-5 focus-visible:outline-2"
                    onClick={() => setToolbarPinned(true)}>
                    <ChevronDown className="h-3 w-3" />
                </button>
            )}

            {/* Full toolbar - shown normally or explicitly expanded */}
            {showFullBar && (
                <div className="flex flex-col w-full bg-transparent">
                    <div className="relative w-full bg-transparent">
                        {/* Top Row: Connect/Import/Export + Live Controls + Tab Icon + Tabs */}
                        <div className={cn("flex items-center gap-2 pl-5 whitespace-nowrap bg-transparent overflow-x-auto overscroll-x-contain [&>*]:shrink-0", compact ? "py-1" : "py-2")}>

                            {isVerticallyConstrained && <button type="button" aria-label="Hide editor controls" title="Hide editor controls"
                                className="rounded p-1 text-gray-500 dark:text-neutral-400 hover:bg-gray-200 dark:hover:bg-neutral-700 focus-visible:outline-2"
                                onClick={() => { setToolbarPinned(false); }}>
                                <ChevronDown className="h-3 w-3 rotate-180" />
                            </button>}

                            {/* File Input (Hidden) */}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".svil,.viable,.vil,.json"
                                className="hidden"
                                onChange={handleFileImport}
                            />

                            {/* Export Dialog: the same one Settings opens */}
                            <ExportDialog open={isExportOpen} onOpenChange={setIsExportOpen} />

                            {/* Connect / Update Button Group */}
                            {!isConnected ? (
                                <button
                                    onClick={(e) => { e.stopPropagation(); connect(); }}
                                    className="flex items-center gap-2 text-sm font-medium cursor-pointer transition-all bg-kb-active text-gray-200 dark:text-neutral-900 hover:bg-gray-800 dark:hover:bg-neutral-300 px-5 py-1.5 rounded-full mr-2"
                                    title={`${editingTarget} Click to connect.`}
                                >
                                    <Unplug className="h-4 w-4 text-gray-200 dark:text-neutral-900" />
                                    <span className="select-none">Connect</span>
                                </button>
                            ) : (
                                <div className="flex items-center gap-1" title={editingTarget}>

                                    {saveError && (
                                        <div role="alert" className="max-w-xs text-xs text-red-700 dark:text-red-400">
                                            <span>Not saved: {saveError}. Pending edits are retained. Retry before discarding; some writes may already have succeeded. </span>
                                            <button disabled={isSaving} onClick={() => void commit()} className="underline font-semibold">Retry</button>
                                        </div>
                                    )}
                                    <PendingChangesPopover />
                                    {/* Mode Switch Button (Zap) - Only show when NOT live updating (to switch TO live) */}
                                    {!liveUpdating && (
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <button
                                                    disabled={isSaving}
                                                    onClick={async (e) => {
                                                        e.stopPropagation();
                                                        if (await setInstant(true)) updateSetting("live-updating", true);
                                                    }}
                                                    className="p-2 rounded-full transition-all cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-700"
                                                    aria-label="Switch to Live Updating"
                                                >
                                                    <Zap className="h-4 w-4 fill-kb-ink text-kb-ink" />
                                                </button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                Switch to Live Updating
                                            </TooltipContent>
                                        </Tooltip>
                                    )}
                                    {/* Main Action Button */}
                                    {liveUpdating ? (
                                        <>
                                            {/* Zap button to switch to Manual/Update Now mode - inverted colors */}
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void setInstant(false);
                                                            updateSetting("live-updating", false);
                                                        }}
                                                        className="p-2 rounded-full transition-all cursor-pointer bg-kb-active hover:bg-gray-800 dark:hover:bg-neutral-300"
                                                        aria-label="Switch to Manual Updates"
                                                    >
                                                        <Zap className="h-4 w-4 fill-kb-gray text-kb-gray" />
                                                    </button>
                                                </TooltipTrigger>
                                                <TooltipContent side="top">
                                                    Switch to Manual Updates
                                                </TooltipContent>
                                            </Tooltip>
                                            {/* Live Updating button - black text on transparent background */}
                                            <button
                                                disabled={true}
                                                className="flex items-center text-sm font-medium pl-2 pr-5 py-1.5 rounded-full bg-transparent text-kb-ink border border-transparent cursor-default"
                                            >
                                                <span className="select-none">{isSaving ? "Saving…" : saveError ? "Changes not saved" : "Live Updating"}</span>
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setIgnoreHover(true);
                                                // Handle "Update Changes"
                                                commit();
                                            }}
                                            onMouseLeave={() => setIgnoreHover(false)}
                                            disabled={isSaving || getPendingCount() === 0}
                                            className={cn(
                                                "flex items-center gap-2 text-sm font-medium transition-all px-5 py-1.5 rounded-full border",
                                                // Disabled state
                                                getPendingCount() === 0
                                                    ? "bg-gray-200 dark:bg-neutral-700 text-kb-ink border-gray-200 dark:border-neutral-700 cursor-not-allowed"
                                                    : "bg-kb-active text-gray-200 dark:text-neutral-900 cursor-pointer",
                                                // Hover logic - Manual Mode: Red (only when enabled)
                                                getPendingCount() > 0 && (!ignoreHover) && "hover:bg-red-500 hover:text-white dark:hover:text-white hover:border-red-500",

                                                // Pending Changes Ring (Manual Mode only)
                                                getPendingCount() > 0
                                                    ? `border-transparent ring-[3px] ring-red-500 ring-offset-2 ring-offset-kb-gray ${!ignoreHover ? "hover:ring-kb-ink" : ""}`
                                                    : "", // No ring when disabled

                                                // Active state (click) - only when enabled
                                                getPendingCount() > 0 && "active:bg-red-500 active:text-white dark:active:text-white"
                                            )}
                                        >
                                            <span className="select-none">
                                                {isSaving ? "Saving…" : getPendingCount() > 0
                                                    ? `Apply ${getPendingCount()} Change${getPendingCount() === 1 ? '' : 's'} `
                                                    : 'No pending changes'}
                                            </span>
                                        </button>
                                    )}

                                    {!liveUpdating && (
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (getPendingCount() > 0 && !saveError && window.confirm("Discard all pending edits in this draft? Changes already applied to the keyboard are not undone.")) {
                                                            clearAll();
                                                            resetToOriginal();
                                                        }
                                                    }}
                                                    disabled={isSaving || !!saveError || getPendingCount() === 0}
                                                    aria-label="Discard pending edits"
                                                    className={cn(
                                                        "p-2 rounded-full transition-all text-kb-ink ml-0",
                                                        getPendingCount() > 0 ? "cursor-pointer hover:bg-gray-100 dark:hover:bg-neutral-700" : "opacity-30 cursor-not-allowed"
                                                    )}
                                                >
                                                    <Undo2 className="h-4 w-4" />
                                                </button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                Discard pending edits
                                            </TooltipContent>
                                        </Tooltip>
                                    )}
                                </div>
                            )}

                            {undoLabel && <button disabled={isSaving} onClick={() => void undo()} className="rounded border px-3 py-1 text-sm" title={`Undo ${undoLabel}`}>Undo</button>}
                            {/* Divider */}
                            <div className="h-4 w-[1px] bg-slate-400 dark:bg-neutral-600 mx-0 flex-shrink-0" />

                            <div className="flex items-center gap-1">
                                {/* Import Button */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                                            className="p-2 rounded-full transition-all cursor-pointer hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            aria-label="Import Layout"
                                        >
                                            <LayoutImport className="h-5 w-5 text-kb-ink" />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        Import Layout
                                    </TooltipContent>
                                </Tooltip>

                                {/* Export Button */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setIsExportOpen(true); }}
                                            className="p-2 rounded-full transition-all cursor-pointer hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            disabled={!keyboard}
                                            aria-label="Export Layout"
                                        >
                                            <LayoutExport className="h-5 w-5 text-kb-ink" />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        Export Layout
                                    </TooltipContent>
                                </Tooltip>

                                {/* Matrix Tester Button */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (activePanel === "matrixtester") {
                                                    // If already in matrix tester mode, exit it
                                                    setActivePanel(null);
                                                } else {
                                                    // Enter matrix tester mode
                                                    setOpen(false);
                                                    setActivePanel("matrixtester");
                                                    setPanelToGoBack(null);
                                                    setItemToEdit(null);
                                                }
                                            }}
                                            className={cn(
                                                "p-2 rounded-full transition-all cursor-pointer",
                                                activePanel === "matrixtester"
                                                    ? "bg-kb-active hover:bg-gray-800 dark:hover:bg-neutral-300"
                                                    : "hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            )}
                                            aria-label={activePanel === "matrixtester" ? "Exit Matrix Tester" : "Matrix Tester"}
                                        >
                                            <MatrixTesterIcon className={cn(
                                                "h-5 w-5",
                                                activePanel === "matrixtester" ? "text-kb-gray" : "text-kb-ink"
                                            )} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        {activePanel === "matrixtester" ? "Exit Matrix Tester" : "Matrix Tester"}
                                    </TooltipContent>
                                </Tooltip>

                                {/* Divider */}
                                <div className="h-4 w-[1px] bg-slate-400 dark:bg-neutral-600 ml-2 mr-2 flex-shrink-0" />

                                {/* Multi Layers Button */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                disableOverviewWithoutRestore();
                                                if (activePanel === "matrixtester") {
                                                    setActivePanel(null);
                                                }
                                                onToggleMultiLayers();
                                            }}
                                            className={cn(
                                                "p-2 rounded-full transition-all cursor-pointer",
                                                isMultiLayersActive
                                                    ? "bg-kb-active hover:bg-gray-800 dark:hover:bg-neutral-300"
                                                    : "hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            )}
                                            aria-pressed={isMultiLayersActive}
                                            aria-label={isMultiLayersActive ? "Show Single Layer" : "Show Multiple Layers"}
                                        >
                                            <LayoutMultiLayersIcon className={cn(
                                                "h-5 w-5",
                                                isMultiLayersActive ? "text-kb-gray" : "text-kb-ink"
                                            )} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        {isMultiLayersActive ? "Show Single Layer" : "Show Multiple Layers"}
                                    </TooltipContent>
                                </Tooltip>

                                {/* 3D View Toggle Button */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                disableOverviewWithoutRestore();
                                                setIs3DMode(!is3DMode);
                                            }}
                                            className={cn(
                                                "p-2 rounded-full transition-all cursor-pointer",
                                                is3DMode
                                                    ? "bg-kb-active hover:bg-gray-800 dark:hover:bg-neutral-300"
                                                    : "hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            )}
                                            aria-pressed={is3DMode}
                                            aria-label={is3DMode ? "Exit 3D View" : "3D View"}
                                        >
                                            <BoxIcon className={cn(
                                                "h-5 w-5",
                                                is3DMode ? "text-kb-gray" : "text-gray-700 dark:text-neutral-200"
                                            )} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        {is3DMode ? "Exit 3D View" : "3D View"}
                                    </TooltipContent>
                                </Tooltip>

                                {/* Thumb Offset Toggle (3D) */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                disableOverviewWithoutRestore();
                                                setIsThumb3DOffsetActive(!isThumb3DOffsetActive);
                                            }}
                                            className={cn(
                                                "p-2 rounded-full transition-all cursor-pointer",
                                                isThumb3DOffsetActive
                                                    ? "bg-kb-active hover:bg-gray-800 dark:hover:bg-neutral-300"
                                                    : "hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            )}
                                            aria-pressed={isThumb3DOffsetActive}
                                            aria-label={isThumb3DOffsetActive ? "Show Thumbs" : "Hide Thumbs"}
                                        >
                                            <ThumbGrid3x2Icon className={cn(
                                                "h-5 w-5",
                                                isThumb3DOffsetActive ? "text-kb-gray" : "text-gray-700 dark:text-neutral-200"
                                            )} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        Hide Thumbs
                                    </TooltipContent>
                                </Tooltip>

                                {/* Show/Hide All Transparent Keys Button */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                disableOverviewWithoutRestore();
                                                onToggleAllTransparency();
                                            }}
                                            className={cn(
                                                "p-2 rounded-full transition-all cursor-pointer w-9 h-9 flex items-center justify-center",
                                                isAllTransparencyActive
                                                    ? "bg-kb-active hover:bg-gray-800 dark:hover:bg-neutral-300"
                                                    : "hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            )}
                                            aria-pressed={isAllTransparencyActive}
                                            aria-label={isAllTransparencyActive ? "Show All Transparent Keys" : "Hide All Transparent Keys"}
                                        >
                                            <span className={cn(
                                                "text-lg leading-none font-semibold translate-y-[2px]",
                                                isAllTransparencyActive ? "text-kb-gray" : "text-gray-700 dark:text-neutral-200"
                                            )}>
                                                {transparentKeyGlyph}
                                            </span>
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        {isAllTransparencyActive ? "Show All Transparent Keys" : "Hide All Transparent Keys"}
                                    </TooltipContent>
                                </Tooltip>

                                {/* Overview Button */}
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleOverviewToggle();
                                            }}
                                            className={cn(
                                                "p-2 rounded-full transition-all cursor-pointer",
                                                isOverviewActive
                                                    ? "bg-kb-active hover:bg-gray-800 dark:hover:bg-neutral-300"
                                                    : "hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            )}
                                            aria-pressed={isOverviewActive}
                                            aria-label={isOverviewActive ? "Disable Overview" : "Overview"}
                                        >
                                            <TelescopeIcon className={cn(
                                                "h-5 w-5",
                                                isOverviewActive ? "text-kb-gray" : "text-gray-700 dark:text-neutral-200"
                                            )} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        Overview
                                    </TooltipContent>
                                </Tooltip>
                            </div>

                        </div>

                        {/* Matrix Tester Title - shown only when matrix tester is active */}
                        {activePanel === "matrixtester" && (
                            <div className="pl-[27px] pt-[7px] pb-2">
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => setActivePanel(null)}
                                        className="flex items-center gap-2 p-1 pr-3 -ml-1 rounded-lg hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors"
                                        title="Return to layer view"
                                    >
                                        <ArrowLeft className="h-5 w-5 text-kb-ink" />
                                        <span className="font-bold text-lg text-kb-ink">Matrix Tester</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Layer Tabs Row - fixed position in 3D and/or multi-layer mode */}
                        {(isMultiLayersActive || is3DMode) && (
                            <div className="absolute left-0 right-0 top-full z-30 flex items-center gap-2 pl-5 pb-2 whitespace-nowrap bg-transparent pointer-events-auto overflow-x-auto overscroll-x-contain [&>*]:shrink-0">
                                <div className="flex items-center gap-1">
                                    <Tooltip delayDuration={500}>
                                        <TooltipTrigger asChild>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    disableOverviewWithoutRestore();
                                                    onToggleShowLayers();
                                                }}
                                                disabled={activePanel === "matrixtester"}
                                                className={cn(
                                                    "p-2 rounded-full transition-colors flex-shrink-0",
                                                    activePanel === "matrixtester"
                                                        ? "text-gray-400 dark:text-neutral-400 cursor-not-allowed opacity-30"
                                                        : "text-kb-ink hover:bg-gray-200 dark:hover:bg-neutral-700"
                                                )}
                                            aria-pressed={showAllLayers}
                                            aria-label={showAllLayers ? "Hide Transparent Layers" : "Show All Layers"}
                                        >
                                            {!showAllLayers ? <LayersActiveIcon className="h-5 w-5" /> : <LayersDefaultIcon className="h-5 w-5" />}
                                        </button>
                                    </TooltipTrigger>
                                        <TooltipContent side="top">
                                            {showAllLayers ? "Hide Transparent Layers" : "Show All Layers"}
                                        </TooltipContent>
                                    </Tooltip>
                                </div>

                                <div className={cn("flex items-center gap-1", activePanel === "matrixtester" && "opacity-30 pointer-events-none")}>
                                    {displayOrder.map((i) => renderLayerTab(i))}
                                </div>

                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                disableOverviewWithoutRestore();
                                                onToggleLayerOrder();
                                            }}
                                            className={cn(
                                                "p-2 rounded-full transition-colors",
                                                "text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-100 hover:bg-gray-200 dark:hover:bg-neutral-700"
                                            )}
                                            aria-label="Reverse Layer Order"
                                        >
                                            {isLayerOrderReversed
                                                ? <SquareArrowRightIcon className="h-5 w-5" />
                                                : <SquareArrowLeftIcon className="h-5 w-5" />}
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                        Flip Layer View
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default LayerSelector;
