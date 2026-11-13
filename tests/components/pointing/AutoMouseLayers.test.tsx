import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AutoMouseLayersDialog, AutoMouseLayersSetting } from "@/layout/SecondarySidebar/Panels/pointing/AutoMouseLayers";
import { AUTOMOUSE_LAYER_MASK_KEY, AUTOMOUSE_LAYERS_ONLY_KEY } from "@/utils/automouse-layers";
import type { KeyboardInfo } from "@/types/keyboard.types";

const keyboard = { layers: 16, svil_proto: 3 } as unknown as KeyboardInfo;
const pill = (layer: number) => document.querySelector(`[data-layer="${layer}"]`) as HTMLButtonElement;

describe("AutoMouseLayersDialog", () => {
    it("shows one pill per layer but the mouse layer, marks the off ones, and returns the mask on Done", () => {
        const onDone = vi.fn();
        render(<AutoMouseLayersDialog open keyboard={keyboard} mask={0b100} onDone={onDone} onCancel={() => {}} />);
        expect(document.querySelectorAll("[data-layer]")).toHaveLength(15);
        expect(pill(15)).toBeNull();
        expect(pill(2).getAttribute("aria-pressed")).toBe("true");
        expect(pill(1).getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(pill(1));
        fireEvent.click(pill(2));
        fireEvent.click(pill(14));
        expect(screen.getByText("Auto Mouse is off on 2 layers.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(onDone).toHaveBeenCalledWith(0b10 | (1 << 14));
    });
    it("Cancel returns nothing", () => {
        const onDone = vi.fn();
        const onCancel = vi.fn();
        render(<AutoMouseLayersDialog open keyboard={keyboard} mask={0} onDone={onDone} onCancel={onCancel} />);
        fireEvent.click(pill(3));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancel).toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();
    });
});

describe("AutoMouseLayersSetting", () => {
    it("Everywhere hides the layer row; choosing Only on Selected Layers writes the mode", () => {
        const set = vi.fn();
        render(<AutoMouseLayersSetting keyboard={keyboard} values={new Map([[AUTOMOUSE_LAYERS_ONLY_KEY, 0], [AUTOMOUSE_LAYER_MASK_KEY, 0]])} set={set} />);
        expect(document.querySelector("[data-automouse-layers-row]")).toBeNull();
        fireEvent.click(screen.getByRole("radio", { name: "Only on Selected Layers" }));
        expect(set).toHaveBeenCalledWith(AUTOMOUSE_LAYERS_ONLY_KEY, 1);
    });
    it("Only on Selected Layers lists the off layers and writes the picked mask once", () => {
        const set = vi.fn();
        render(<AutoMouseLayersSetting keyboard={keyboard} values={new Map([[AUTOMOUSE_LAYERS_ONLY_KEY, 1], [AUTOMOUSE_LAYER_MASK_KEY, 0b1001]])} set={set} />);
        expect(document.querySelector("[data-automouse-layers-row]")?.textContent).toContain("0, 3");
        fireEvent.click(screen.getByRole("button", { name: "Choose Layers" }));
        fireEvent.click(pill(5));
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(set).toHaveBeenCalledTimes(1);
        expect(set).toHaveBeenCalledWith(AUTOMOUSE_LAYER_MASK_KEY, 0b101001);
    });
});
