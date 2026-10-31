import { useEffect, useRef } from "react";

import { useKeyboard } from "@/contexts/KeyboardContext";
import { usePanels } from "@/contexts/PanelsContext";
import { pointingDemo } from "@/features/pointing-demo";
import { requestSettingsSection, settingsSectionForPanel } from "@/layout/SecondarySidebar/Panels/settings/anchor";
import { openTouchpadTuning } from "@/components/touchpad-tuning/tuning-open";
import { tuneFromSearch } from "@/lib/deepLinks";

/**
 * ?panel=settings opens Settings once a layout is loaded (with ?demo, the
 * QWERTY Example), so a review link lands on the Settings page. The old panel
 * names of what is now in Settings (?panel=typing, clusters, fragments, about) open
 * Settings at that section, as do ?panel=firmware and ?panel=backups. ?panel=scanlab opens the Scan Lab and ?panel=pointing
 * the Pointing Devices panel (its settings, auto mouse included), ?panel=keyboard the Standard
 * Keys panel. Once per page load.
 */
export default function PointingDeepLink() {
    const { keyboard } = useKeyboard();
    const { setActivePanel, openDetails, setPanelToGoBack, setItemToEdit } = usePanels();
    const done = useRef(false);
    useEffect(() => {
        const panel = pointingDemo()?.panel;
        if (!keyboard || !panel || done.current) return;
        done.current = true;
        if (panel === "scanlab" || panel === "pointing" || panel === "keyboard") {
            setActivePanel(panel);
            setPanelToGoBack(null);
            setItemToEdit(null);
            openDetails();
            if (panel === "pointing" && tuneFromSearch(window.location.search)) openTouchpadTuning();
            return;
        }
        const section = settingsSectionForPanel(panel);
        if (section) requestSettingsSection(section);
        setActivePanel("settings");
        setPanelToGoBack(null);
        setItemToEdit(null);
        openDetails();
        // ?panel=settings&tune=touchpad: Settings, with the Touchpad tuning dialog open.
        if (panel === "settings" && tuneFromSearch(window.location.search)) {
            requestSettingsSection("touchpad");
            openTouchpadTuning();
        }
    }, [keyboard, setActivePanel, openDetails, setPanelToGoBack, setItemToEdit]);
    return null;
}
