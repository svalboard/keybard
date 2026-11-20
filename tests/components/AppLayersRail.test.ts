import { describe, expect, it } from "vitest";

import { featureSidebarItems, footerItems, layoutSidebarItems } from "@/layout/Sidebar";
import { getPanelTitle } from "@/layout/PanelContent";
import { moreToolsFor } from "@/layout/SecondarySidebar/Panels/MorePanel";

describe("the rail's groups", () => {
    it("has Combos, Leaders and More in the binding group", () => {
        expect(featureSidebarItems.map((i) => [i.title, i.url])).toEqual([["Combos", "combos"], ["Leaders", "leaders"], ["More", "more"]]);
    });

    it("has Layouts alone in its group", () => {
        expect(layoutSidebarItems.map((i) => i.title)).toEqual(["Layouts"]);
    });

    it("has Overlay in the footer, after Manual, with Settings last", () => {
        expect(footerItems.map((i) => [i.title, i.url])).toEqual([["Quick Start", "quickstart"], ["Manual", "manual"], ["Overlay", "trainer"], ["Settings", "settings"]]);
    });
});

describe("App Layers under More", () => {
    it("is listed only on firmware with app rules, after Overrides and Alt-Repeat", () => {
        expect(moreToolsFor(false).map((t) => t.panel)).toEqual(["overrides", "altrepeat"]);
        expect(moreToolsFor(true).map((t) => [t.title, t.panel])).toEqual([["Overrides", "overrides"], ["Alt-Repeat", "altrepeat"], ["App Layers", "app-layers"]]);
    });

    it("opens a panel titled App Layers", () => {
        expect(getPanelTitle("app-layers")).toBe("App Layers");
    });
});
