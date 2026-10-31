import { useLayerClipboardActions } from "@/hooks/useLayerClipboardActions";
import { ComboPreviewProvider } from "@/contexts/ComboPreviewContext";
import { isEditorInput } from "@/utils/editor-input";
import * as React from "react";

import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { PanelsProvider, usePanels } from "@/contexts/PanelsContext";
import { DragProvider, useDrag } from "@/contexts/DragContext";
import { blankKeyOnDrop } from "./blank-key-drop";
import { DragOverlay } from "@/components/DragOverlay";
import SecondarySidebar, { DETAIL_SIDEBAR_WIDTH, getDetailPanelHeight } from "./SecondarySidebar/SecondarySidebar";
import { BOTTOM_PANEL_HEIGHT } from "./BottomPanel";



import { useKeyboard } from "@/contexts/KeyboardContext";
import { cn } from "@/lib/utils";
import { useComboEditorPlacement } from "@/hooks/useComboEditorPlacement";
import LayerSelector from "./LayerSelector";
import KeyboardViewInstance from "./KeyboardViewInstance";
import LayersPlusIcon from "@/components/icons/LayersPlusIcon";
import LayersMinusIcon from "@/components/icons/LayersMinusIcon";
import AppSidebar from "./Sidebar";

import { LayerProvider, useLayer } from "@/contexts/LayerContext";
import { useLayoutLibrary } from "@/contexts/LayoutLibraryContext";
import { PasteLayerDialog } from "@/components/PasteLayerDialog";
import { DragReplaceLayerDialog } from "@/components/DragReplaceLayerDialog";
import { StorageResetDialog } from "@/components/StorageResetDialog";
import { AppFirmwareUpdates } from "@/features/firmware/AppFirmwareUpdates";
import { TrackballMismatchDialog } from "@/components/TrackballMismatchDialog";
import type { LayerEntry } from "@/types/layer-library";

