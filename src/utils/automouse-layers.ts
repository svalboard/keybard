// Auto Mouse layers: the layers where pointer motion does not switch to the mouse layer.
//
// Firmware with the setting sets GET_INFO byte 21 (feature_flags4) bit 7 and answers
// VIA value 63 (the mode: 0 Everywhere, the default; 1 Only on Selected Layers) and
// value 64 (16 bits: bit n set, Auto Mouse is off on layer n). The mask counts only in
// mode 1, so switching back to Everywhere keeps the layers picked. Older firmware
// leaves the bit clear: Keybard then shows nothing and never writes either value.
// The wire format is in svalboard/qmk keyboards/svalboard/docs/protocol.md.
import type { CustomUIMenuItem } from "@/types/keyboard.types";

export const SVIL_FLAG4_AUTOMOUSE_LAYERS = 0x80;
export const hasAutoMouseLayers = (flags4: number | undefined | null): boolean => ((flags4 ?? 0) & SVIL_FLAG4_AUTOMOUSE_LAYERS) !== 0;

export const AUTOMOUSE_LAYERS_ONLY_KEY = "id_automouse_layers_only";
export const AUTOMOUSE_LAYER_MASK_KEY = "id_automouse_layer_mask";
export const VIA_AUTOMOUSE_LAYERS_ONLY = 63;
export const VIA_AUTOMOUSE_LAYER_MASK = 64;

export const AUTOMOUSE_EVERYWHERE = 0;
export const AUTOMOUSE_SELECTED = 1;
export const AUTOMOUSE_MODE_CHOICES = [
    { value: AUTOMOUSE_EVERYWHERE, label: "Everywhere" },
    { value: AUTOMOUSE_SELECTED, label: "Only on Selected Layers" },
];

/** The mask holds 16 layers. */
export const AUTOMOUSE_MASK_LAYERS = 16;

/** The layers set in a mask, lowest first; bits past the board's layers are left out. */
export function maskToLayers(mask: number, layerCount = AUTOMOUSE_MASK_LAYERS): number[] {
    const out: number[] = [];
    for (let i = 0; i < Math.min(layerCount, AUTOMOUSE_MASK_LAYERS); i++) if ((mask >> i) & 1) out.push(i);
    return out;
}

/** A mask from layer numbers; layers outside 0-15 are ignored. */
export function layersToMask(layers: Iterable<number>): number {
    let mask = 0;
    for (const l of layers) if (Number.isInteger(l) && l >= 0 && l < AUTOMOUSE_MASK_LAYERS) mask |= 1 << l;
    return mask & 0xffff;
}

/** The mask with one layer flipped. */
export const toggleMaskLayer = (mask: number, layer: number): number =>
    layer >= 0 && layer < AUTOMOUSE_MASK_LAYERS ? (mask ^ (1 << layer)) & 0xffff : mask & 0xffff;

/**
 * The layers the picker offers: every layer of the board but the mouse layer itself
 * (the last one), which the firmware never counts as the layer the user is on.
 */
export function pickableLayers(layerCount: number | undefined): number[] {
    const n = Math.min(layerCount || AUTOMOUSE_MASK_LAYERS, AUTOMOUSE_MASK_LAYERS);
    return Array.from({ length: Math.max(0, n - 1) }, (_, i) => i);
}

/**
 * The pointing menu with the two Auto Mouse layers values added, when the firmware has
 * them (flags4 bit 7) and the menu has Auto Mouse. Otherwise the menus as they are.
 */
export function withAutoMouseLayers(menus: CustomUIMenuItem[], featureFlags4: number | undefined | null): CustomUIMenuItem[] {
    if (!hasAutoMouseLayers(featureFlags4)) return menus;
    const index = menus.findIndex((menu) => menu.label?.toLowerCase().includes("pointing"));
    if (index < 0) return menus;
    const menu = menus[index];
    const content = (menu.content ?? []) as CustomUIMenuItem[];
    const text = JSON.stringify(content);
    if (!text.includes('"id_automouse_enable"') || text.includes(`"${AUTOMOUSE_LAYERS_ONLY_KEY}"`)) return menus;
    const channel = firstChannel(content) ?? 0;
    const section: CustomUIMenuItem = {
        label: "Auto Mouse Layers",
        content: [
            { label: "Auto Mouse Layer", type: "toggle", content: [AUTOMOUSE_LAYERS_ONLY_KEY, channel, VIA_AUTOMOUSE_LAYERS_ONLY] },
            { label: "Layers Without Auto Mouse", type: "range", options: [0, 0xffff, 1], content: [AUTOMOUSE_LAYER_MASK_KEY, channel, VIA_AUTOMOUSE_LAYER_MASK] },
        ],
    };
    const out = [...menus];
    out[index] = { ...menu, content: [...content, section] };
    return out;
}

function firstChannel(items: readonly CustomUIMenuItem[]): number | undefined {
    for (const item of items) {
        const c = item.content;
        if (Array.isArray(c) && typeof c[0] === "string" && typeof c[1] === "number") return c[1];
        if (Array.isArray(c)) {
            const found = firstChannel(c as CustomUIMenuItem[]);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}
