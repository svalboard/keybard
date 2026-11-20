import AltRepeatPanel from "./SecondarySidebar/Panels/AltRepeatPanel";
import AppLayersPanel from "./SecondarySidebar/Panels/AppLayersPanel";
import MorePanel from "./SecondarySidebar/Panels/MorePanel";
import BasicKeyboards from "./SecondarySidebar/Panels/BasicKeyboards";
import CombosPanel from "./SecondarySidebar/Panels/CombosPanel";
import DynamicMenuPanel from "./SecondarySidebar/Panels/DynamicMenuPanel";
import LayoutsPanel from "./SecondarySidebar/Panels/LayoutsPanel";
import LeadersPanel from "./SecondarySidebar/Panels/LeadersPanel";
import LayersPanel from "./SecondarySidebar/Panels/LayersPanel";
import MacrosPanel from "./SecondarySidebar/Panels/MacrosPanel";
import SpecialKeysPanel from "./SecondarySidebar/Panels/SpecialKeysPanel/SpecialKeysPanel";
import OverridesPanel from "./SecondarySidebar/Panels/OverridesPanel";
import PointingPanel from "./SecondarySidebar/Panels/PointingPanel";
import OneShotComposerPanel from "./SecondarySidebar/Panels/OneShotComposerPanel";
import QmkKeyPanel from "./SecondarySidebar/Panels/QmkKeysPanel";
import MousePanel from "./SecondarySidebar/Panels/MousePanel";
import ScanLabPanel from "./SecondarySidebar/Panels/ScanLabPanel";
import TrackballPanel from "./SecondarySidebar/Panels/TrackballPanel";
import SettingsPanel from "./SecondarySidebar/Panels/SettingsPanel";
import TapdancePanel from "./SecondarySidebar/Panels/TapdancePanel";
import QuickStartPanel from "./SecondarySidebar/Panels/QuickStartPanel";
import type { CustomUIMenuItem } from "@/types/keyboard.types";

export const getPanelTitle = (panel: string | null | undefined, menus?: CustomUIMenuItem[]): string => {
    if (!panel) return "Details";

    // Handle dynamic menu panels
    if (panel.startsWith("dynamic-menu-")) {
        const indexStr = panel.replace("dynamic-menu-", "");
        const index = parseInt(indexStr, 10);
        if (!isNaN(index) && menus && menus[index]) {
            return menus[index].label || `Menu ${index}`;
        }
        return "Settings";
    }

    const titles: Record<string, string> = {
        keyboard: "Standard Keys",
        layers: "Layer Keys",
        tapdances: "Tap Dance Keys",
        macros: "Macro Keys",
        qmk: "One-Shot (Legacy)",
        oneshot: "One-Shot / Mod-Tap",
        special: "Special Keys",
        mouse: "Mouse Keys",
        combos: "Combos",
        overrides: "Overrides",
        altrepeat: "Alt-Repeat Keys",
        more: "More",
        leaders: "Leader Sequences",
        layouts: "Layouts",
        "app-layers": "App Layers",
        pointing: "Pointing Devices",
        settings: "Settings",
        scanlab: "Scan Lab",
        trackball: "Trackball",
        quickstart: "Quick Start",
    };

    return titles[panel] ?? "Details";
};

export function PanelContent({ panel, horizontal = false, isPicker = false, trayPortal = false }: { panel: string | null | undefined; horizontal?: boolean; isPicker?: boolean; /** Standard Keys only: put the keyboard in the L-shaped picker's tray. */ trayPortal?: boolean }) {
    if (isPicker) {
        const pickers = {keyboard: BasicKeyboards, layers: LayersPanel, macros: MacrosPanel, tapdances: TapdancePanel, qmk: QmkKeyPanel, oneshot: OneShotComposerPanel, special: SpecialKeysPanel, pointing: PointingPanel, mouse: MousePanel};
        const Picker = pickers[panel as keyof typeof pickers] ?? BasicKeyboards;
        return <Picker isPicker />;
    }
    if (panel?.startsWith("dynamic-menu-")) {
        const index = Number(panel.slice("dynamic-menu-".length));
        if (Number.isInteger(index) && index >= 0) return <DynamicMenuPanel menuIndex={index} horizontal={horizontal} />;
    }
    const panels = {
        keyboard: BasicKeyboards, layers: LayersPanel, tapdances: TapdancePanel,
        macros: MacrosPanel, combos: CombosPanel, overrides: OverridesPanel,
        altrepeat: AltRepeatPanel, more: MorePanel, leaders: LeadersPanel,
        layouts: LayoutsPanel, pointing: PointingPanel, qmk: QmkKeyPanel,
        oneshot: OneShotComposerPanel, special: SpecialKeysPanel, mouse: MousePanel,
        scanlab: ScanLabPanel, trackball: TrackballPanel, settings: SettingsPanel,
        quickstart: QuickStartPanel, "app-layers": AppLayersPanel,
    };
    if (panel === "keyboard") return <BasicKeyboards trayPortal={trayPortal} />;
    const Content = panels[panel as keyof typeof panels];
    return Content ? <Content /> : <p className="p-4 text-sm text-muted-foreground">Select a panel to view its settings.</p>;
}
