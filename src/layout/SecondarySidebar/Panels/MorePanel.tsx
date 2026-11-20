import React from "react";
import { AppWindow, ArrowRight, type LucideIcon } from "lucide-react";

import AltRepeatArrowsIcon from "@/components/icons/AltRepeatArrowsIcon";
import OverridesIcon from "@/components/icons/Overrides";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { usePanels } from "@/contexts/PanelsContext";
import { ALT_REPEAT_PANEL, APP_LAYERS_PANEL, OVERRIDES_PANEL } from "@/lib/morePanel";
import { cn } from "@/lib/utils";
import { hasAppRules } from "@/services/app-rules";

type MoreTool = {
    panel: string;
    title: string;
    description: string;
    Icon: LucideIcon | React.FC<React.SVGProps<SVGSVGElement>>;
};

/** Editing tools that most people never need, each with one line on what it does. */
const MORE_TOOLS: MoreTool[] = [
    {
        panel: OVERRIDES_PANEL,
        title: "Overrides",
        description: "Change what a key sends while a modifier is held.",
        Icon: OverridesIcon,
    },
    {
        panel: ALT_REPEAT_PANEL,
        title: "Alt-Repeat",
        description: "Type the opposite of your last key.",
        Icon: AltRepeatArrowsIcon,
    },
    {
        panel: APP_LAYERS_PANEL,
        title: "App Layers",
        description: "Layers that follow the app in front.",
        Icon: AppWindow,
    },
];

/** The tools this board can use: App Layers needs firmware with app rules. */
export function moreToolsFor(appLayers: boolean): MoreTool[] {
    return MORE_TOOLS.filter((tool) => tool.panel !== APP_LAYERS_PANEL || appLayers);
}

const MorePanel: React.FC = () => {
    const { setActivePanel, setPanelToGoBack, setAlternativeHeader, setItemToEdit } = usePanels();
    const { keyboard } = useKeyboard();
    const { layoutMode } = useLayoutSettings();
    const horizontal = layoutMode === "bottombar";
    const tools = moreToolsFor(hasAppRules(keyboard?.feature_flags5));

    const open = (panel: string) => {
        setActivePanel(panel);
        setPanelToGoBack(null);
        setAlternativeHeader(false);
        setItemToEdit(null);
    };

    return (
        <nav aria-label="More editors" className={cn("p-4", horizontal ? "grid grid-cols-3 gap-3 py-2" : "flex flex-col gap-2")} data-more-tools="">
            {tools.map(({ panel, title, description, Icon }) => (
                <button
                    key={panel}
                    type="button"
                    onClick={() => open(panel)}
                    data-more-tool={panel}
                    className="group flex items-center gap-3 rounded-xl border border-sidebar-border bg-sidebar p-3 text-left text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                    <Icon className="h-5 w-5 shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-semibold">{title}</span>
                        <span className="text-sm text-muted-foreground">{description}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
            ))}
        </nav>
    );
};

export default MorePanel;
