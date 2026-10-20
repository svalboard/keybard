/**
 * The layer tabs above the keyboard (LayerSelector) while several layers are shown
 * at once. The tab they mark is the layer that has focus, worked out only from what
 * Keybard shows: the layer the view is on, or the layer of the key selected in one
 * of the stacked layers. The board's live layer (what the person is typing on) never
 * moves it. If a mode ever makes the view follow the board, it does so by changing
 * the displayed layer, and the tabs then follow the display.
 */

/** The part of a binding target the tabs read: a key on the layout has a layer. */
export interface FocusTarget {
    type: string;
    layer?: number;
}

export interface LayerFocusInput {
    /** The layer the view shows (the global selected layer). */
    displayedLayer: number;
    /** The selected binding target, if any. */
    selectedTarget?: FocusTarget | null;
    /** Several layers are shown at once (the multi-layer stack). */
    isMultiLayersActive: boolean;
}

/**
 * The layer the tabs mark. With several layers shown, a key selected in one of them
 * gives that layer focus; otherwise focus is the displayed layer.
 */
export function focusedLayer({ displayedLayer, selectedTarget, isMultiLayersActive }: LayerFocusInput): number {
    if (isMultiLayersActive && selectedTarget?.type === "keyboard" && typeof selectedTarget.layer === "number") {
        return selectedTarget.layer;
    }
    return displayedLayer;
}

export interface LiveLayerInput {
    layer: number;
    isMultiLayersActive: boolean;
    /** The board's live layer (null with no board). */
    activeLayerIndex: number | null | undefined;
    /** Layers turned on in Keybard while no board reports one. */
    layerActiveState?: boolean[];
}

/**
 * Whether a tab is marked as the layer that is live on the board. With several layers
 * shown, no tab is: each layer's own badge shows that, and the tabs stay on the focused
 * layer. With one layer shown, the tab of the board's live layer is marked, as before.
 */
export function isTabMarkedLive({ layer, isMultiLayersActive, activeLayerIndex, layerActiveState }: LiveLayerInput): boolean {
    if (isMultiLayersActive) return false;
    return typeof activeLayerIndex === "number" ? activeLayerIndex === layer : !!layerActiveState?.[layer];
}
