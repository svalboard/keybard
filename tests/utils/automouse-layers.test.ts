import { describe, expect, it } from "vitest";

import {
    AUTOMOUSE_LAYER_MASK_KEY, AUTOMOUSE_LAYERS_ONLY_KEY, hasAutoMouseLayers, layersToMask, maskToLayers, pickableLayers,
    SVIL_FLAG4_AUTOMOUSE_LAYERS, toggleMaskLayer, withAutoMouseLayers,
} from "@/utils/automouse-layers";
import { findMenuItem } from "@/utils/pointing-settings";
import type { CustomUIMenuItem } from "@/types/keyboard.types";

const menus: CustomUIMenuItem[] = [
    { label: "Lighting", content: [] },
    { label: "Pointing Device", content: [{ label: "Enable", type: "toggle", content: ["id_automouse_enable", 1, 4] }] },
];

describe("Auto Mouse layers mask", () => {
    it("encodes and decodes layer lists", () => {
        expect(layersToMask([])).toBe(0);
        expect(layersToMask([0, 3, 14])).toBe(0x4009);
        expect(layersToMask([15])).toBe(0x8000);
        expect(layersToMask([-1, 16, 2.5, 99])).toBe(0);
        expect(maskToLayers(0x4009)).toEqual([0, 3, 14]);
        expect(maskToLayers(0xffff, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        for (const m of [0, 1, 0x8421, 0xffff]) expect(layersToMask(maskToLayers(m))).toBe(m);
    });
    it("toggles one layer", () => {
        expect(toggleMaskLayer(0, 2)).toBe(4);
        expect(toggleMaskLayer(4, 2)).toBe(0);
        expect(toggleMaskLayer(0xffff, 15)).toBe(0x7fff);
        expect(toggleMaskLayer(5, 16)).toBe(5);
    });
    it("offers every layer but the mouse layer", () => {
        expect(pickableLayers(16)).toEqual(Array.from({ length: 15 }, (_, i) => i));
        expect(pickableLayers(4)).toEqual([0, 1, 2]);
        expect(pickableLayers(undefined)).toHaveLength(15);
        expect(pickableLayers(32)).toHaveLength(15);
    });
});

describe("withAutoMouseLayers", () => {
    it("leaves older firmware alone (bit 7 clear)", () => {
        expect(hasAutoMouseLayers(0x7f)).toBe(false);
        expect(withAutoMouseLayers(menus, 0x7f)).toBe(menus);
        expect(withAutoMouseLayers(menus, undefined)).toBe(menus);
    });
    it("adds the mode and the 16-bit mask on the menu's channel", () => {
        const out = withAutoMouseLayers(menus, SVIL_FLAG4_AUTOMOUSE_LAYERS);
        const content = out[1].content as CustomUIMenuItem[];
        expect(findMenuItem(content, AUTOMOUSE_LAYERS_ONLY_KEY)?.content).toEqual([AUTOMOUSE_LAYERS_ONLY_KEY, 1, 63]);
        const mask = findMenuItem(content, AUTOMOUSE_LAYER_MASK_KEY);
        expect(mask?.content).toEqual([AUTOMOUSE_LAYER_MASK_KEY, 1, 64]);
        expect((mask?.options as number[])[1]).toBe(0xffff); // two bytes on the wire
        expect(withAutoMouseLayers(out, SVIL_FLAG4_AUTOMOUSE_LAYERS)).toBe(out);
    });
    it("adds nothing to a menu without Auto Mouse", () => {
        const plain: CustomUIMenuItem[] = [{ label: "Pointing Device", content: [] }];
        expect(withAutoMouseLayers(plain, 0x80)).toBe(plain);
    });
});
