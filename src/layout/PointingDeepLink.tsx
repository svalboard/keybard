import { useEffect, useRef } from "react";

import { useKeyboard } from "@/contexts/KeyboardContext";
import { usePanels } from "@/contexts/PanelsContext";
import { pointingDemo } from "@/features/pointing-demo";
import { requestPointingAutoMouse, requestSettingsSection, settingsSectionForPanel } from "@/layout/SecondarySidebar/Panels/settings/anchor";
import { openTouchpadTuning } from "@/components/touchpad-tuning/tuning-open";
import { openTrackballSensor } from "@/components/trackball-sensor/trackball-open";
import { tuneKindFromSearch } from "@/lib/deepLinks";

/**
 * ?panel=settings opens Settings once a layout is loaded (with ?demo, the
 * QWERTY Example), so a review link lands on the Settings page. The old panel
 * names of what is now in Settings (?panel=typing, clusters, fragments, about) open
 * Settings at that section, as do ?panel=firmware and ?panel=backups. ?panel=scanlab opens the Scan Lab and ?panel=pointing
 * the Pointing Devices panel (?panel=pointing-settings is the same, ?panel=pointing-automouse
 * scrolled to AutoMouse (pointing-advanced is its old name), ?panel=trackball with the Trackball sensors modal open), ?panel=keyboard the Standard
 * Keys panel, ?panel=app-layers (or the older ?panel=app-rules) the App Layers panel. Once per page load.
 */
export default function PointingDeepLink() {
    const { keyboard } = useKeyboard();
    const { setActivePanel, openDetails, setPanelToGoBack, setItemToEdit } = usePanels();
    const done = useRef(false);
    useEffect(() => {
        const panel = pointingDemo()?.panel;
        if (!keyboard || !panel || done.current) return;
        done.current = true;
        // The pointing panel, its old names, and the tuner modals: a modal opens over the panel the link lands on.
        const pointingPanel = panel === "pointing" || panel === "pointing-settings" || panel === "pointing-automouse" || panel === "pointing-advanced" || panel === "trackball";
        if (panel === "scanlab" || pointingPanel || panel === "keyboard" || ["special", "mouse", "layers", "altrepeat", "more", "combos", "overrides", "leaders", "macros", "tapdances", "qmk", "oneshot", "app-rules", "app-layers"].includes(panel)) {
            setActivePanel(pointingPanel ? "pointing" : panel === "app-rules" ? "app-layers" : panel);
            setPanelToGoBack(null);
            setItemToEdit(null);
            openDetails();
            if (panel === "pointing-automouse" || panel === "pointing-advanced") requestPointingAutoMouse();
            const tune = panel === "trackball" ? "trackball" : tuneKindFromSearch(window.location.search);
            if (tune === "touchpad") openTouchpadTuning();
            if (tune === "trackball") openTrackballSensor();
            return;
        }
        const section = settingsSectionForPanel(panel);
        if (section) requestSettingsSection(section);
        setActivePanel("settings");
        setPanelToGoBack(null);
        setItemToEdit(null);
        openDetails();
        // ?tune=touchpad or trackball opens that modal over Settings (?panel=settings, ?panel=hardware).
        const tune = tuneKindFromSearch(window.location.search);
        if (tune === "touchpad") openTouchpadTuning();
        if (tune === "trackball") openTrackballSensor();
    }, [keyboard, setActivePanel, openDetails, setPanelToGoBack, setItemToEdit]);
    return null;
}