import { LayoutSettingsProvider, useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { UNIT_SIZE, SVALBOARD_LAYOUT } from "@/constants/svalboard-layout";
import { THUMB_OFFSET_U, MAX_FINGER_CLUSTER_SQUEEZE_U } from "@/constants/keyboard-visuals";

import { useKeyBinding } from "@/contexts/KeyBindingContext";
// import { PanelBottom, PanelRight, X } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { MatrixTester } from "@/components/MatrixTester";

import { EditorControls } from "./EditorControls";
import BindingSpotlight, { useBindingSpotlight } from "./BindingSpotlight";
import DeepLinkEditor from "./DeepLinkEditor";
import PointingDeepLink from "./PointingDeepLink";
import TouchpadTuningDialog from "@/components/touchpad-tuning/TouchpadTuningDialog";
import PickerTray from "./PickerTray";
import { PickerTrayProvider, type PickerTrayValue } from "@/contexts/PickerTrayContext";
import { CANVAS_CONTROLS_INSET_PX, effectivePickerShape, isLShape, layoutCanvasNeed, layoutFitScale, openTraySizing, pickerShapeFromSearch, standardKeysInPlay, TRAY_MOTION_MS, trayReserve, trayState } from "@/lib/pickerShape";
import { currentRailMode, effectivePickerMode, isBindingEditorOpen, RAIL_COLLAPSE_EASE, RAIL_COLLAPSE_MS } from "@/lib/bindingSpotlight";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { getBackdropLayerFromElements } from "@/utils/layer-drop-target";
import { svalService } from "@/services/sval.service";
import {
    getLayerScenePose,
    sceneShowsGuides,
    sceneUses3D,
    LEGACY_FORWARD_ENTRY_MS,
    SCENE_COLLAPSE_MS,
    SCENE_ROTATE_IN_SPREAD_MS,
    SCENE_SPREAD_MS,
    type LayerSceneState,
} from "./layer-scene";
import { matrixTesterOpen } from "@/lib/matrix-tester-lock";

const EditorLayout = () => {
    const { assignKeycodeTo } = useKeyBinding();
    const handleUnhandledDrop = React.useMemo(() => blankKeyOnDrop(assignKeycodeTo), [assignKeycodeTo]);

    return (
        <SidebarProvider defaultOpen={false}>
            <PanelsProvider>
                <LayoutSettingsProvider>
                    <LayerProvider>
                        <DragProvider onUnhandledDrop={handleUnhandledDrop}>
                            <ComboPreviewProvider>
                                <AppFirmwareUpdates>
                                    <EditorLayoutInner />
                                </AppFirmwareUpdates>
                            </ComboPreviewProvider>
                            <DragOverlay />
                        </DragProvider>
                    </LayerProvider>
                </LayoutSettingsProvider>
            </PanelsProvider>
        </SidebarProvider>
    );
};

const EditorLayoutInner = () => {
    type ViewInstance = {
        id: string;
        selectedLayer: number;
    };

    const { keyboard } = useKeyboard();
    const { selectedLayer, setSelectedLayer } = useLayer();
    const { clearSelection } = useKeyBinding();
    const {
        keyVariant,
        layoutMode,
        setMeasuredDimensions,
        is3DMode,
        fingerClusterSqueeze,
        isThumb3DOffsetActive,
    } = useLayoutSettings();
    const { layerClipboard, openPasteDialog } = useLayoutLibrary();
    const { isDragging, draggedItem, markDropConsumed } = useDrag();

    const KC_TRNS = 1;
    const [hoveredDropLayer, setHoveredDropLayer] = React.useState<number | null>(null);
    const [pendingLayerDrop, setPendingLayerDrop] = React.useState<{
        targetLayer: number;
        targetLayerName: string;
        sourceLayerName: string;
        sourceLayerData: LayerEntry;
    } | null>(null);
    const isDraggingLayer = isDragging && draggedItem?.type === "layer" && draggedItem?.component === "Layer";

    // Dynamic view instances for stacking keyboard views
    const [viewInstances, setViewInstances] = React.useState<ViewInstance[]>([
        { id: "primary", selectedLayer: 0 }
    ]);
    const [showAllLayers, setShowAllLayers] = React.useState(true);
    const [deferGuidesRender, setDeferGuidesRender] = React.useState(false);
    const [isMultiLayersActive, setIsMultiLayersActive] = React.useState(false);
    const [sceneState, setSceneState] = React.useState<LayerSceneState>(() => (
        is3DMode ? "single3d" : "single2d"
    ));
    const [sceneTransitionViews, setSceneTransitionViews] = React.useState<ViewInstance[] | null>(null);
    const [sceneCollapseToSingle, setSceneCollapseToSingle] = React.useState(false);
    const [legacyForwardEntryActive, setLegacyForwardEntryActive] = React.useState(false);
    const [isLayerOrderReversed, setIsLayerOrderReversed] = React.useState(false);
    const layerSpacingAdjust = 410;
    const [baseBadgeOffsetY, setBaseBadgeOffsetY] = React.useState<number | null>(null);
    const handleBaseBadgeOffsetY = React.useCallback((offset: number | null) => {
        setBaseBadgeOffsetY(offset);
    }, []);
    // UI-only layer on/off state. TODO: replace with device-provided layer state when available.
    const [layerActiveState, setLayerActiveState] = React.useState<boolean[]>([]);
    const [transparencyByLayer, setTransparencyByLayer] = React.useState<Record<number, boolean>>({});
    const [isAllTransparencyActive, setIsAllTransparencyActive] = React.useState(false);
    const [isTransparencyRestoring, setIsTransparencyRestoring] = React.useState(false);
    const viewsScrollRef = React.useRef<HTMLDivElement>(null);
    const layerViewRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());
    const sceneViewRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());
    const showLayersTransitionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousSceneTargetRef = React.useRef<LayerSceneState>(is3DMode ? "single3d" : "single2d");
    const [sceneFlowOffsets, setSceneFlowOffsets] = React.useState<Record<string, number>>({});
    let nextViewId = React.useRef(1);

    // Animation: flying icon between layers-plus and layers-minus
    const addViewButtonRef = React.useRef<HTMLButtonElement>(null);
    const [flyingIcon, setFlyingIcon] = React.useState<{
        startX: number; startY: number;
        endX?: number; endY?: number;
        iconType: 'plus' | 'minus';
    } | null>(null);
    const pendingTargetId = React.useRef<string | null>(null);
    const pendingRemoveId = React.useRef<string | null>(null);
    const [revealingViewId, setRevealingViewId] = React.useState<string | null>(null);
    const [hidingViewId, setHidingViewId] = React.useState<string | null>(null);
    const [hideAddButton, setHideAddButton] = React.useState(false);
    const animationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Clean up animation timer on unmount
    React.useEffect(() => {
        return () => {
            if (animationTimerRef.current) clearTimeout(animationTimerRef.current);
            if (showLayersTransitionTimerRef.current) clearTimeout(showLayersTransitionTimerRef.current);
        };
    }, []);

    // Initialize or resize layer "isActive" state when keyboard layer count changes.
    // TODO: if/when the keyboard reports layer-on state, hydrate from that source instead.
    React.useEffect(() => {
        if (!keyboard) return;
        const totalLayers = keyboard.layers || 16;
        setLayerActiveState(prev => {
            if (!prev || prev.length === 0) {
                return Array.from({ length: totalLayers }, (_, i) => i === 0);
            }
            if (prev.length === totalLayers) return prev;
            const next = Array.from({ length: totalLayers }, (_, i) => {
                const existing = prev[i];
                if (existing === undefined) return i === 0;
                return existing;
            });
            return next;
        });
    }, [keyboard]);

    const handleAddView = React.useCallback(() => {
        const newId = `secondary-${nextViewId.current++}`;

        // Capture start position of the layers-plus button
        const rect = addViewButtonRef.current?.getBoundingClientRect();
        if (rect) {
            setFlyingIcon({ startX: rect.left, startY: rect.top, iconType: 'plus' });
            pendingTargetId.current = newId;
        }

        // Hide the add button and view until halfway through animation
        setHideAddButton(true);
        setRevealingViewId(newId);
        setViewInstances(prev => {
            const lastView = prev[prev.length - 1];
            const totalLayers = keyboard?.layers || 16;
            const nextLayer = lastView ? (lastView.selectedLayer + 1) % totalLayers : 0;
            return [...prev, { id: newId, selectedLayer: nextLayer }];
        });
    }, [keyboard?.layers]);

    // After the new view renders, find the layers-minus button and start the transition
    React.useEffect(() => {
        if (!flyingIcon || flyingIcon.endX !== undefined || !pendingTargetId.current) return;
        // Double rAF ensures DOM is painted before querying
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const target = document.querySelector(`[data-remove-view="${pendingTargetId.current}"]`);
                if (target) {
                    const targetRect = target.getBoundingClientRect();
                    setFlyingIcon(prev => prev ? {
                        ...prev,
                        endX: targetRect.left,
                        endY: targetRect.top,
                    } : null);
                    // Reveal view and add button at halfway point of the 400ms transition
                    animationTimerRef.current = setTimeout(() => {
                        setRevealingViewId(null);
                        setHideAddButton(false);
                    }, 200);
                } else {
                    // Target not found, reveal immediately
                    setFlyingIcon(null);
                    setRevealingViewId(null);
                    setHideAddButton(false);
                }
                pendingTargetId.current = null;
            });
        });
    }, [flyingIcon, viewInstances]);

    const handleRemoveView = React.useCallback((id: string) => {
        // Capture positions before any state changes
        const minusBtn = document.querySelector(`[data-remove-view="${id}"]`);
        const plusBtn = addViewButtonRef.current;

        if (minusBtn && plusBtn) {
            const minusRect = minusBtn.getBoundingClientRect();
            const plusRect = plusBtn.getBoundingClientRect();

            // Hide view and add button immediately, then animate icon horizontally back to plus
            setHideAddButton(true);
            setHidingViewId(id);
            pendingRemoveId.current = id;
            setFlyingIcon({ startX: minusRect.left, startY: minusRect.top, iconType: 'minus' });

            // Set end position after DOM paints the start position
            // Only animate X (horizontal), keep same Y since plus button will end up on this row
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setFlyingIcon(prev => prev ? {
                        ...prev,
                        endX: plusRect.left,
                        endY: prev.startY, // horizontal only
                    } : null);
                    // Remove view and show add button at halfway point of the 400ms transition
                    animationTimerRef.current = setTimeout(() => {
                        setViewInstances(prev => prev.filter(v => v.id !== pendingRemoveId.current));
                        setHidingViewId(null);
                        setHideAddButton(false);
                        pendingRemoveId.current = null;
                    }, 200);
                });
            });
        } else {
            // Fallback: remove immediately
            setViewInstances(prev => prev.filter(v => v.id !== id));
        }
    }, []);

    // Clean up flying icon when animation completes
    const handleFlyingIconEnd = React.useCallback(() => {
        setFlyingIcon(null);
    }, []);

    const handleToggleShowLayers = React.useCallback(() => {
        if (showLayersTransitionTimerRef.current) {
            clearTimeout(showLayersTransitionTimerRef.current);
        }
        // Hide guide trapezoids while layer stack animates to avoid "flash" at stale positions.
        setDeferGuidesRender(true);
        setShowAllLayers(prev => !prev);
        showLayersTransitionTimerRef.current = setTimeout(() => {
            setDeferGuidesRender(false);
            showLayersTransitionTimerRef.current = null;
        }, 560);
    }, []);

    const handleSetViewLayer = React.useCallback((id: string, layer: number) => {
        setViewInstances(prev => prev.map(v =>
            v.id === id ? { ...v, selectedLayer: layer } : v
        ));
        // Keep global layer selection tied to the primary view only.
        if (id === "primary") {
            setSelectedLayer(layer);
        }
    }, [setSelectedLayer]);

    React.useEffect(() => {
        setViewInstances(prev => prev.map(v =>
            v.id === "primary" && v.selectedLayer !== selectedLayer
                ? { ...v, selectedLayer }
                : v
        ));
    }, [selectedLayer]);

    // UI toggle for layer on/off. TODO: when hardware supports this, send the command
    // and update state from the device response instead of flipping locally.
    const handleToggleLayerOn = React.useCallback((layerIndex: number) => {
        setLayerActiveState(prev => {
            const totalLayers = keyboard?.layers || 16;
            const base = prev.length > 0
                ? [...prev]
                : Array.from({ length: totalLayers }, (_, i) => i === 0);
            if (base.length < totalLayers) {
                for (let i = base.length; i < totalLayers; i++) {
                    base[i] = i === 0;
                }
            }
            base[layerIndex] = !base[layerIndex];
            return base;
        });
    }, [keyboard?.layers]);

    const handleToggleTransparency = React.useCallback((layerIndex: number, next: boolean) => {
        setTransparencyByLayer(prev => ({ ...prev, [layerIndex]: next }));
    }, []);

    const handleToggleAllTransparency = React.useCallback(() => {
        const next = !isAllTransparencyActive;
        const totalLayers = keyboard?.layers || 16;
        const allLayersState = Array.from({ length: totalLayers }, (_, i) => i)
            .reduce<Record<number, boolean>>((acc, layerIndex) => {
                if (layerIndex > 0) acc[layerIndex] = next;
                return acc;
            }, {});
        setTransparencyByLayer(allLayersState);

        if (!next) setIsTransparencyRestoring(true);
        setIsAllTransparencyActive(next);
        if (!next) {
            requestAnimationFrame(() => {
                setIsTransparencyRestoring(false);
            });
        }
    }, [isAllTransparencyActive, keyboard?.layers]);

    // Synchronize the "All Transparency" state with individual layer states
    React.useEffect(() => {
        if (!keyboard) return;
        const totalLayers = keyboard.layers || 16;
        let allOn = true;
        let allOff = true;

        // Check layers 1 to N (layer 0 never has transparency toggle)
        for (let i = 1; i < totalLayers; i++) {
            if (transparencyByLayer[i]) {
                allOff = false;
            } else {
                allOn = false;
            }
        }

        if (allOn && !isAllTransparencyActive) {
            setIsAllTransparencyActive(true);
        } else if (allOff && isAllTransparencyActive) {
            setIsAllTransparencyActive(false);
        } else if (!allOn && !allOff && isAllTransparencyActive) {
            // Mixed state but button shows as active - sync it to off
            setIsAllTransparencyActive(false);
        }
    }, [transparencyByLayer, keyboard?.layers, isAllTransparencyActive]);

    const handleGhostNavigate = React.useCallback((sourceLayer: number) => {
        const targetEl = layerViewRefs.current.get(sourceLayer);
        const container = viewsScrollRef.current;
        if (targetEl && container) {
            const top = targetEl.offsetTop;
            container.scrollTo({ top, behavior: "smooth" });
        }
        setSelectedLayer(sourceLayer);
    }, [setSelectedLayer]);
    const primaryLayerIndex = isMultiLayersActive
        ? selectedLayer
        : (viewInstances.find(v => v.id === "primary")?.selectedLayer ?? selectedLayer);

    const primaryView = React.useMemo(
        () => ({ id: "primary", selectedLayer: primaryLayerIndex }),
        [primaryLayerIndex]
    );

    const multiLayerIds = React.useMemo(() => {
        if (!keyboard) return [] as number[];
        const totalLayers = keyboard.layers || 16;

        if (showAllLayers) {
            return Array.from({ length: totalLayers }, (_, i) => i);
        }

        const keymap = keyboard.keymap || [];
        return Array.from({ length: totalLayers }, (_, i) => i).filter((layerIndex) => {
            const layerData = keymap[layerIndex];
            const isTransparentLayer = layerData ? layerData.every((keycode) => keycode === KC_TRNS) : true;
            return !isTransparentLayer || layerIndex === primaryLayerIndex;
        });
    }, [keyboard, showAllLayers, primaryLayerIndex]);

    // In 3D multilayer mode, we keep ordering identical to 2D multilayer.

    const stackedMultiLayerViews = React.useMemo(() => {
        const extraLayers = multiLayerIds.filter(layerIndex => layerIndex !== primaryLayerIndex);
        const orderedExtras = isLayerOrderReversed ? [...extraLayers].reverse() : extraLayers;
        return [
            primaryView,
            ...orderedExtras.map(layerIndex => ({
                id: `multi-${layerIndex}`,
                selectedLayer: layerIndex
            }))
        ];
    }, [primaryView, multiLayerIds, isLayerOrderReversed, primaryLayerIndex]);
    const cloneViews = React.useCallback((views: ViewInstance[]) => (
        views.map((view) => ({ ...view }))
    ), []);

    const sceneTimeoutRefs = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
    const sceneRafRef = React.useRef<number | null>(null);

    const clearSceneTransitionWork = React.useCallback((key?: string) => {
        if (key) {
            if (sceneTimeoutRefs.current[key]) {
                clearTimeout(sceneTimeoutRefs.current[key]);
                delete sceneTimeoutRefs.current[key];
            }
        } else {
            Object.values(sceneTimeoutRefs.current).forEach(clearTimeout);
            sceneTimeoutRefs.current = {};
        }

        if (sceneRafRef.current) {
            cancelAnimationFrame(sceneRafRef.current);
            sceneRafRef.current = null;
        }
    }, [sceneTimeoutRefs, sceneRafRef]);

    const scheduleSceneTimeout = React.useCallback(
        (keyOrMs: string | number, msOrCallback: number | (() => void), maybeCallback?: () => void) => {
            let key: string;
            let ms: number;
            let cb: () => void;
            if (typeof keyOrMs === 'string') {
                key = keyOrMs;
                ms = msOrCallback as number;
                cb = maybeCallback!;
            } else {
                key = "default";
                ms = keyOrMs;
                cb = msOrCallback as () => void;
            }
            clearSceneTransitionWork(key);
            sceneTimeoutRefs.current[key] = setTimeout(() => {
                delete sceneTimeoutRefs.current[key];
                cb();
            }, ms);
        },
        [clearSceneTransitionWork]
    );

    const requiredSceneFlowOffsetsReady = React.useCallback((views: ViewInstance[]) => (
        views.every((view) => view.id === "primary" || sceneFlowOffsets[view.id] !== undefined)
    ), [sceneFlowOffsets]);

    const sceneTargetState = React.useMemo<LayerSceneState>(() => {
        if (isMultiLayersActive) {
            return is3DMode ? "multi3d" : "multi2d";
        }
        return is3DMode ? "single3d" : "single2d";
    }, [is3DMode, isMultiLayersActive]);

    const renderedViews = React.useMemo(() => {
        if (sceneTransitionViews) {
            return sceneTransitionViews;
        }
        if (isMultiLayersActive) {
            return stackedMultiLayerViews;
        }
        return viewInstances;
    }, [isMultiLayersActive, sceneTransitionViews, stackedMultiLayerViews, viewInstances]);

    const handleToggleMultiLayers = React.useCallback(() => {
        setIsMultiLayersActive((prev) => !prev);
    }, []);

    React.useLayoutEffect(() => {
        const previousSceneTarget = previousSceneTargetRef.current;
        if (previousSceneTarget === sceneTargetState) {
            return;
        }

        clearSceneTransitionWork();

        // Proactively clear legacy entry when switching to a multi-layer state
        // that isn't the initial expansion/spread entry.
        if (sceneTargetState.startsWith("multi") && 
            sceneTargetState !== "multi3d_pre_expand" && 
            sceneTargetState !== "multi3d_pre_spread") {
            setLegacyForwardEntryActive(false);
        }

        // Always ensure legacy entry is cleared when we start any serious multi-layer movement.
        // This is a safety fallback for environments (like tests) where 3D transitions might skip phases.
        if (sceneTargetState.startsWith("multi")) {
            setLegacyForwardEntryActive(false);
        }

        previousSceneTargetRef.current = sceneTargetState;

        const currentMultiViews = cloneViews(sceneTransitionViews ?? stackedMultiLayerViews);

        switch (`${previousSceneTarget}->${sceneTargetState}`) {
            case "single3d->multi3d":
                setLegacyForwardEntryActive(true);
                setSceneCollapseToSingle(false);
                setSceneTransitionViews(cloneViews(stackedMultiLayerViews));
                setSceneState("multi3d_pre_expand");
                return;
            case "single2d->multi3d":
                setLegacyForwardEntryActive(true);
                setSceneCollapseToSingle(false);
                setSceneFlowOffsets({});
                setSceneTransitionViews(cloneViews(stackedMultiLayerViews));
                setSceneState("multi3d_pre_spread");
                return;
            case "multi2d->multi3d":
                setLegacyForwardEntryActive(false);
                setSceneCollapseToSingle(false);
                setSceneTransitionViews(cloneViews(stackedMultiLayerViews));
                setSceneState("multi3d_rotating_in");
                scheduleSceneTimeout("spread", SCENE_SPREAD_MS, () => {
                    setSceneState("multi3d_spreading");
                });
                scheduleSceneTimeout("settle", SCENE_SPREAD_MS + SCENE_ROTATE_IN_SPREAD_MS, () => {
                    setSceneState("multi3d");
                    setSceneTransitionViews(null);
                });
                return;
            case "multi3d->single3d":
            case "multi3d->single2d":
                setLegacyForwardEntryActive(false);
                setSceneCollapseToSingle(true);
                setSceneTransitionViews(currentMultiViews);
                setSceneState("multi3d_pre_collapse");
                return;
            case "multi3d->multi2d":
                setLegacyForwardEntryActive(false);
                setSceneCollapseToSingle(false);
                setSceneTransitionViews(currentMultiViews);
                setSceneState("multi3d_collapsing");
                scheduleSceneTimeout("rotate-out", SCENE_SPREAD_MS, () => {
                    setSceneState("multi2d_rotating_out");
                });
                scheduleSceneTimeout("settle", SCENE_SPREAD_MS + SCENE_SPREAD_MS, () => {
                    setSceneState("multi2d");
                    setSceneTransitionViews(null);
                });
                return;
            default:
                setLegacyForwardEntryActive(false);
                setSceneCollapseToSingle(false);
                setSceneTransitionViews(null);
                setSceneState(sceneTargetState);
        }
    }, [
        clearSceneTransitionWork,
        cloneViews,
        sceneTargetState,
        sceneTransitionViews,
        scheduleSceneTimeout,
        stackedMultiLayerViews,
    ]);

    // Safety fallback: ensure legacy forward entry is cleared even if 3D transitions
    // are blocked or skipped (common in test environments with zero offsets).
    // This effect is independent and won't be cleared by clearSceneTransitionWork().
    React.useLayoutEffect(() => {
        if (!legacyForwardEntryActive) return;

        const timeout = setTimeout(() => {
            setLegacyForwardEntryActive(false);
            // If we're stuck in a pre-spread/pre-expand state, force-settle to multi3d
            // so guides can at least render.
            setSceneState((current) => {
                if (current === "multi3d_pre_spread" || current === "multi3d_pre_expand") {
                    return "multi3d";
                }
                return current;
            });
        }, LEGACY_FORWARD_ENTRY_MS);

        return () => clearTimeout(timeout);
    }, [legacyForwardEntryActive]);

    React.useLayoutEffect(() => {
        if (legacyForwardEntryActive || sceneState !== "multi3d_pre_spread" || !sceneTransitionViews) {
            return;
        }
        if (!requiredSceneFlowOffsetsReady(sceneTransitionViews)) {
            return;
        }

        clearSceneTransitionWork();
        sceneRafRef.current = requestAnimationFrame(() => {
            sceneRafRef.current = requestAnimationFrame(() => {
                setLegacyForwardEntryActive(false);
                setSceneState("multi3d_spreading");
                sceneRafRef.current = null;
                scheduleSceneTimeout("settle", SCENE_SPREAD_MS, () => {
                    setLegacyForwardEntryActive(false);
                    setSceneState("multi3d");
                    setSceneTransitionViews(null);
                });
            });
        });
    }, [
        clearSceneTransitionWork,
        legacyForwardEntryActive,
        requiredSceneFlowOffsetsReady,
        sceneState,
        sceneTransitionViews,
        scheduleSceneTimeout,
    ]);

    // multi3d_pre_expand: layers rendered at spread positions but invisible.
    // Wait for flow offsets, then imperatively snap to collapsed position before paint,
    // then animate to spread via single rAF.
    React.useLayoutEffect(() => {
        if (sceneState !== "multi3d_pre_expand" || !sceneTransitionViews) {
            return;
        }
        if (!requiredSceneFlowOffsetsReady(sceneTransitionViews)) {
            return;
        }

        clearSceneTransitionWork();

        // Imperatively snap non-primary views to collapsed position BEFORE browser paints.
        // This avoids the bounce caused by views appearing at spread positions.
        // Note: sceneViewRefs points to the outer wrapper div, but rootTranslateY/opacity
        // are applied on the KVI root div (data-keyboard-view-instance), so we target that.
        sceneTransitionViews.forEach((view) => {
            if (view.id === "primary") return;
            const outerEl = sceneViewRefs.current.get(view.id);
            if (!outerEl) return;
            const kviRoot = outerEl.querySelector(`[data-keyboard-view-instance="${view.id}"]`) as HTMLElement | null;
            if (!kviRoot) return;
            const flowOffset = sceneFlowOffsets[view.id] ?? 0;
            // KVI root: snap to collapsed position (at primary), no transition
            kviRoot.style.transition = "none";
            kviRoot.style.opacity = "0";
            kviRoot.style.transform = `translateY(${-flowOffset}px)`;
            // Inner keyboard wrapper: snap translateZ to 0
            const kbWrapper = outerEl.querySelector(".keyboard-3d-active") as HTMLElement | null;
            if (kbWrapper) {
                kbWrapper.style.transition = "none";
                kbWrapper.style.transform = `rotateX(55deg) rotateZ(-45deg) translateZ(0px)`;
            }
        });

        // Force style resolution so the browser registers collapsed positions
        void document.body.offsetHeight;

        // Single rAF: apply spreading transition imperatively from collapsed positions.
        // React will sync to multi3d_spreading state, but the imperative styles ensure
        // the transition starts from the correct collapsed positions.
        sceneRafRef.current = requestAnimationFrame(() => {
            const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
            const ms = SCENE_SPREAD_MS;
            sceneTransitionViews?.forEach((view, index) => {
                if (view.id === "primary") return;
                const outerEl = sceneViewRefs.current.get(view.id);
                if (!outerEl) return;
                const kviRoot = outerEl.querySelector(`[data-keyboard-view-instance="${view.id}"]`) as HTMLElement | null;
                if (!kviRoot) return;
                // Animate KVI root to natural position
                kviRoot.style.transition = `opacity ${ms}ms ${easing}, transform ${ms}ms ${easing}`;
                kviRoot.style.opacity = "1";
                kviRoot.style.transform = "translateY(0px)";
                // Animate keyboard wrapper to spread depth
                const kbWrapper = outerEl.querySelector(".keyboard-3d-active") as HTMLElement | null;
                if (kbWrapper) {
                    const stackIdx = index;
                    // Compute the same effective spacing used by getLayerScenePose
                    const spacing = keyVariant === "medium" ? 330 : keyVariant === "small" ? 260 : layerSpacingAdjust;
                    const layeredZ = stackIdx * spacing;
                    kbWrapper.style.transition = `transform ${ms}ms ${easing}`;
                    kbWrapper.style.transform = `rotateX(55deg) rotateZ(-45deg) translateZ(${layeredZ}px)`;
                }
            });
            // Sync React state (rendered values will match imperative values)
            setLegacyForwardEntryActive(false);
            setSceneState("multi3d_spreading");
            sceneRafRef.current = null;
            scheduleSceneTimeout("settle", ms, () => {
                setLegacyForwardEntryActive(false);
                // Don't clear imperative styles — React's style reconciliation is
                // prop-based (compares old vs new style props, not DOM values).
                // Since multi3d and multi3d_spreading have the same transform/opacity
                // prop values, React won't re-set them if we clear them from the DOM.
                // Just remove the transition so it doesn't interfere with future changes.
                sceneTransitionViews?.forEach((view) => {
                    if (view.id === "primary") return;
                    const outerEl = sceneViewRefs.current.get(view.id);
                    if (!outerEl) return;
                    const kviRoot = outerEl.querySelector(`[data-keyboard-view-instance="${view.id}"]`) as HTMLElement | null;
                    if (kviRoot) {
                        kviRoot.style.transition = "none";
                    }
                    const kbWrapper = outerEl.querySelector(".keyboard-3d-active") as HTMLElement | null;
                    if (kbWrapper) {
                        kbWrapper.style.transition = "none";
                    }
                });
                setSceneState("multi3d");
                setSceneTransitionViews(null);
            });
        });
    }, [
        clearSceneTransitionWork,
        keyVariant,
        layerSpacingAdjust,
        requiredSceneFlowOffsetsReady,
        sceneFlowOffsets,
        sceneState,
        sceneTransitionViews,
        scheduleSceneTimeout,
    ]);

    React.useLayoutEffect(() => {
        if (sceneState !== "multi3d_pre_collapse" || !sceneTransitionViews) {
            return;
        }

        clearSceneTransitionWork();
        sceneRafRef.current = requestAnimationFrame(() => {
            setSceneState("multi3d_collapsing");
            sceneRafRef.current = null;
            scheduleSceneTimeout("settle", SCENE_COLLAPSE_MS, () => {
                setSceneState(sceneTargetState);
                setSceneTransitionViews(null);
                setSceneCollapseToSingle(false);
            });
        });
    }, [
        clearSceneTransitionWork,
        sceneState,
        sceneTargetState,
        sceneTransitionViews,
        scheduleSceneTimeout,
    ]);

    React.useEffect(() => {
        return () => {
            clearSceneTransitionWork();
        };
    }, [clearSceneTransitionWork]);

    const isScene3D = sceneUses3D(sceneState);
    const isSceneInMultiStack = renderedViews.length > 1 && (
        sceneTransitionViews !== null ||
        isMultiLayersActive ||
        sceneState === "multi3d_pre_spread" ||
        sceneState === "multi3d_pre_expand" ||
        sceneState === "multi3d_rotating_in" ||
        sceneState === "multi3d_spreading" ||
        sceneState === "multi3d" ||
        sceneState === "multi3d_pre_collapse" ||
        sceneState === "multi3d_collapsing" ||
        sceneState === "multi2d_rotating_out"
    );

    React.useLayoutEffect(() => {
        if (!isSceneInMultiStack) {
            setSceneFlowOffsets((prev) => (
                Object.keys(prev).length === 0 ? prev : {}
            ));
            return;
        }

        const primaryEl = sceneViewRefs.current.get("primary");
        if (!primaryEl) return;

        const primaryOffsetTop = primaryEl.offsetTop;
        const nextOffsets: Record<string, number> = {};
        renderedViews.forEach((view) => {
            const el = sceneViewRefs.current.get(view.id);
            if (!el) return;
            nextOffsets[view.id] = el.offsetTop - primaryOffsetTop;
        });
        setSceneFlowOffsets((prev) => {
            const prevKeys = Object.keys(prev);
            const nextKeys = Object.keys(nextOffsets);
            const hasSameKeys = prevKeys.length === nextKeys.length && nextKeys.every((key) => prev[key] !== undefined);
            if (hasSameKeys && nextKeys.every((key) => prev[key] === nextOffsets[key])) {
                return prev;
            }
            return nextOffsets;
        });
    }, [isSceneInMultiStack, renderedViews]);

    const effectiveLayerSpacing = React.useMemo(() => {
        if (isScene3D && isSceneInMultiStack) {
            if (keyVariant === "medium") return 330;
            if (keyVariant === "small") return 260;
        }
        return layerSpacingAdjust;
    }, [isScene3D, isSceneInMultiStack, keyVariant, layerSpacingAdjust]);

    const threeDTopScrollReservePx = React.useMemo(() => {
        if (!isScene3D) return 0;
        return 260;
    }, [isScene3D]);

    const threeDBottomScrollReservePx = React.useMemo(() => {
        if (!isScene3D) return 0;
        return isSceneInMultiStack ? 120 : 900;
    }, [isScene3D, isSceneInMultiStack]);

    const threeDEntryCompensationPx = React.useMemo(() => {
        if (!is3DMode) return 0;
        // Single-layer 3D uses fixed layer tabs outside the scroll flow,
        // so it needs less entry compensation to keep all keys visible.
        return isMultiLayersActive ? threeDTopScrollReservePx : 180;
    }, [is3DMode, isMultiLayersActive, threeDTopScrollReservePx]);

    const was3DModeRef = React.useRef(is3DMode);
    const last3DEntryCompensationRef = React.useRef(0);
    const pending3DAdjustRafRef = React.useRef<number | null>(null);

    React.useLayoutEffect(() => {
        const container = viewsScrollRef.current;
        const was3D = was3DModeRef.current;
        if (!container) {
            was3DModeRef.current = is3DMode;
            return;
        }

        if (pending3DAdjustRafRef.current !== null) {
            cancelAnimationFrame(pending3DAdjustRafRef.current);
            pending3DAdjustRafRef.current = null;
        }

        // Preserve the exact visual entry position when toggling 3D while
        // still adding extra scroll room above the scene.
        if (!was3D && is3DMode) {
            const targetTop = container.scrollTop + threeDEntryCompensationPx;
            last3DEntryCompensationRef.current = threeDEntryCompensationPx;
            const raf1 = requestAnimationFrame(() => {
                const raf2 = requestAnimationFrame(() => {
                    const current = viewsScrollRef.current;
                    if (!current) return;
                    current.scrollTop = targetTop;
                    pending3DAdjustRafRef.current = null;
                });
                pending3DAdjustRafRef.current = raf2;
            });
            pending3DAdjustRafRef.current = raf1;
        } else if (was3D && !is3DMode) {
            container.scrollTop = Math.max(0, container.scrollTop - last3DEntryCompensationRef.current);
            last3DEntryCompensationRef.current = 0;
        }

        was3DModeRef.current = is3DMode;

        return () => {
            if (pending3DAdjustRafRef.current !== null) {
                cancelAnimationFrame(pending3DAdjustRafRef.current);
                pending3DAdjustRafRef.current = null;
            }
        };
    }, [is3DMode, threeDEntryCompensationPx]);

    // Badge positioning handled per-layer in KeyboardViewInstance to keep layout/badge relationship consistent.

    // Ref for measuring container dimensions
    const contentContainerRef = React.useRef<HTMLDivElement>(null);

    // Use dynamic keylayout if available, otherwise fallback to hardcoded layout
    const keyboardLayout = React.useMemo(() => (
        (keyboard?.keylayout && Object.keys(keyboard.keylayout).length > 0)
            ? keyboard.keylayout as Record<number, { x: number; y: number; w: number; h: number }>
            : SVALBOARD_LAYOUT
    ), [keyboard]);

    // Calculate keyboard layout extents (independent of current keyVariant)
    const keyboardExtents = React.useMemo(() => {
        if (!keyboard) return { maxX: 20, maxY: 10 }; // default estimate

        const useFragmentLayout = keyboard.keylayout && Object.keys(keyboard.keylayout).length > 0;

        // Find max X and Y extents
        let maxX = 0;
        let maxY = 0;
        Object.values(keyboardLayout).forEach((key) => {
            // Only apply THUMB_OFFSET_U for hardcoded layout, not fragment-composed layouts
            const yPos = (!useFragmentLayout && key.y >= 6) ? key.y + THUMB_OFFSET_U : key.y;
            maxX = Math.max(maxX, key.x + key.w);
            maxY = Math.max(maxY, yPos + key.h);
        });

        return { maxX, maxY };
    }, [keyboard]);

    // Current key unit size based on variant
    const currentUnitSize = React.useMemo(() =>
        keyVariant === 'small' ? 30 : keyVariant === 'medium' ? 45 : UNIT_SIZE,
        [keyVariant]);

    // Track container height for dynamic spacing
    const [containerHeight, setContainerHeight] = React.useState(0);
    // The canvas's width: the layout is scaled to fit it, never cropped.
    const [canvasWidth, setCanvasWidth] = React.useState(0);


    // Raw keyboard widths without squeeze (used for squeeze calculation)
    const rawKeyboardWidths = React.useMemo(() => ({
        default: keyboardExtents.maxX * UNIT_SIZE + 32, // +32 for padding
        medium: keyboardExtents.maxX * 45 + 32,
        small: keyboardExtents.maxX * 30 + 32,
    }), [keyboardExtents]);

    // Calculate keyboard widths at each size (for auto-sizing)
    // Account for max squeeze capability - both sides can squeeze toward center
    const squeezeReduction = 2 * MAX_FINGER_CLUSTER_SQUEEZE_U;
    const keyboardWidths = React.useMemo(() => ({
        default: rawKeyboardWidths.default, // no squeeze at default
        medium: (keyboardExtents.maxX - squeezeReduction) * 45 + 32, // squeeze enabled
        small: rawKeyboardWidths.small, // no squeeze at small (already compact)
    }), [keyboardExtents, squeezeReduction, rawKeyboardWidths]);

    // Calculate keyboard heights at each size (for auto-sizing)
    const keyboardHeights = React.useMemo(() => ({
        default: keyboardExtents.maxY * UNIT_SIZE + 80, // +80 for layer selector and bottom bar
        medium: keyboardExtents.maxY * 45 + 80,
        small: keyboardExtents.maxY * 30 + 80,
    }), [keyboardExtents]);



    const { apply: applyClipboardLayer, clipboardError, clearClipboardError } = useLayerClipboardActions();
    const [layerPasteError, setLayerPasteError] = React.useState<string | null>(null);

    // Ctrl+V handler for pasting layers
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (matrixTesterOpen()) return;
            // Check for Ctrl+V (or Cmd+V on Mac)
            if (!e.defaultPrevented && !e.repeat && !isEditorInput(e.target) && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                // Only handle if we have a layer in clipboard
                if (layerClipboard) {
                    e.preventDefault();
                    openPasteDialog();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [layerClipboard, openPasteDialog]);

    const getLayerName = React.useCallback((layerIndex: number) => {
        if (!keyboard) return `Layer ${layerIndex}`;
        return svalService.getLayerName(keyboard, layerIndex);
    }, [keyboard]);

    const applyLayerToTarget = (sourceLayer: LayerEntry, targetLayer: number) => {
        clearClipboardError();
        setLayerPasteError(null);
        try { applyClipboardLayer(sourceLayer, targetLayer); }
        catch (error) { setLayerPasteError(error instanceof Error ? error.message : "Could not paste the layer."); }
    };

    // Handler for when clipboard paste is confirmed
    const handlePasteConfirm = React.useCallback(() => {
        if (!layerClipboard) return;
        applyLayerToTarget(layerClipboard.layer, selectedLayer);
    }, [layerClipboard, selectedLayer, applyLayerToTarget]);

    const handleLayerDropHover = React.useCallback((layer: number | null) => {
        if (!isDraggingLayer) return;
        setHoveredDropLayer(layer);
    }, [isDraggingLayer]);

    const getLayerDropTargetAtPoint = React.useCallback((clientX: number, clientY: number) => {
        if (!isDraggingLayer) return null;

        return getBackdropLayerFromElements(
            document.elementsFromPoint(clientX, clientY) as HTMLElement[],
        );
    }, [isDraggingLayer]);

    const handleLayerDrop = React.useCallback((targetLayer: number) => {
        if (!isDraggingLayer || !draggedItem?.layerData) return;
        markDropConsumed();
        setHoveredDropLayer(null);
        setPendingLayerDrop({
            targetLayer,
            targetLayerName: getLayerName(targetLayer),
            sourceLayerName: draggedItem.layerData.name,
            sourceLayerData: draggedItem.layerData,
        });
    }, [isDraggingLayer, draggedItem, markDropConsumed, getLayerName]);

    React.useEffect(() => {
        if (!isDraggingLayer) {
            setHoveredDropLayer(null);
        }
    }, [isDraggingLayer]);

    React.useEffect(() => {
        if (!isDraggingLayer || !is3DMode) return;

        const handleMouseMove = (event: MouseEvent) => {
            setHoveredDropLayer(getLayerDropTargetAtPoint(event.clientX, event.clientY));
        };

        const handleMouseUp = (event: MouseEvent) => {
            const targetLayer = getLayerDropTargetAtPoint(event.clientX, event.clientY);
            if (targetLayer !== null) {
                handleLayerDrop(targetLayer);
            } else {
                setHoveredDropLayer(null);
            }
        };

        window.addEventListener('mousemove', handleMouseMove, true);
        window.addEventListener('mouseup', handleMouseUp, true);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove, true);
            window.removeEventListener('mouseup', handleMouseUp, true);
        };
    }, [isDraggingLayer, is3DMode, getLayerDropTargetAtPoint, handleLayerDrop]);

    const handleDragReplaceConfirm = React.useCallback(() => {
        if (!pendingLayerDrop) return;
        applyLayerToTarget(pendingLayerDrop.sourceLayerData, pendingLayerDrop.targetLayer);
        setPendingLayerDrop(null);
    }, [pendingLayerDrop, applyLayerToTarget]);

    const handleDragReplaceCancel = React.useCallback(() => {
        setPendingLayerDrop(null);
    }, []);

    // Get current layer name for the paste dialog
    const currentLayerName = React.useMemo(() => getLayerName(selectedLayer), [getLayerName, selectedLayer]);



    const primarySidebar = useSidebar("primary-nav", { defaultOpen: false });
    const { isMobile, state, activePanel, itemToEdit, pickerMode: chosenPickerMode = "keyboard" } = usePanels();
    // While a binding editor is open, only the keyboard canvas (with its layer
    // tabs and keys), the editor, the picker and the rail's picker categories
    // stay usable; the rest of this column sits under the spotlight scrim.
    const spotlight = useBindingSpotlight();
    // The matrix tester uses the same scrim (drawn by MatrixTester): the canvas is lifted
    // above it and the layer bar and size controls go out of reach, as for an editor.
    const testerSpotlight = activePanel === "matrixtester";
    const covered = spotlight || testerSpotlight;
    const railMode = React.useMemo(currentRailMode, []);

    // Editor overlay state for bottom bar mode



    // Check if we should show the editor overlay in bottom bar mode
    const showEditorOverlay = layoutMode === "bottombar" && itemToEdit !== null &&
        ["tapdances", "combos", "macros", "overrides", "altrepeat", "leaders"].includes(activePanel || "");

    const [gitBranchLabel, setGitBranchLabel] = React.useState<string>(__GIT_BRANCH__);

    React.useEffect(() => {
        if (!import.meta.env.DEV) return;
        let isMounted = true;
        fetch("/__git_branch")
            .then(res => res.json())
            .then(data => {
                if (isMounted && data?.branch) {
                    setGitBranchLabel(String(data.branch));
                }
            })
            .catch(() => undefined);
        return () => {
            isMounted = false;
        };
    }, []);

    // Layout mode determines whether we use sidebar or bottom panel
    const useSidebarLayout = layoutMode === "sidebar";
    const useBottomLayout = layoutMode === "bottombar";

    const primaryOffset = primarySidebar.isMobile ? undefined : primarySidebar.state === "collapsed" ? "var(--sidebar-width-icon)" : "var(--sidebar-width-base)";

    // In sidebar mode: show detail sidebar on right
    // In bottom bar mode: no detail sidebar, use bottom panel instead
    const showDetailsSidebar = useSidebarLayout && !isMobile && state === "expanded";
    const showBottomPanel = useBottomLayout && state === "expanded";

    const [isConstrainedViewport, setIsConstrainedViewport] = React.useState(() => window.innerWidth < 1100);
    React.useEffect(() => {
        const update = () => setIsConstrainedViewport(window.innerWidth < 1100);
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, []);

    const contentOffset = showDetailsSidebar && !isConstrainedViewport
        ? `calc(${primaryOffset ?? "0px"} + ${DETAIL_SIDEBAR_WIDTH} + 6px)`
        : primaryOffset ?? undefined;

    // Calculate dynamic top padding for keyboard
    // Ideal: 1 key height gap between layer selector and keyboard
    // Squeeze: reduce gap when space is tight, continuous adjustment
    const dynamicTopPadding = React.useMemo(() => {
        const idealGap = currentUnitSize; // 1 key height
        const minGap = 8; // Minimum gap in pixels

        // Estimate heights: layer selector ~46px (compact) or ~86px (standard)
        const layerSelectorHeight = showEditorOverlay ? 46 : 86;
        const bottomBarHeight = showBottomPanel ? BOTTOM_PANEL_HEIGHT : 0;

        // Get current keyboard height based on variant
        const kbHeight = keyVariant === 'small'
            ? keyboardHeights.small
            : keyVariant === 'medium'
                ? keyboardHeights.medium
                : keyboardHeights.default;

        // Available space = container - layer selector - keyboard - bottom bar
        const availableSpace = containerHeight - layerSelectorHeight - kbHeight - bottomBarHeight;

        // If plenty of room, use ideal gap (1 key height)
        // If tight, scale down continuously but keep minimum
        if (availableSpace >= idealGap) {
            return idealGap;
        } else if (availableSpace > minGap) {
            return availableSpace;
        } else {
            return minGap;
        }
    }, [currentUnitSize, containerHeight, keyboardHeights, keyVariant, showEditorOverlay, showBottomPanel]);

    // Calculate dynamic bottom panel height to fill remaining vertical space
    const dynamicBottomPanelHeight = React.useMemo(() => {
        if (!showBottomPanel) return BOTTOM_PANEL_HEIGHT;

        const MIN_HEIGHT = 150;
        const MAX_HEIGHT = 400;
        const layerSelectorHeight = 86;
        const topPadding = dynamicTopPadding;

        // Get current keyboard height based on variant
        const kbHeight = keyVariant === 'small'
            ? keyboardHeights.small
            : keyVariant === 'medium'
                ? keyboardHeights.medium
                : keyboardHeights.default;

        // Available = container - layerSelector - topPadding - keyboard
        const available = containerHeight - layerSelectorHeight - topPadding - kbHeight;

        return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, available));
    }, [showBottomPanel, containerHeight, keyboardHeights, keyVariant, dynamicTopPadding]);

    const bottomPanelHeight = getDetailPanelHeight(activePanel, dynamicBottomPanelHeight);

    // L-shaped picker (design fork, ?pickerShape=L): the Standard Keys
    // keyboard sits in a tray under the layout, the same surface as the side
    // panel. Side-panel layout only; the bottom bar keeps its own tray.
    const requestedPickerShape = React.useMemo(() => pickerShapeFromSearch(window.location.search), []);
    const pickerShape = effectivePickerShape(requestedPickerShape, layoutMode);
    const lShape = isLShape(pickerShape) && showDetailsSidebar;

    // The layout always shows its full width. Its laid-out width at the key
    // size in use (after the finger clusters squeeze in), scaled down
    // continuously when even that does not fit the canvas. 2D only: the 3D
    // scene keeps its own framing.
    const layoutNaturalWidth = rawKeyboardWidths[keyVariant] - 2 * fingerClusterSqueeze * currentUnitSize;
    const layoutScale = isScene3D ? 1 : layoutFitScale(canvasWidth, layoutNaturalWidth);
    // Single-combo editing keeps the whole keyboard visible: the editor sits
    // below it (or floats clear of it) and reserves the height it needs here.
    const { placement: savedComboEditorPlacement } = useComboEditorPlacement();
    // The L shape keeps every editor pinned at the top of the side panel.
    const comboEditorPlacement = isLShape(pickerShape) ? "panel" : savedComboEditorPlacement;
    const [comboEditorReserve, setComboEditorReserve] = React.useState(0);
    const editorOpen = isBindingEditorOpen(activePanel, itemToEdit);
    const trayInputs = {
        panelOpen: showDetailsSidebar,
        editorOpen,
        activePanel,
        pickerMode: effectivePickerMode(chosenPickerMode, activePanel),
    };
    const trayInPlay = lShape && standardKeysInPlay(trayInputs);
    // Collapsed (or, over the layers, expanded) by hand; any change of what is picked resets it.
    const [trayToggled, setTrayToggled] = React.useState(false);
    const trayContextKey = `${trayInPlay}|${isMultiLayersActive}|${editorOpen ? `${activePanel}:${itemToEdit}:${trayInputs.pickerMode}` : activePanel}`;
    const [trayKeyFor, setTrayKeyFor] = React.useState(trayContextKey);
    if (trayKeyFor !== trayContextKey) {
        setTrayKeyFor(trayContextKey);
        setTrayToggled(false);
    }
    const currentTrayState = trayState({ ...trayInputs, shape: lShape ? pickerShape : "rect", multiLayer: isMultiLayersActive, toggled: trayToggled });
    const [viewportHeight, setViewportHeight] = React.useState(() => window.innerHeight);
    React.useEffect(() => {
        const update = () => setViewportHeight(window.innerHeight);
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, []);
    // The layout keeps exactly the height its content needs at the key size in
    // use (Auto's pick or the user's), measured as laid out; the open tray takes
    // the rest. Measured only while the tray is open over a single layer: the
    // multi-layer view keeps the tray at its handle as before.
    const canvasControlsRef = React.useRef<HTMLDivElement>(null);
    const [layoutExtent, setLayoutExtent] = React.useState({ top: 0, need: 0 });
    const measureLayout = trayInPlay && !isMultiLayersActive;
    React.useLayoutEffect(() => {
        if (!measureLayout) {
            setLayoutExtent(prev => prev.need === 0 ? prev : { top: prev.top, need: 0 });
            return;
        }
        const canvas = viewsScrollRef.current;
        const container = contentContainerRef.current;
        if (!canvas || !container) return;
        const measure = () => {
            const canvasBox = canvas.getBoundingClientRect();
            let contentBottom = 0;
            let keyboardBottom = 0;
            for (const el of Array.from(canvas.children)) {
                if (!(el instanceof HTMLElement)) continue;
                const position = getComputedStyle(el).position;
                if (position === "absolute" || position === "fixed") continue;
                const bottom = el.getBoundingClientRect().bottom - canvasBox.top + canvas.scrollTop;
                contentBottom = Math.max(contentBottom, bottom);
                if (el.hasAttribute("data-layout-keyboard")) keyboardBottom = bottom;
            }
            const top = Math.round(canvas.getBoundingClientRect().top - container.getBoundingClientRect().top);
            const need = layoutCanvasNeed({ contentBottom, keyboardBottom, controlsHeight: canvasControlsRef.current?.offsetHeight ?? 0 });
            setLayoutExtent(prev => prev.top === top && prev.need === need ? prev : { top, need });
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(canvas);
        for (const el of Array.from(canvas.children)) observer.observe(el);
        if (canvasControlsRef.current) observer.observe(canvasControlsRef.current);
        return () => observer.disconnect();
    }, [measureLayout, keyVariant, activePanel, is3DMode, layoutScale]);
    // The tray's keyboard as laid out: the fallback size fits it.
    const [trayContentHeight, setTrayContentHeight] = React.useState(0);
    const traySizing = openTraySizing({
        viewportHeight,
        canvasTop: layoutExtent.top,
        layoutNeed: layoutExtent.need,
        reserveBelow: comboEditorReserve,
        contentHeight: trayContentHeight,
    });
    const openTrayHeight = traySizing.height;
    const trayFills = lShape && currentTrayState === "open" && traySizing.fills;
    const layoutTrayReserve = lShape ? trayReserve(currentTrayState, openTrayHeight) : 0;
    const reducedMotion = usePrefersReducedMotion();
    const [trayHeader, setTrayHeader] = React.useState<HTMLElement | null>(null);
    const [trayBody, setTrayBody] = React.useState<HTMLElement | null>(null);
    const trayValue = React.useMemo<PickerTrayValue>(() => lShape
        ? { header: trayHeader, body: trayBody, keyboardHeight: traySizing.keyboardHeight }
        : { header: null, body: null, keyboardHeight: 0 },
    [lShape, trayHeader, trayBody, traySizing.keyboardHeight]);

    // Measure container dimensions and report to context for auto-sizing
    React.useEffect(() => {
        const container = contentContainerRef.current;
        if (!container) return;

        const measureSpace = () => {
            const canvas = viewsScrollRef.current;
            const containerWidth = canvas?.clientWidth ?? container.clientWidth;
            const height = container.clientHeight;

            // Track container height for dynamic spacing
            setContainerHeight(height);
            setCanvasWidth(containerWidth);

            // Report measured dimensions to context for auto-sizing
            setMeasuredDimensions({
                containerWidth,
                containerHeight: canvas?.clientHeight ?? height,
                keyboardWidths,
                keyboardHeights,
                rawKeyboardWidths,
                widthOnly: lShape,
            });
        };

        // Initial measurement
        measureSpace();

        // Set up ResizeObserver for dynamic updates
        const resizeObserver = new ResizeObserver(measureSpace);
        resizeObserver.observe(container);
        if (viewsScrollRef.current) resizeObserver.observe(viewsScrollRef.current);

        return () => resizeObserver.disconnect();
    }, [keyboardWidths, keyboardHeights, rawKeyboardWidths, setMeasuredDimensions, lShape]);

    const getPrimaryKeyboardElement = React.useCallback(
        () => sceneViewRefs.current.get("primary") ?? layerViewRefs.current.get(selectedLayer) ?? null,
        [selectedLayer],
    );

    const contentStyle = React.useMemo<React.CSSProperties>(() => {
        // The L tray's reserve includes the 8px gap under it, as the side panel has.
        const panelPadding = showBottomPanel ? bottomPanelHeight : layoutTrayReserve > 0 ? layoutTrayReserve + 8 : 0;
        const panelCss = typeof panelPadding === "number" ? `${panelPadding}px` : panelPadding;
        // ?railMode=collapse: the layout takes the rail's width in step with it (250ms; none with reduced motion).
        const marginMotion = railMode === "collapse"
            ? (reducedMotion ? "0ms" : `${RAIL_COLLAPSE_MS}ms ${RAIL_COLLAPSE_EASE}`)
            : "320ms cubic-bezier(0.22, 1, 0.36, 1)";
        const paddingMotion = lShape ? (reducedMotion ? "0ms" : `${TRAY_MOTION_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`) : "300ms ease-in-out";
        return {
            marginLeft: contentOffset,
            transition: `margin-left ${marginMotion}, padding-bottom ${paddingMotion}`,
            willChange: "margin-left, padding-bottom",
            // Add bottom padding when bottom panel is shown, plus whatever the
            // combo editor reserves under the keyboard.
            paddingBottom: comboEditorReserve > 0 ? `calc(${panelCss} + ${comboEditorReserve}px)` : panelPadding,
        };
    }, [contentOffset, showBottomPanel, bottomPanelHeight, comboEditorReserve, layoutTrayReserve, lShape, reducedMotion, railMode]);

    return (
        // While editing, the whole page under the scrim takes the canvas tone (data-spotlight-page).
        <div className={cn("flex flex-1 h-dvh w-full min-w-0 overflow-hidden p-0", showDetailsSidebar && "bg-kb-surface")} data-spotlight-page="">
            {(layerPasteError || clipboardError) && <div role="alert" className="fixed top-2 right-2 z-[100] rounded border bg-kb-surface p-3 text-sm text-red-700 dark:text-red-400">
                {layerPasteError || clipboardError}
                <button className="ml-3 underline" onClick={() => { setLayerPasteError(null); clearClipboardError(); }}>Dismiss</button>
            </div>}
            <AppSidebar />
            <BindingSpotlight />
            <DeepLinkEditor />
            <PointingDeepLink />
            <TouchpadTuningDialog />
            <div className="contents">
            {/* Keep the panel mounted when its placement changes. */}
            <PickerTrayProvider value={trayValue}>
            <SecondarySidebar
                leftOffset={primaryOffset}
                height={dynamicBottomPanelHeight}
                bottom={useBottomLayout}
                comboPlacement={comboEditorPlacement}
                canvasRef={viewsScrollRef}
                getKeyboardElement={getPrimaryKeyboardElement}
                onComboReserveChange={setComboEditorReserve}
                pickerShape={lShape ? pickerShape : "rect"}
            />
            </PickerTrayProvider>
            {lShape && <PickerTray
                shape={pickerShape}
                state={currentTrayState}
                height={openTrayHeight}
                fills={trayFills}
                panelOpen={showDetailsSidebar}
                onContentHeight={setTrayContentHeight}
                onToggle={() => setTrayToggled(t => !t)}
                headerRef={setTrayHeader}
                bodyRef={setTrayBody}
            />}
            <div
                ref={contentContainerRef}
                className={cn(
                    "relative flex-1 min-w-0 px-2 sm:px-4 h-dvh max-h-dvh flex flex-col max-w-full overflow-hidden bg-kb-gray border-none",
                    isDraggingLayer && "ring-4 ring-inset ring-blue-400 ring-opacity-50"
                )}
                style={contentStyle}
                onClick={() => clearSelection()}
            >
                <div className="contents" inert={covered}>
                <LayerSelector
                    selectedLayer={selectedLayer}
                    setSelectedLayer={setSelectedLayer}
                    isMultiLayersActive={isMultiLayersActive}
                    onToggleMultiLayers={handleToggleMultiLayers}
                    showAllLayers={showAllLayers}
                    onToggleShowLayers={handleToggleShowLayers}
                    isLayerOrderReversed={isLayerOrderReversed}
                    onToggleLayerOrder={() => setIsLayerOrderReversed(prev => !prev)}
                    layerActiveState={layerActiveState}
                    onToggleLayerOn={handleToggleLayerOn}
                    isAllTransparencyActive={isAllTransparencyActive}
                    onToggleAllTransparency={handleToggleAllTransparency}
                    compact={lShape}
                />
                </div>

                <div
                    className={cn(
                        "keyboard-canvas-scroll flex-1 min-h-0 min-w-0 overflow-auto overscroll-contain flex flex-col items-start max-w-full relative pb-16",
                        isMultiLayersActive && !isScene3D && "pt-11",
                        // Sized to its content above the L tray, with the controls kept clear by that size.
                        trayFills && "pb-0",
                        // Lifted above the page scrim with no fill of its own: only what it
                        // draws (the keys and layer tabs) reads as lit, and the scrim shows
                        // through everywhere else.
                        covered && "z-[46]"
                    )}
                    data-spotlight-lift={covered ? "" : undefined}
                    data-spotlight-canvas={spotlight ? "" : undefined}
                    ref={viewsScrollRef}
                    role="region"
                    aria-label="Keyboard canvas"
                    tabIndex={0}
                >
                    {import.meta.env.DEV && lShape && (
                        // With L, the dev branch label sits beside the layer name, not in a row of its own.
                        <div className="absolute top-[46px] right-2 text-[10px] font-medium text-slate-400 dark:text-neutral-400 select-none pointer-events-none">
                            Branch: {gitBranchLabel}
                        </div>
                    )}
                    {threeDTopScrollReservePx > 0 && (
                        <div
                            aria-hidden="true"
                            className="w-full shrink-0 pointer-events-none"
                            style={{ height: `${threeDTopScrollReservePx}px` }}
                        />
                    )}

                    {activePanel === "matrixtester" ? (
                        <MatrixTester />
                    ) : (
                        <>
                            {/* Vertical 3D Guide Lines - now in 2D container to ensure verticality */}
                            {(() => {
                                // Calculate precisely how far down the lines should go
                                // Distance between layers = (KeyboardHeight + 20 padding) - 310 overlap + translateZ(15) projection
                                const useFragmentLayout = keyboardLayout !== SVALBOARD_LAYOUT;
                                let maxYUnits = 0;
                                Object.values(keyboardLayout).forEach((key: any) => {
                                    const yPos = (!useFragmentLayout && key.y >= 6) ? key.y + 0.3 : key.y;
                                    maxYUnits = Math.max(maxYUnits, yPos + key.h);
                                });
                                const zStep = effectiveLayerSpacing;
                                const stepYValue = zStep * 0.8192; // 0.8192 is sin(55deg)

                                const viewsToDisplay = renderedViews;
                                const isOverviewSceneActive = isSceneInMultiStack;

                                const totalViewShiftY = isOverviewSceneActive ? (viewsToDisplay.length * stepYValue) : 0;
                                const multiLayerHeaderOffset = 0;

                                const shouldDeferGuideLines = deferGuidesRender || legacyForwardEntryActive || !sceneShowsGuides(sceneState);

                                return (
                                    <div
                                        data-layout-keyboard=""
                                        className="relative w-full shrink-0 flex flex-col items-center"
                                        style={{ minWidth: Math.floor(layoutNaturalWidth * layoutScale), ...(isScene3D ? {
                                            perspective: "1200px",
                                            transformStyle: "preserve-3d",
                                            paddingBottom: isOverviewSceneActive ? `${totalViewShiftY + 50}px` : undefined,
                                        } : {}) }}
                                    >
                                        {/* Vertical 3D Guide Lines - now in 2D container to ensure verticality */}
                                        {isScene3D && isOverviewSceneActive && (
                                            <GuideLines
                                                numLayers={viewsToDisplay.length}
                                                lastViewId={viewsToDisplay[viewsToDisplay.length - 1]?.id}
                                                keyVariant={keyVariant}
                                                keyboardLayout={keyboardLayout}
                                                fingerClusterSqueeze={fingerClusterSqueeze}
                                                isThumb3DOffsetActive={isThumb3DOffsetActive}
                                                stepYValue={stepYValue}
                                                primaryStackIndex={0}
                                                deferRender={shouldDeferGuideLines}
                                            />
                                        )}
                                        {viewsToDisplay.map((view, index) => (
                                            (() => {
                                                const stackIndex = isOverviewSceneActive ? index : 0;
                                                const scenePose = getLayerScenePose({
                                                    sceneState,
                                                    stackIndex,
                                                    isPrimary: view.id === "primary",
                                                    totalVisibleLayers: viewsToDisplay.length,
                                                    layerSpacingPx: effectiveLayerSpacing,
                                                    flowOffsetPx: sceneFlowOffsets[view.id] ?? 0,
                                                    renderedInMultiScene: isOverviewSceneActive,
                                                    collapseToSingle: sceneCollapseToSingle,
                                                });
                                                return (
                                                    <div key={view.id}
                                                        ref={(el) => {
                                                            if (el) {
                                                                sceneViewRefs.current.set(view.id, el);
                                                            } else {
                                                                sceneViewRefs.current.delete(view.id);
                                                            }
                                                            if (el) {
                                                                const existing = layerViewRefs.current.get(view.selectedLayer);
                                                                if (view.id === "primary" || !existing) {
                                                                    layerViewRefs.current.set(view.selectedLayer, el);
                                                                }
                                                            } else {
                                                                layerViewRefs.current.delete(view.selectedLayer);
                                                            }
                                                        }}
                                                        className="w-full relative pointer-events-none"
                                                        style={{
                                                            zIndex: (viewsToDisplay.length - index),
                                                            transformStyle: isScene3D ? "preserve-3d" : "flat",
                                                        }}
                                                    >
                                                        <div className="flex justify-center h-full relative pointer-events-none" style={{ transformStyle: isScene3D ? "preserve-3d" : "flat" }}>
                                                            <KeyboardViewInstance
                                                                instanceId={view.id}
                                                                selectedLayer={view.selectedLayer}
                                                                setSelectedLayer={(layer) => handleSetViewLayer(view.id, layer)}
                                                                isPrimary={view.id === "primary"}
                                                                hideLayerTabs={isOverviewSceneActive && view.id !== "primary"}
                                                                layerActiveState={layerActiveState}
                                                                onToggleLayerOn={handleToggleLayerOn}
                                                                transparencyByLayer={transparencyByLayer}
                                                                onToggleTransparency={handleToggleTransparency}
                                                                showAllLayers={showAllLayers}
                                                                onToggleShowLayers={handleToggleShowLayers}
                                                                isLayerOrderReversed={isLayerOrderReversed}
                                                                onToggleLayerOrder={() => setIsLayerOrderReversed(prev => !prev)}
                                                                isOverviewSceneActive={isOverviewSceneActive}
                                                                show3DScene={isScene3D}
                                                                scenePose={scenePose}
                                                                legacyForwardEntryActive={legacyForwardEntryActive}
                                                                isAllTransparencyActive={isAllTransparencyActive}
                                                                isTransparencyRestoring={isTransparencyRestoring}
                                                                multiLayerHeaderOffset={multiLayerHeaderOffset}
                                                                onRemove={!isOverviewSceneActive && view.id !== "primary" ? () => handleRemoveView(view.id) : undefined}
                                                                onGhostNavigate={isOverviewSceneActive ? handleGhostNavigate : undefined}
                                                                isRevealing={view.id === revealingViewId}
                                                                isHiding={view.id === hidingViewId}
                                                                stackIndex={stackIndex}
                                                                baseBadgeOffsetY={baseBadgeOffsetY}
                                                                onBaseBadgeOffsetY={view.id === "primary" ? handleBaseBadgeOffsetY : undefined}
                                                                isLayerDragActive={isDraggingLayer}
                                                                fitScale={layoutScale}
                                                                compact={lShape}
                                                                hoveredDropLayer={hoveredDropLayer}
                                                                onLayerDropHover={handleLayerDropHover}
                                                                onLayerDrop={handleLayerDrop}
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })()
                                        ))}
                                    </div>
                                );
                            })()}
                        </>
                    )}

                    {/* Add View Button */}
                    {!isMultiLayersActive && (
                        <div
                            className={cn("flex items-center pl-5 w-full", !lShape && "pb-2")}
                            style={{
                                opacity: hideAddButton ? 0 : 1,
                                transition: hideAddButton ? 'none' : `opacity 150ms ease-in-out, margin-top ${legacyForwardEntryActive ? LEGACY_FORWARD_ENTRY_MS : SCENE_SPREAD_MS}ms ${legacyForwardEntryActive ? 'ease-in-out' : 'cubic-bezier(0.22, 1, 0.36, 1)'}`,
                                marginTop: is3DMode && !isMultiLayersActive ? 320 : 0,
                            }}
                        >
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger asChild>
                                    <button
                                        ref={addViewButtonRef}
                                        onClick={handleAddView}
                                        className="p-2 rounded-full transition-colors text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-100 hover:bg-gray-200 dark:hover:bg-neutral-700"
                                        aria-label="Add keyboard layer view"
                                        data-inspector-beside=""
                                        data-spotlight-cover=""
                                    >
                                        <LayersPlusIcon className="h-5 w-5" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                    Show Another Layer
                                </TooltipContent>
                            </Tooltip>
                        </div>
                    )}

                    {/* 3D-only scroll reserve so transformed backdrops can be fully revealed by scrolling */}
                    {threeDBottomScrollReservePx > 0 && (
                        <div
                            aria-hidden="true"
                            className="w-full shrink-0 pointer-events-none"
                            style={{ height: `${threeDBottomScrollReservePx}px` }}
                        />
                    )}

                    {/* Flying icon animation (add: plus→minus, remove: minus→plus) */}
                    {flyingIcon && !isMultiLayersActive && (
                        <div
                            className="fixed pointer-events-none"
                            style={{
                                left: flyingIcon.endX !== undefined ? flyingIcon.endX : flyingIcon.startX,
                                top: flyingIcon.endY !== undefined ? flyingIcon.endY : flyingIcon.startY,
                                transition: flyingIcon.endX !== undefined
                                    ? 'left 400ms cubic-bezier(0.42, 0, 0.58, 1), top 400ms cubic-bezier(0.42, 0, 0.58, 1)'
                                    : 'none',
                                zIndex: 40,
                            }}
                            onTransitionEnd={handleFlyingIconEnd}
                        >
                            <div className="p-2">
                                {flyingIcon.iconType === 'plus'
                                    ? <LayersPlusIcon className="h-5 w-5 text-gray-500 dark:text-neutral-400" />
                                    : <LayersMinusIcon className="h-5 w-5 text-gray-400 dark:text-neutral-400" />}
                            </div>
                        </div>
                    )}

                    {/* Controls - bottom left corner for bottom bar mode (same style as sidebar mode) */}
                    {useBottomLayout && !showEditorOverlay && (
                        <div data-inspector-avoid className="fixed right-4 z-10 max-w-[calc(100vw-5rem)]" style={{ bottom: showBottomPanel ? `calc(${typeof bottomPanelHeight === "number" ? `${bottomPanelHeight}px` : bottomPanelHeight} + 16px)` : 16 }}>
                            <EditorControls />
                        </div>
                    )}
                </div>

                {/* Controls - bottom left in sidebar mode only */}
                {
                    !useBottomLayout && (
                        <>
                            <div ref={canvasControlsRef} className="absolute bottom-4 right-2 max-w-[calc(100%-4rem)] flex flex-col items-end gap-1 pointer-events-none" style={lShape || comboEditorReserve + layoutTrayReserve > 0 ? { bottom: `${(lShape ? CANVAS_CONTROLS_INSET_PX : 16) + comboEditorReserve + (layoutTrayReserve > 0 ? layoutTrayReserve + 8 : 0)}px`, transition: lShape && !reducedMotion ? `bottom ${TRAY_MOTION_MS}ms cubic-bezier(0.33, 1, 0.68, 1)` : undefined } : undefined}>
                                {/* While editing, the size controls stay in view under the page scrim, out of reach; a click there nudges the editor. */}
                                <div className="pointer-events-auto" data-combo-editor-avoid data-inspector-avoid>
                                    <div inert={covered}>
                                        <EditorControls />
                                    </div>
                                </div>
                                {import.meta.env.DEV && !lShape && (
                                    <div className="text-[10px] font-medium text-slate-400 dark:text-neutral-400 select-none px-1 pointer-events-auto">
                                        Branch: {gitBranchLabel}
                                    </div>
                                )}
                            </div>
                        </>
                    )
                }
            </div >

            {/* Paste Layer Dialog */}
            <PasteLayerDialog
                currentLayerName={currentLayerName}
                onConfirm={handlePasteConfirm}
            />
            <DragReplaceLayerDialog
                open={!!pendingLayerDrop}
                sourceLayerName={pendingLayerDrop?.sourceLayerName ?? ""}
                targetLayerName={pendingLayerDrop?.targetLayerName ?? ""}
                onConfirm={handleDragReplaceConfirm}
                onCancel={handleDragReplaceCancel}
            />
            <StorageResetDialog />
            <TrackballMismatchDialog />
            </div>
        </div >
    );
};


/**
 * Renders perfectly vertical dotted guide lines connecting key clusters across layers in 3D mode.
 * Rendered in 2D space but aligned with the 3D-projected clusters.
 */
const GuideLines = ({
    numLayers,
    lastViewId,
    keyVariant,
    keyboardLayout,
    fingerClusterSqueeze,
    isThumb3DOffsetActive,
    stepYValue,
    primaryStackIndex,
    deferRender = false
}: {
    numLayers: number,
    lastViewId: string,
    keyVariant: string,
    keyboardLayout: any,
    fingerClusterSqueeze: number,
    isThumb3DOffsetActive: boolean,
    stepYValue: number,
    primaryStackIndex: number,
    deferRender?: boolean
}) => {
    if (numLayers < 2 || deferRender) return null;

    const unitSize = keyVariant === 'small' ? 30 : keyVariant === 'medium' ? 45 : 60;
    const keyboardPadding = 16; // matches Keyboard.tsx p-4
    const useFragmentLayout = keyboardLayout !== SVALBOARD_LAYOUT;
    const getYPos = (y: number) => (
        (!useFragmentLayout && y >= 6) ? y + THUMB_OFFSET_U : y
    );

    let layoutMaxX = 0;
    let layoutMaxY = 0;
    Object.values(keyboardLayout).forEach((k: any) => {
        layoutMaxX = Math.max(layoutMaxX, k.x + k.w);
        layoutMaxY = Math.max(layoutMaxY, getYPos(k.y) + k.h);
    });
    const layoutMidline = layoutMaxX / 2;

    const overlayRef = React.useRef<HTMLDivElement | null>(null);
    const [guidePointsPx, setGuidePointsPx] = React.useState<Array<{ x: number; y: number; label: string; isBottom: boolean }>>([]);
    const [svgSize, setSvgSize] = React.useState({ width: 0, height: 0 });
    const [thumbGuideShiftPx, setThumbGuideShiftPx] = React.useState({ x: 0, y: 0 });

    const findKeyByXY = (x: number, y: number) => {
        let best: { x: number; y: number; w: number; h: number } | null = null;
        let bestDist = Infinity;
        Object.values(keyboardLayout).forEach((k: any) => {
            const dx = Math.abs(k.x - x);
            const dy = Math.abs(k.y - y);
            const dist = dx + dy;
            if (dist < bestDist) {
                bestDist = dist;
                best = { x: k.x, y: k.y, w: k.w, h: k.h };
            }
        });
        return bestDist <= 0.75 ? best : null;
    };

    const clusterTopKeys = React.useMemo(() => {
        const fingerAnchors = [
            { x: 1, y: 1.5, label: "L1" },    // Q
            { x: 3.5, y: 0, label: "L2" },    // W
            { x: 7, y: 0, label: "L3" },      // E
            { x: 9.5, y: 1.5, label: "L4" },  // R
            { x: 13.8, y: 1.5, label: "R1" }, // U
            { x: 16.3, y: 0, label: "R2" },   // I
            { x: 19.8, y: 0, label: "R3" },   // O
            { x: 22.3, y: 1.5, label: "R4" }, // P
        ];

        type LayoutKey = { x: number; y: number; w: number; h: number };
        const keys = Object.values(keyboardLayout) as LayoutKey[];
        const thumbKeys = keys.filter((k) => k.y >= 5);
        if (thumbKeys.length === 0) return fingerAnchors;

        const nearestThumb = (targetX: number, targetY: number): LayoutKey | null => {
            let best: LayoutKey | null = null;
            let bestDist = Infinity;
            thumbKeys.forEach((k) => {
                const d = Math.abs(k.x - targetX) + Math.abs(k.y - targetY);
                if (d < bestDist) {
                    bestDist = d;
                    best = k;
                }
            });
            return best;
        };

        const leftThumb = nearestThumb(9.5, 5);   // expected CAPS center key
        const rightThumb = nearestThumb(13.8, 5); // expected MO center key

        const thumbAnchors: Array<{ x: number; y: number; label: string }> = [];
        if (leftThumb) thumbAnchors.push({ x: leftThumb.x, y: leftThumb.y, label: "LT" });
        if (rightThumb) thumbAnchors.push({ x: rightThumb.x, y: rightThumb.y, label: "RT" });

        return [...fingerAnchors, ...thumbAnchors];
    }, [keyboardLayout]);

    React.useLayoutEffect(() => {
        const overlayEl = overlayRef.current;
        const keyboardEl = document.querySelector('[data-keyboard-instance="primary"]') as HTMLElement | null;
        if (!overlayEl || !keyboardEl) {
            setGuidePointsPx([]);
            return;
        }

        const transformEl = (keyboardEl.closest('.keyboard-3d-active') as HTMLElement | null) || keyboardEl;
        const lastKeyboardEl = lastViewId
            ? (document.querySelector(`[data-keyboard-instance="${lastViewId}"]`) as HTMLElement | null)
            : null;
        const lastTransformEl =
            (lastKeyboardEl?.closest('.keyboard-3d-active') as HTMLElement | null) || lastKeyboardEl;

        const getLayoutOffset = (el: HTMLElement) => {
            // Use layout coordinates (not transformed bounds), then compensate for all ancestor scrolling.
            let x = 0;
            let y = 0;
            let current: HTMLElement | null = el;
            while (current) {
                x += current.offsetLeft;
                y += current.offsetTop;
                current = current.offsetParent as HTMLElement | null;
            }

            current = el.parentElement;
            while (current) {
                x -= current.scrollLeft;
                y -= current.scrollTop;
                current = current.parentElement;
            }

            return { x: x - window.scrollX, y: y - window.scrollY };
        };

        const measure = () => {
            const overlayRect = overlayEl.getBoundingClientRect();
            setSvgSize({ width: overlayRect.width, height: overlayRect.height });

            const layoutOffset = getLayoutOffset(transformEl);
            const originStyle = getComputedStyle(transformEl).transformOrigin.split(' ');
            const parseOrigin = (value: string, size: number) => {
                if (value.endsWith('%')) return (parseFloat(value) / 100) * size;
                return parseFloat(value);
            };
            const originX = parseOrigin(originStyle[0], transformEl.offsetWidth);
            const originY = parseOrigin(originStyle[1] || '0px', transformEl.offsetHeight);


            const degToRad = Math.PI / 180;
            const sin45 = Math.sin(45 * degToRad);
            const cos45 = Math.cos(45 * degToRad);
            const sin55 = Math.sin(55 * degToRad);
            const cos55 = Math.cos(55 * degToRad);
            const zStep = stepYValue / sin55;

            const points: Array<{ x: number; y: number; label: string; isBottom: boolean }> = [];
            const pushProjectedPoint = (label: string, pxX: number, pxY: number, z: number, isBottom: boolean) => {
                const projected = projectPoint(pxX, pxY, z);
                points.push({
                    x: projected.x + layoutOffset.x - overlayRect.left,
                    y: projected.y + layoutOffset.y - overlayRect.top,
                    label,
                    isBottom,
                });
            };
            const pushScreenPoint = (label: string, pxX: number, pxY: number, isBottom: boolean) => {
                points.push({
                    x: pxX,
                    y: pxY,
                    label,
                    isBottom,
                });
            };

            let zBottom = (numLayers - 1) * zStep;

            const projectPoint = (pxX: number, pxY: number, z: number) => {
                const localX = pxX - originX;
                const localY = pxY - originY;

                // translateZ then rotateZ(-45deg)
                const x1 = (localX * cos45) + (localY * sin45);
                const y1 = (-localX * sin45) + (localY * cos45);

                // rotateX(55deg)
                const y2 = (y1 * cos55) + (z * sin55);
                const x2 = x1;

                return {
                    x: x2 + originX,
                    y: y2 + originY,
                };
            };

            const keyToPos = (key: { x: number; y: number; w: number; h: number }) => {
                let xPos = key.x;
                if (!useFragmentLayout && fingerClusterSqueeze > 0) {
                    if (key.x + key.w / 2 < layoutMidline) {
                        xPos = key.x + fingerClusterSqueeze;
                    } else {
                        xPos = key.x - fingerClusterSqueeze;
                    }
                    xPos -= fingerClusterSqueeze;
                }
                const yPos = getYPos(key.y);
                return { x: xPos, y: yPos, w: key.w, h: key.h };
            };

            const getKeyEl = (kbEl: HTMLElement, key: { x: number; y: number }) => {
                const selector = `[data-key-x="${key.x}"][data-key-y="${key.y}"]`;
                return kbEl.querySelector(selector) as HTMLElement | null;
            };
            const getQuad = (el: HTMLElement) => {
                const elWithQuads = el as HTMLElement & {
                    getBoxQuads?: (options?: { box?: "margin" | "border" | "padding" | "content" }) => DOMQuad[];
                };
                if (typeof elWithQuads.getBoxQuads === "function") {
                    const quads = elWithQuads.getBoxQuads({ box: "border" });
                    return quads && quads.length ? quads[0] : null;
                }
                return null;
            };
            const quadPoints = (quad: DOMQuad) => [quad.p1, quad.p2, quad.p3, quad.p4];
            const quadEdges = (pts: DOMPoint[]) => ([
                { a: pts[0], b: pts[1] },
                { a: pts[1], b: pts[2] },
                { a: pts[2], b: pts[3] },
                { a: pts[3], b: pts[0] },
            ]).map((e) => ({
                ...e,
                avgX: (e.a.x + e.b.x) / 2,
                avgY: (e.a.y + e.b.y) / 2,
            }));
            const pickTopEdge = (edges: Array<{ a: DOMPoint; b: DOMPoint; avgX: number; avgY: number }>) =>
                edges.reduce((min, e) => (e.avgY < min.avgY ? e : min), edges[0]);
            const orderByX = (a: { x: number; y: number }, b: { x: number; y: number }) =>
                (a.x <= b.x ? { left: a, right: b } : { left: b, right: a });

            const getActualTopEdge = (kbEl: HTMLElement, keyX: number, keyY: number) => {
                const key = findKeyByXY(keyX, keyY);
                if (!key) return null;
                const el = getKeyEl(kbEl, key);
                if (!el) return null;
                const quad = el ? getQuad(el) : null;
                let edge: { left: { x: number; y: number }; right: { x: number; y: number } };

                if (quad) {
                    const pts = quadPoints(quad);
                    const topEdge = pickTopEdge(quadEdges(pts));
                    edge = orderByX(topEdge.a, topEdge.b);
                } else {
                    return null;
                }

                const { left, right } = edge;
                return {
                    left: { x: left.x - overlayRect.left, y: left.y - overlayRect.top },
                    right: { x: right.x - overlayRect.left, y: right.y - overlayRect.top },
                };
            };

            const getProjectedThumbShift = (scaleX = 1) => {
                if (!isThumb3DOffsetActive) return { x: 0, y: 0 };
                const base = projectPoint(0, 0, 0);
                const shifted = projectPoint(0, 900, 0);
                return {
                    x: (shifted.x - base.x) * scaleX,
                    y: shifted.y - base.y,
                };
            };

            const getKeyCenter = (kbEl: HTMLElement, keyX: number, keyY: number) => {
                const key = findKeyByXY(keyX, keyY);
                if (!key) return null;
                const el = getKeyEl(kbEl, key);
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return {
                    x: (rect.left + rect.right) / 2,
                    y: (rect.top + rect.bottom) / 2,
                };
            };

            const measuredLayerOffset = (() => {
                if (!lastKeyboardEl || lastKeyboardEl === keyboardEl) return null;
                const anchors = [
                    { x: 3.5, y: 0 },   // W
                    { x: 16.3, y: 0 },  // I
                    { x: 1, y: 1.5 },   // Q
                    { x: 22.3, y: 1.5 }, // P
                ];
                const deltas: Array<{ dx: number; dy: number }> = [];
                anchors.forEach(({ x, y }) => {
                    const primaryEdge = getActualTopEdge(keyboardEl, x, y);
                    const secondaryEdge = getActualTopEdge(lastKeyboardEl, x, y);
                    if (primaryEdge && secondaryEdge) {
                        deltas.push({
                            dx: ((secondaryEdge.left.x + secondaryEdge.right.x) / 2) - ((primaryEdge.left.x + primaryEdge.right.x) / 2),
                            dy: ((secondaryEdge.left.y + secondaryEdge.right.y) / 2) - ((primaryEdge.left.y + primaryEdge.right.y) / 2),
                        });
                        return;
                    }
                    const primaryCenter = getKeyCenter(keyboardEl, x, y);
                    const secondaryCenter = getKeyCenter(lastKeyboardEl, x, y);
                    if (primaryCenter && secondaryCenter) {
                        deltas.push({
                            dx: secondaryCenter.x - primaryCenter.x,
                            dy: secondaryCenter.y - primaryCenter.y,
                        });
                    }
                });
                if (deltas.length === 0) return null;
                const sum = deltas.reduce(
                    (acc, delta) => ({ dx: acc.dx + delta.dx, dy: acc.dy + delta.dy }),
                    { dx: 0, dy: 0 }
                );
                return { dx: sum.dx / deltas.length, dy: sum.dy / deltas.length };
            })();

            const addFromKey = (key: { x: number; y: number; w: number; h: number }, side: "top" | "right" | "bottom" | "left", label: string) => {
                const k = keyToPos(key);
                const leftX = keyboardPadding + (k.x * unitSize);
                const rightX = keyboardPadding + ((k.x + k.w) * unitSize);
                const topY = keyboardPadding + (k.y * unitSize);
                const bottomY = keyboardPadding + ((k.y + k.h) * unitSize);

                const zTop = primaryStackIndex * zStep;
                const zEnd = zTop + zBottom;

                if (side === "top") {
                    const isThumbGuide = label === "LT" || label === "RT";
                    const primaryTopEdge = isThumbGuide ? null : getActualTopEdge(keyboardEl, key.x, key.y);

                    const projectedTopLeft = projectPoint(leftX, topY, zTop);
                    const projectedTopRight = projectPoint(rightX, topY, zTop);
                    const projectedTop1 = {
                        x: projectedTopLeft.x + layoutOffset.x - overlayRect.left,
                        y: projectedTopLeft.y + layoutOffset.y - overlayRect.top,
                    };
                    const projectedTop2 = {
                        x: projectedTopRight.x + layoutOffset.x - overlayRect.left,
                        y: projectedTopRight.y + layoutOffset.y - overlayRect.top,
                    };

                    const top1 = primaryTopEdge?.left ?? projectedTop1;
                    const top2 = primaryTopEdge?.right ?? projectedTop2;

                    if (measuredLayerOffset) {
                        usedMeasuredTopEdges = true;
                        pushScreenPoint(`${label}-top-1`, top1.x, top1.y, false);
                        pushScreenPoint(`${label}-top-2`, top2.x, top2.y, false);
                        pushScreenPoint(`${label}-top-1`, top1.x + measuredLayerOffset.dx, top1.y + measuredLayerOffset.dy, true);
                        pushScreenPoint(`${label}-top-2`, top2.x + measuredLayerOffset.dx, top2.y + measuredLayerOffset.dy, true);
                        return;
                    }

                    pushProjectedPoint(`${label}-top-1`, leftX, topY, zTop, false);
                    pushProjectedPoint(`${label}-top-2`, rightX, topY, zTop, false);
                    pushProjectedPoint(`${label}-top-1`, leftX, topY, zEnd, true);
                    pushProjectedPoint(`${label}-top-2`, rightX, topY, zEnd, true);
                } else if (side === "right") {
                    pushProjectedPoint(`${label}-right-1`, rightX, topY, zTop, false);
                    pushProjectedPoint(`${label}-right-2`, rightX, bottomY, zTop, false);
                    pushProjectedPoint(`${label}-right-1`, rightX, topY, zEnd, true);
                    pushProjectedPoint(`${label}-right-2`, rightX, bottomY, zEnd, true);
                } else if (side === "bottom") {
                    pushProjectedPoint(`${label}-bottom-1`, leftX, bottomY, zTop, false);
                    pushProjectedPoint(`${label}-bottom-2`, rightX, bottomY, zTop, false);
                    pushProjectedPoint(`${label}-bottom-1`, leftX, bottomY, zEnd, true);
                    pushProjectedPoint(`${label}-bottom-2`, rightX, bottomY, zEnd, true);
                } else {
                    pushProjectedPoint(`${label}-left-1`, leftX, topY, zTop, false);
                    pushProjectedPoint(`${label}-left-2`, leftX, bottomY, zTop, false);
                    pushProjectedPoint(`${label}-left-1`, leftX, topY, zEnd, true);
                    pushProjectedPoint(`${label}-left-2`, leftX, bottomY, zEnd, true);
                }
            };

            let usedMeasuredTopEdges = false;

            clusterTopKeys.forEach(({ x, y, label }) => {
                const top = findKeyByXY(x, y);
                if (!top) return;
                const right = findKeyByXY(x + 1, y + 1);
                const bottom = findKeyByXY(x, y + 2);
                const left = findKeyByXY(x - 1, y + 1);
                if (top) addFromKey(top, "top", label);
                if (right) addFromKey(right, "right", label);
                if (bottom) addFromKey(bottom, "bottom", label);
                if (left) addFromKey(left, "left", label);
            });

            if (usedMeasuredTopEdges) {
                setGuidePointsPx(points);
                setThumbGuideShiftPx(getProjectedThumbShift());
                return;
            }

            const l2Actual = getActualTopEdge(keyboardEl, 3.5, 0); // W
            const r2Actual = getActualTopEdge(keyboardEl, 16.3, 0); // I
            const calcLeft = points.find((p) => p.label === "L2-top-1" && !p.isBottom);
            const calcRight = points.find((p) => p.label === "R2-top-2" && !p.isBottom);

            if (l2Actual && r2Actual && calcLeft && calcRight) {
                const scaleX = (r2Actual.right.x - l2Actual.left.x) / (calcRight.x - calcLeft.x);
                const dy = l2Actual.left.y - calcLeft.y;
                setGuidePointsPx(points.map((p) => ({
                    ...p,
                    x: l2Actual.left.x + (p.x - calcLeft.x) * scaleX,
                    y: p.y + dy,
                })));
                setThumbGuideShiftPx(getProjectedThumbShift(scaleX));
                return;
            }

            setGuidePointsPx(points);
            setThumbGuideShiftPx(getProjectedThumbShift());
        };

        const handleResize = () => requestAnimationFrame(measure);
        const ro = new ResizeObserver(handleResize);
        ro.observe(overlayEl);
        ro.observe(keyboardEl);
        if (lastKeyboardEl && lastKeyboardEl !== keyboardEl) {
            ro.observe(lastKeyboardEl);
        }

        const transitionTargets = [transformEl, lastTransformEl].filter((el): el is HTMLElement => !!el);
        transitionTargets.forEach((el) => {
            el.addEventListener('transitionrun', handleResize);
            el.addEventListener('transitionend', handleResize);
        });

        const settleTimer = window.setTimeout(handleResize, 220);
        window.addEventListener('resize', handleResize);
        measure();

        return () => {
            window.clearTimeout(settleTimer);

            transitionTargets.forEach((el) => {
                el.removeEventListener('transitionrun', handleResize);
                el.removeEventListener('transitionend', handleResize);
            });

            ro.disconnect();
            window.removeEventListener('resize', handleResize);
        };
    }, [keyboardLayout, keyVariant, numLayers, lastViewId, fingerClusterSqueeze, isThumb3DOffsetActive, stepYValue, primaryStackIndex, useFragmentLayout, unitSize, layoutMidline]);

    // Spacing between layers in screen pixels
    const svgWidth = svgSize.width || 1;
    const svgHeight = (svgSize.height || 1) + (numLayers * 100); // extra padding for overlap

    return (
        <React.Fragment>
            <div
                ref={overlayRef}
                data-testid="multi-layer-guides"
                className="absolute inset-0 pointer-events-none overflow-visible"
                style={{ zIndex: 0 }}
            >
                <svg
                    width={svgWidth}
                    height={svgHeight}
                    style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
                    className="overflow-visible"
                >
                    {(() => {
                        const clusters = new Map<string, { top1?: { x: number; y: number }, top2?: { x: number; y: number }, bottom1?: { x: number; y: number }, bottom2?: { x: number; y: number } }>();
                        guidePointsPx.forEach((p) => {
                            const parts = p.label.split("-");
                            const cluster = parts[0];
                            const side = parts[1];
                            const idx = parts[2];
                            if (side !== "top") return;
                            const entry = clusters.get(cluster) || {};
                            if (!p.isBottom) {
                                if (idx === "1") entry.top1 = { x: p.x, y: p.y };
                                if (idx === "2") entry.top2 = { x: p.x, y: p.y };
                            } else {
                                if (idx === "1") entry.bottom1 = { x: p.x, y: p.y };
                                if (idx === "2") entry.bottom2 = { x: p.x, y: p.y };
                            }
                            clusters.set(cluster, entry);
                        });

                        return Array.from(clusters.entries()).map(([cluster, pts]) => {
                            if (!pts.top1 || !pts.top2 || !pts.bottom1 || !pts.bottom2) return null;
                            const isThumbGuide = cluster === "LT" || cluster === "RT";
                            const d = `M ${pts.top1.x} ${pts.top1.y} L ${pts.top2.x} ${pts.top2.y} L ${pts.bottom2.x} ${pts.bottom2.y} L ${pts.bottom1.x} ${pts.bottom1.y} Z`;
                            return (
                                <path
                                    key={`trap-${cluster}`}
                                    d={d}
                                    fill="rgba(148, 163, 184, 0.2)"
                                    style={isThumbGuide ? {
                                        transform: `translate(${thumbGuideShiftPx.x}px, ${thumbGuideShiftPx.y}px)`,
                                        transformOrigin: "0 0",
                                        transition: "transform 300ms ease-in-out",
                                    } : undefined}
                                />
                            );
                        });
                    })()}
                    {false && guidePointsPx.filter(p => !p.label.endsWith("bottom-1")).map((p, i) => {
                        const isDebug = p.label === "L2-top-1" || p.label === "L2-top-2";
                        const debugIdx = p.label.endsWith("-1") ? "1" : "2";
                        return (
                            <g key={`back-${i}`}>
                                <line
                                    x1={p.x}
                                    y1={p.y}
                                    x2={p.x}
                                    y2={(() => {
                                        const parts = p.label.split("-");
                                        const cluster = parts[0];
                                        const side = parts[1];
                                        const idx = parts[2];
                                        const tag = `${cluster}-${side}-${idx}`;
                                        const bottom = guidePointsPx.find(bp => bp.label === tag && bp.isBottom);
                                        return bottom ? bottom.y : p.y;
                                    })()}
                                    stroke="#94a3b8"
                                    strokeWidth="1.2"
                                    strokeDasharray="1 5"
                                    opacity="0.6"
                                />
                                {isDebug && (
                                    <>
                                        <circle cx={p.x} cy={p.y} r={5} fill="#ff4fd8" />
                                        <text
                                            x={p.x + 8}
                                            y={p.y - 12}
                                            fill="#ff4fd8"
                                            fontSize="12"
                                            fontWeight={700}
                                            fontFamily='ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
                                        >
                                            {debugIdx}
                                        </text>
                                    </>
                                )}
                            </g>
                        );
                    })}
                </svg>
            </div>
            <div className="absolute inset-0 pointer-events-none overflow-visible" style={{ zIndex: 30 }}>
                <svg
                    width={svgWidth}
                    height={svgHeight}
                    style={{ position: "absolute", left: 0, top: 0 }}
                    className="overflow-visible"
                >
                    {false && guidePointsPx.filter(p => p.label.endsWith("bottom-1")).map((p, i) => (
                        <g key={`front-${i}`}>
                            <line
                                x1={p.x}
                                y1={p.y}
                                x2={p.x}
                                y2={(() => {
                                    const parts = p.label.split("-");
                                    const cluster = parts[0];
                                    const side = parts[1];
                                    const idx = parts[2];
                                    const tag = `${cluster}-${side}-${idx}`;
                                    const bottom = guidePointsPx.find(bp => bp.label === tag && bp.isBottom);
                                    return bottom ? bottom.y : p.y;
                                })()}
                                stroke="#94a3b8"
                                strokeWidth="1.2"
                                strokeDasharray="1 5"
                                opacity="0.6"
                            />
                        </g>
                    ))}
                </svg>
            </div>
        </React.Fragment>
    );
};

export default EditorLayout;
