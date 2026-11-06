// The confirm screen lights the chord keys on the half the updater asks for (the half with
// USB), and on both halves when that half isn't known, never on a guessed side.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ChordDiagram, chordHalfPhrase, litHalves } from "@/features/firmware/ChordDiagram";
import { ConfirmView } from "@/features/firmware/ProgressDialog";
import type { FlowState } from "@/services/updater/flow";

const litIn = (half: "left" | "right") => {
    const el = screen.getByTestId("chord-diagram").querySelector(`[data-half="${half}"]`)!;
    return Array.from(el.querySelectorAll("[data-chord-key]")).map((k) => `${k.closest("[data-finger]")!.getAttribute("data-finger")}:${k.getAttribute("data-chord-key")}`);
};

describe("chord diagram", () => {
    it("lights index south and middle south on the left half only", () => {
        render(<ChordDiagram hand={0} />);
        expect(litIn("left")).toEqual(["middle:middle south", "index:index south"]);
        expect(litIn("right")).toEqual([]);
        expect(litHalves(0)).toEqual([0]);
        expect(chordHalfPhrase(0)).toBe("the left half");
    });

    it("lights them on the right half only when USB is on the right", () => {
        render(<ChordDiagram hand={1} />);
        expect(litIn("right")).toEqual(["index:index south", "middle:middle south"]);
        expect(litIn("left")).toEqual([]);
        expect(screen.getByTestId("chord-diagram").textContent).toContain("Right · USB");
        expect(chordHalfPhrase(1)).toBe("the right half");
    });

    it("lights both halves, and says which half, when the hand is unknown", () => {
        render(<ChordDiagram hand={null} />);
        expect(litIn("left")).toHaveLength(2);
        expect(litIn("right")).toHaveLength(2);
        expect(screen.getByTestId("chord-diagram").textContent).not.toContain("USB");
        expect(chordHalfPhrase(null)).toBe("the half with the USB cable");
    });

    it("the confirm screen for a right-hand USB half names the right half and lights it", () => {
        const state = { phase: "running", step: "approve", approveAt: null, usbHand: 1 } as unknown as FlowState;
        render(<ConfirmView state={state} now={0} />);
        const confirm = screen.getByTestId("update-confirm");
        expect(confirm.textContent).toContain("On the right half, press");
        expect(within(confirm).getByTestId("chord-diagram").getAttribute("data-usb")).toBe("right");
        expect(litIn("right")).toHaveLength(2);
        expect(litIn("left")).toHaveLength(0);
    });
});
