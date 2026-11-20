import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import AppRulesSection from "./AppRulesSection";

/**
 * App Layers: the layers the board changes while an app is in front on the computer
 * (app rules on the board). Opened from the rail's More, which lists it only on
 * firmware with the feature (GET_INFO byte 22 bit 0); the section itself shows
 * nothing without it.
 */
export default function AppLayersPanel() {
    const { layoutMode } = useLayoutSettings();
    const horizontal = layoutMode === "bottombar";
    return (
        <section className={horizontal ? "px-4 py-2" : "flex flex-col gap-4 py-4 pl-5 pr-[26px]"} data-app-layers-panel>
            <AppRulesSection compact={horizontal} inPanel />
        </section>
    );
}
