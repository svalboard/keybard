import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ResultView } from "@/features/firmware/UpdateDialog";
import { ImportSettingsNotes } from "@/components/ImportSettingsNotes";
import type { FlowState } from "@/services/updater/flow";

const replaced = [
    { from: "Scan speed (preset 6)", to: "Scan wait before / after read (15 / 15 µs)", release: "x4.3" },
    { from: "Auto mouse timeout (500 ms choice)", to: "Auto mouse timeout: 500 ms", release: "x4.3" },
];

describe("settings notes after an import or restore", () => {
    it("lists replaced settings as information, with the release that replaced them", () => {
        render(<ImportSettingsNotes replaced={replaced} unavailable={[]} done />);
        const note = screen.getByTestId("settings-replaced");
        expect(note.textContent).toContain("The following settings in this layout have been replaced by:");
        expect(within(note).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
            "Scan speed (preset 6) → Scan wait before / after read (15 / 15 µs)",
            "Auto mouse timeout (500 ms choice) → Auto mouse timeout: 500 ms",
        ]);
        const link = within(note).getByRole("link");
        expect(link.getAttribute("href")).toBe("https://github.com/svalboard/qmk/releases/tag/x4.3");
        expect(note.textContent).toContain("Release details available at https://github.com/svalboard/qmk/releases/tag/x4.3");
        expect(note.className).not.toMatch(/warn/);
        expect(screen.queryByTestId("settings-unavailable")).toBeNull();
    });

    it("lists a value held at the firmware's limit with no release link when no release replaced it", () => {
        render(<ImportSettingsNotes replaced={[{ from: "Time between cursor movements in milliseconds: 300", to: "255" }]} unavailable={[]} done />);
        const note = screen.getByTestId("settings-replaced");
        expect(within(note).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Time between cursor movements in milliseconds: 300 → 255"]);
        expect(within(note).queryByRole("link")).toBeNull();
        expect(note.textContent).not.toContain("Release details");
    });

    it("says calmly that settings with no counterpart were left unchanged, names under Details", () => {
        render(<ImportSettingsNotes replaced={[]} unavailable={["Lights: Sparkle", "Tapping Term"]} done />);
        const note = screen.getByTestId("settings-unavailable");
        expect(note.querySelector("p")?.textContent).toBe("A few settings in this layout aren't available on this firmware, so they were left unchanged.");
        expect(note.querySelector("details summary")?.textContent).toBe("Details");
        expect(within(note).getAllByRole("listitem", { hidden: true }).map((li) => li.textContent)).toEqual(["Lights: Sparkle", "Tapping Term"]);
        expect(note.textContent).not.toMatch(/id_|not supported|didn't fit/);
    });

    it("the update's Done screen shows no problem box when only settings were replaced", () => {
        const state = { title: "Update to x4.3", toTag: "x4.3", target: "both", result: { tags: {}, layout: "restored", trimmed: [], replaced, unavailable: [] } } as unknown as FlowState;
        const { container } = render(<ResultView state={state} onDone={() => {}} />);
        expect(container.querySelector("[data-problem]")).toBeNull();
        expect(container.textContent).not.toMatch(/didn't fit/);
        expect(screen.getByTestId("settings-replaced")).toBeTruthy();
    });
});
