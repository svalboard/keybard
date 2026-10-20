import { describe, expect, it } from 'vitest';
import { focusedLayer, isTabMarkedLive } from '../../src/utils/layer-indicator';

describe('focusedLayer', () => {
    it('is the displayed layer when nothing is selected', () => {
        expect(focusedLayer({ displayedLayer: 3, selectedTarget: null, isMultiLayersActive: true })).toBe(3);
        expect(focusedLayer({ displayedLayer: 3, isMultiLayersActive: false })).toBe(3);
    });

    it('with several layers shown, is the layer of the selected key', () => {
        expect(focusedLayer({ displayedLayer: 0, selectedTarget: { type: 'keyboard', layer: 1 }, isMultiLayersActive: true })).toBe(1);
        expect(focusedLayer({ displayedLayer: 2, selectedTarget: { type: 'keyboard', layer: 0 }, isMultiLayersActive: true })).toBe(0);
    });

    it('with one layer shown, stays on the displayed layer', () => {
        expect(focusedLayer({ displayedLayer: 0, selectedTarget: { type: 'keyboard', layer: 1 }, isMultiLayersActive: false })).toBe(0);
    });

    it('ignores selections that are not keys on the layout', () => {
        expect(focusedLayer({ displayedLayer: 4, selectedTarget: { type: 'combo' }, isMultiLayersActive: true })).toBe(4);
        expect(focusedLayer({ displayedLayer: 4, selectedTarget: { type: 'keyboard' }, isMultiLayersActive: true })).toBe(4);
    });

    it('has no input from the board: only what Keybard shows decides it', () => {
        // The board's live layer is not a parameter, so whatever the board reports
        // (0, 2, 5...), the same display gives the same focused layer.
        const display = { displayedLayer: 1, selectedTarget: null, isMultiLayersActive: true };
        expect(focusedLayer(display)).toBe(1);
        // A mode that follows the board does so by changing the displayed layer.
        expect(focusedLayer({ ...display, displayedLayer: 2 })).toBe(2);
    });
});

describe('isTabMarkedLive', () => {
    it('never marks a tab while several layers are shown, whatever the board reports', () => {
        for (const board of [0, 1, 2, 7]) {
            for (let layer = 0; layer < 8; layer++) {
                expect(isTabMarkedLive({ layer, isMultiLayersActive: true, activeLayerIndex: board })).toBe(false);
            }
        }
        expect(isTabMarkedLive({ layer: 2, isMultiLayersActive: true, activeLayerIndex: null, layerActiveState: [true, false, true] })).toBe(false);
    });

    it('with one layer shown, marks the board\'s live layer as before', () => {
        expect(isTabMarkedLive({ layer: 2, isMultiLayersActive: false, activeLayerIndex: 2 })).toBe(true);
        expect(isTabMarkedLive({ layer: 1, isMultiLayersActive: false, activeLayerIndex: 2 })).toBe(false);
    });

    it('with one layer shown and no board, marks layers turned on in Keybard', () => {
        const layerActiveState = [true, false, true];
        expect(isTabMarkedLive({ layer: 2, isMultiLayersActive: false, activeLayerIndex: null, layerActiveState })).toBe(true);
        expect(isTabMarkedLive({ layer: 1, isMultiLayersActive: false, activeLayerIndex: null, layerActiveState })).toBe(false);
        expect(isTabMarkedLive({ layer: 1, isMultiLayersActive: false, activeLayerIndex: undefined })).toBe(false);
    });
});
