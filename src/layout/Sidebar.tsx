import { ArrowLeft, BookOpen, Ellipsis, Keyboard, ListOrdered, LucideIcon, Mouse, PanelLeftClose, PanelLeftOpen, Piano, Rocket, Settings } from "lucide-react";
import KeybardLogo from "@/components/icons/KeybardLogo";
import PointingDeviceBall01Icon from "@/components/icons/PointingDeviceBall01Icon";
import LayoutLayersIcon from "@/components/icons/LayoutLayersIcon";
import GraduationCapIcon from "@/components/icons/GraduationCapIcon";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { OverlayDialog, overlayRequested } from "@/features/trainer/OverlayDialog";
import { HostSettingsSync } from "@/features/trainer/HostSettingsSync";

import ComboIcon from "@/components/ComboIcon";
import { isExcludedMenu, getIconForMenu } from "@/constants/custom-ui-exclusions";

import LayersDefaultIcon from "@/components/icons/LayersDefault";
import MacrosIcon from "@/components/icons/MacrosIcon";
import TapdanceIcon from "@/components/icons/Tapdance";
import Logo from "@/components/Logo";
import ViewfinderMark from "@/components/icons/ViewfinderMark";
import { SpotlightScrim } from "@/layout/BindingSpotlight";
import {
    Sidebar,
    SidebarContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar
} from "@/components/ui/sidebar";
import { usePanels } from "@/contexts/PanelsContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { cn } from "@/lib/utils";
import { MANUAL_URL } from "@/lib/manual";
import { requestSettingsSection, settingsSectionForPanel } from "@/layout/SecondarySidebar/Panels/settings/anchor";
import { useFirmwareUpdates } from "@/features/firmware/FirmwareUpdateProvider";
import { bindingEditorKind, currentRailMode, isBindingEditorOpen, modalRailExitLabel, pickerCategoryForRail, effectivePickerMode, nudgeBindingEditor, reviewChoice, RAIL_BARS, RAIL_BAR_PARAM, usablePickerCategories } from "@/lib/bindingSpotlight";
import { MORE_PANEL, railPanelFor } from "@/lib/morePanel";

// --- Constants ---
const MENU_ITEM_GAP_PX = 42; // Matches Gap-4 (16px) + Button Height (26px)
const DIVIDER_HEIGHT_PX = 17; // 1px + 2*8px (my-2)
const FLEX_GAP_PX = 16; // Gap-4
const DIVIDER_OFFSET = DIVIDER_HEIGHT_PX + FLEX_GAP_PX;

// Keep the icon rail fixed while the surrounding sidebar animates its width.
// Subtract the container borders so icons stay centered in the collapsed rail.
const ICON_GUTTER_CLASSES = "w-[calc(var(--sidebar-width-icon)-2px)] flex items-center justify-center shrink-0";

export type SidebarItem = {
    title: string;
    url: string;
    icon: LucideIcon | React.FC<React.SVGProps<SVGSVGElement>>;
    /** A page opened in a new tab instead of a panel. */
    href?: string;
};

// Top section items (Keyboard and Pointing Devices, before the spacer)
export const topSectionItems: SidebarItem[] = [
    { title: "Standard Keys", url: "keyboard", icon: Keyboard },
    { title: "Pointing Devices", url: "pointing", icon: PointingDeviceBall01Icon },
];

// Middle section items (after the spacer, before the divider)
export const middleSectionItems: SidebarItem[] = [
    { title: "Special Keys", url: "special", icon: Piano },
    { title: "Layer Keys", url: "layers", icon: LayersDefaultIcon },
    { title: "Mouse Keys", url: "mouse", icon: Mouse },
    { title: "Tap Dance Keys", url: "tapdances", icon: TapdanceIcon },
    { title: "Macro Keys", url: "macros", icon: MacrosIcon },
];

// For backward compatibility
export const primarySidebarItemsBeforeDynamic: SidebarItem[] = topSectionItems;
export const primarySidebarItemsAfterDynamic: SidebarItem[] = middleSectionItems;

// Combined for backward compatibility and index calculations
export const primarySidebarItems: SidebarItem[] = [
    ...topSectionItems,
    ...middleSectionItems,
];

// Leaders - enable when ready to test
const SHOW_LEADERS = true;

/**
 * The binding group of the rail: Combos, Leaders, More. More holds the editors most people never need
 * (Overrides, Alt-Repeat and, on firmware with app rules, App Layers; see MorePanel), and stays marked while
 * one of them is open. Typing behavior is set up once, so it lives in Settings.
 */
export const featureSidebarItems: SidebarItem[] = [
    { title: "Combos", url: "combos", icon: ComboIcon },
    ...(SHOW_LEADERS ? [{ title: "Leaders", url: "leaders", icon: ListOrdered }] : []),
    { title: "More", url: MORE_PANEL, icon: Ellipsis },
];

// Layouts stands alone. Hardware (clusters, pointing devices, ball color) is set up once, so it lives in Settings.
export const layoutSidebarItems: SidebarItem[] = [
    { title: "Layouts", url: "layouts", icon: LayoutLayersIcon },
];

// Help and the desktop overlay, with Settings last.
export const footerItems: SidebarItem[] = [
    { title: "Quick Start", url: "quickstart", icon: Rocket },
    // The manual is the Keybard section of the docs site, opened in a new tab by the
    // person's click (Keybard Paranoid too: the page itself requests nothing).
    { title: "Manual", url: "manual", icon: BookOpen, href: MANUAL_URL },
    // The desktop overlay is a separate app: the item opens a small dialog, not a panel.
    { title: "Overlay", url: "trainer", icon: GraduationCapIcon },
    { title: "Settings", url: "settings", icon: Settings },
];

// --- Sub-components ---

// The active bar shares its x, height and ends with the editing origin bar
// (--kb-rail-bar-*, see index.css), so it keeps its shape when an editor opens.
const SlidingIndicator = ({ y }: { y: number }) => (
    <div
        className="absolute left-(--kb-rail-bar-x) top-[calc((26px-var(--kb-rail-bar-h))/2)] w-[3px] h-(--kb-rail-bar-h) rounded-[var(--kb-spot-bar-radius)] bg-kb-active z-20 transition-transform duration-300 ease-in-out pointer-events-none"
        style={{ transform: `translateY(${y}px)` }}
    />
);

const NAV_BOX_PADDING_PX = 8;

/**
 * Centers the main navigation on a whole pixel: flex centering lands on a
 * half pixel whenever the free space is odd, which leaves the rail items
 * (and their pills and bar) at fractional positions at 1x.
 */
function useWholePixelCenter(remountKey: unknown) {
    const boxRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLUListElement>(null);
    const [offset, setOffset] = useState(0);
    useLayoutEffect(() => {
        const box = boxRef.current;
        const menu = menuRef.current;
        if (!box || !menu) return;
        const measure = () => setOffset(Math.max(0, Math.floor((box.clientHeight - NAV_BOX_PADDING_PX * 2 - menu.offsetHeight) / 2)));
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        observer.observe(menu);
        return () => observer.disconnect();
        // The nav remounts when the rail's contents swap (?railMode=modal), so it is measured again.
    }, [remountKey]);
    return { boxRef, menuRef, offset };
}

interface SidebarNavItemProps {
    item: SidebarItem;
    isActive: boolean;
    isPreviousPanel?: boolean;
    alternativeHeader?: boolean;
    isCollapsed: boolean;
    onClick: (item: SidebarItem) => void;
    /** A quiet dot on the icon: a firmware update the user hasn't opened yet. */
    dot?: string;
    /**
     * While a binding editor is open: "lift" keeps a usable picker category
     * above the rail's scrim; "origin" lifts the item the editor was opened
     * from (marked, but a click only points to the way out); "cover" leaves
     * the item under the scrim, out of reach.
     */
    spotlight?: RailSpotlight;
    /** While editing: the picker category on show. */
    current?: boolean;
}

type RailSpotlight = "lift" | "origin" | "cover";

const SidebarNavItem = ({
    item,
    isActive,
    isPreviousPanel,
    alternativeHeader,
    isCollapsed,
    onClick,
    dot,
    spotlight,
    current,
}: SidebarNavItemProps) => (
    <SidebarMenuItem
        className="cursor-pointer"
        inert={spotlight === "cover"}
        data-spotlight={spotlight}
        data-spotlight-rail={spotlight === "lift" || spotlight === "origin" ? spotlight : undefined}
        data-spotlight-current={current ? "" : undefined}
    >
        <SidebarMenuButton
            asChild
            isActive={isActive}
            tooltip={item.title}
            sidebarName="primary-nav"
            size="nav"
            className={cn(
                "transition-colors",
                (alternativeHeader ? isPreviousPanel : isActive) ? "text-sidebar-foreground" : "text-gray-400 dark:text-neutral-400"
            )}
        >
            {item.href ? (
                <a href={item.href} target="_blank" rel="noopener" aria-label={item.title} className="flex w-full items-center justify-start">
                    <div className={cn(ICON_GUTTER_CLASSES, "h-full")}>
                        <item.icon className="h-5 w-5 shrink-0" />
                    </div>
                    <span className={cn("truncate", isCollapsed && "hidden")}>
                        {item.title}
                    </span>
                </a>
            ) : (
                <button type="button" aria-label={dot ? `${item.title}, ${dot}` : item.title} aria-pressed={isActive} onClick={() => onClick(item)} className="flex w-full items-center justify-start">
                    <div className={cn(ICON_GUTTER_CLASSES, "relative h-full")}>
                        <item.icon className="h-5 w-5 shrink-0" />
                        {dot && <span aria-hidden="true" data-testid="rail-dot" className="absolute right-[calc(50%-12px)] top-[calc(50%-12px)] h-2 w-2 rounded-full bg-kb-primary ring-2 ring-sidebar" />}
                    </div>
                    <span className={cn("truncate", isCollapsed && "hidden")}>
                        {item.title}
                    </span>
                </button>
            )}
        </SidebarMenuButton>
    </SidebarMenuItem>
);

// --- Main Component ---

const AppSidebar = () => {
    const [overlayOpen, setOverlayOpen] = useState(() => overlayRequested());
    const { state, toggleSidebar, setOpen: setNavigationOpen, setForcedCollapsed } = useSidebar("primary-nav", { defaultOpen: false });
    const isCollapsed = state === "collapsed";
    const {
        setItemToEdit,
        setActivePanel,
        openDetails,
        activePanel,
        panelToGoBack,
        alternativeHeader,
        setPanelToGoBack,
        setAlternativeHeader,
        open,
        handleCloseDetails,
        setOpen,
        itemToEdit,
        pickerMode,
        setPickerMode,
        handleCloseEditor,
    } = usePanels();
    // While a binding editor is open, the rail's picker categories switch the
    // picker and nothing on the rail leaves the editor.
    const editing = isBindingEditorOpen(activePanel, itemToEdit);
    const shownPickerMode = editing ? effectivePickerMode(pickerMode ?? "keyboard", activePanel) : null;
    // ?railMode=collapse: while editing the whole rail is under the scrim and
    // narrows to its icons; the side panel's category strip picks instead.
    const railMode = useMemo(currentRailMode, []);
    const railCollapse = editing && railMode === "collapse";
    // ?railMode=modal: while editing the rail is the editor's own: its picker
    // categories replace the navigation and the top-left corner is the way out.
    const railModal = editing && railMode === "modal";
    // The contents swap in place when the mode changes (never on first load).
    const [swapFor, setSwapFor] = useState(railModal);
    const [swapped, setSwapped] = useState(false);
    if (swapFor !== railModal) {
        setSwapFor(railModal);
        setSwapped(true);
    }
    const railSpotlight = (url: string): RailSpotlight | undefined =>
        !editing || railModal ? undefined : railCollapse ? "cover" : pickerCategoryForRail(url, activePanel) ? "lift" : url === railPanelFor(activePanel) ? "origin" : "cover";
    useEffect(() => {
        if (railMode !== "collapse") return;
        const root = document.documentElement;
        root.setAttribute("data-rail-mode", "collapse");
        return () => root.removeAttribute("data-rail-mode");
    }, [railMode]);
    // Held narrow while editing, never saved: leaving the editor brings back the person's own width.
    // (The setter is new on every sidebar change, so it is read through a ref.)
    const setForcedRef = useRef(setForcedCollapsed);
    setForcedRef.current = setForcedCollapsed;
    useEffect(() => {
        if (!railCollapse) return;
        setForcedRef.current(true);
        return () => setForcedRef.current(false);
    }, [railCollapse]);

    const { keyboard } = useKeyboard();
    const firmwareDot = useFirmwareUpdates()?.status.dot ? "firmware update available" : undefined;
    const navCenter = useWholePixelCenter(railModal);
    // Owner review: ?railBar=flush|gap2|kiss (unset is flush).
    const railBar = useMemo(() => reviewChoice(window.location.search, RAIL_BAR_PARAM, RAIL_BARS), []);

    // The editors under More (Overrides, Alt-Repeat, App Layers) are marked on the rail as More.
    const railPanel = railPanelFor(activePanel);

    const handleItemSelect = useCallback(
        (selected: SidebarItem) => {
            let item = selected;
            if (railModal) {
                const category = pickerCategoryForRail(item.url, activePanel);
                if (category) setPickerMode(category);
                return;
            }
            if (railCollapse) {
                nudgeBindingEditor(undefined, "rail");
                return;
            }
            if (editing) {
                const category = pickerCategoryForRail(item.url, activePanel);
                if (category) setPickerMode(category);
                // The editor's own item never leaves it: it points to the way out.
                else if (item.url === railPanelFor(activePanel)) nudgeBindingEditor();
                return;
            }
            // Panels that became cards of Settings open Settings at that card.
            const settingsSection = settingsSectionForPanel(item.url);
            if (settingsSection) {
                requestSettingsSection(settingsSection);
                if (activePanel === "settings" && open) {
                    if (window.innerWidth < 900) setNavigationOpen(false);
                    return;
                }
                item = { ...item, url: "settings" };
            }
            // Labels can be expanded to choose a destination; return the narrow
            // viewport to its icon rail so the chosen panel remains usable.
            if (window.innerWidth < 900) setNavigationOpen(false);
            // The desktop overlay is a separate app: a small dialog, not a panel.
            if (item.url === "trainer") { setOverlayOpen(true); return; }
            if (item.url === "matrixtester") {
                if (activePanel === item.url) {
                    setActivePanel(null);
                    return;
                }
                setOpen(false);
                setActivePanel(item.url);
                setPanelToGoBack(null);
                setItemToEdit(null);
                return;
            }

            if (activePanel === item.url && open) {
                handleCloseDetails();
            } else {
                setActivePanel(item.url);
                openDetails();
                setPanelToGoBack(null);
                setAlternativeHeader(false);
                setItemToEdit(null);
            }
        },
        [editing, railModal, railCollapse, setPickerMode, setNavigationOpen, activePanel, open, handleCloseDetails, setActivePanel, openDetails, setPanelToGoBack, setAlternativeHeader, setItemToEdit, setOpen]
    );



    // Build dynamic menu items from keyboard definition
    const dynamicMenuItems: SidebarItem[] = useMemo(() => {
        if (!keyboard?.menus) return [];

        return keyboard.menus
            .map((menu, originalIndex) => ({ menu, originalIndex }))
            .filter(({ menu }) => !isExcludedMenu(menu.label))
            .map(({ menu, originalIndex }) => {
                const iconName = getIconForMenu(menu.label);
                // Map icon name to component
                const IconComponent = iconName === 'target' ? PointingDeviceBall01Icon : iconName === 'mouse' ? Mouse : Settings;

                return {
                    title: menu.label || `Menu ${originalIndex}`,
                    url: `dynamic-menu-${originalIndex}`,
                    icon: IconComponent,
                };
            });
    }, [keyboard?.menus]);

    // While editing, the rail marks the picker category in use.
    const markedPanel = editing ? shownPickerMode : railPanel;
    const activeTopIndex = topSectionItems.findIndex((item) => item.url === markedPanel);
    const activeMiddleIndex = middleSectionItems.findIndex((item) => item.url === markedPanel);
    const activeFeatureIndex = featureSidebarItems.findIndex((item) => item.url === markedPanel);
    const activeLayoutIndex = layoutSidebarItems.findIndex((item) => item.url === markedPanel);
    const activeDynamicIndex = dynamicMenuItems.findIndex((item) => item.url === markedPanel);
    const activeFooterIndex = footerItems.findIndex((item) => item.url === markedPanel);

    let indicatorY = -1;
    if (activeTopIndex !== -1) {
        // Top section items (Keyboard, Pointing Devices)
        indicatorY = activeTopIndex * MENU_ITEM_GAP_PX;
    } else if (activeDynamicIndex !== -1 && dynamicMenuItems.length > 0) {
        // Dynamic menu items - right after Pointing Devices
        indicatorY = (topSectionItems.length * MENU_ITEM_GAP_PX) + (activeDynamicIndex * MENU_ITEM_GAP_PX);
    } else if (activeMiddleIndex !== -1) {
        // Middle section items - after first divider
        indicatorY = (topSectionItems.length * MENU_ITEM_GAP_PX)
            + (dynamicMenuItems.length * MENU_ITEM_GAP_PX)
            + DIVIDER_OFFSET
            + (activeMiddleIndex * MENU_ITEM_GAP_PX);
    } else if (activeFeatureIndex !== -1) {
        // Feature items - after two dividers
        indicatorY = (topSectionItems.length * MENU_ITEM_GAP_PX)
            + (dynamicMenuItems.length * MENU_ITEM_GAP_PX)
            + DIVIDER_OFFSET
            + (middleSectionItems.length * MENU_ITEM_GAP_PX)
            + DIVIDER_OFFSET
            + (activeFeatureIndex * MENU_ITEM_GAP_PX);
    } else if (activeLayoutIndex !== -1) {
        // Layout items - after three dividers
        indicatorY = (topSectionItems.length * MENU_ITEM_GAP_PX)
            + (dynamicMenuItems.length * MENU_ITEM_GAP_PX)
            + DIVIDER_OFFSET
            + (middleSectionItems.length * MENU_ITEM_GAP_PX)
            + DIVIDER_OFFSET
            + (featureSidebarItems.length * MENU_ITEM_GAP_PX)
            + DIVIDER_OFFSET
            + (activeLayoutIndex * MENU_ITEM_GAP_PX);
    }

    // ?railMode=modal: the editor's picker categories, in rail order, with the rail's own icons.
    const modalItems = useMemo(() => {
        if (!railModal) return [];
        const byUrl = new Map(primarySidebarItems.map(item => [item.url, item]));
        return usablePickerCategories(activePanel).map(id => byUrl.get(id)).filter((item): item is SidebarItem => !!item);
    }, [railModal, activePanel]);
    const modalActiveIndex = modalItems.findIndex(item => item.url === shownPickerMode);
    const editorKind = bindingEditorKind(activePanel, itemToEdit);
    const exitLabel = modalRailExitLabel(editorKind);

    const sidebarClasses = cn(
        // Above the page scrim while editing; its own scrim covers what the editor cannot use.
        // The spotlight rules take the rim and shadow off (data-spotlight-rail-frame).
        editing ? "z-[47]" : "z-11",
        // Whole-pixel insets: the rail's surface spans 8px to 100vh - 8px, the same as the side panel.
        "fixed transition-[box-shadow,border-color] duration-300 ease-out border border-sidebar-border shadow-lg ml-2 h-[calc(100vh-14px)] mt-[7px] transition-all",
        "rounded-3xl select-none",
        // The collapse variant narrows and restores in 250ms; instant with reduced motion.
        railMode === "collapse" && "duration-[250ms] motion-reduce:transition-none"
    );

    return (
        <>
            <HostSettingsSync />
            <OverlayDialog open={overlayOpen} onOpenChange={setOverlayOpen} />
            {/* Hidden file input for import */}



            <Sidebar rounded name="primary-nav" defaultOpen={false} collapsible="icon" hideGap className={sidebarClasses}
                data-spotlight-rail-frame={editing ? "" : undefined}
                data-rail-bar={railBar ?? undefined}
                data-rail-collapsed={railCollapse ? "" : undefined}
                data-rail-modal-frame={railModal ? "" : undefined}>
                {/* The rail is its own fixed layer above the page scrim, so it carries the
                    same scrim over its own surface, the same shape as it. */}
                {editing && !railModal && <SpotlightScrim className="absolute inset-0 z-[5]" source="rail" />}
                {railModal ? (
                <SidebarContent key="modal" data-rail-modal="" className={cn("py-4 overflow-y-auto overflow-x-hidden flex flex-col", swapped && "rail-mode-swap", isCollapsed && "scrollbar-none")}>
                    {/* The way out, where the logo sits: the one place that goes back to the rest of the app. */}
                    <SidebarMenu>
                        {/* Inset from the rail's edge, so its ring never runs under the panel. */}
                        <SidebarMenuItem className={cn(!isCollapsed && "pr-3")}>
                            <SidebarMenuButton
                                asChild
                                size="nav"
                                tooltip={exitLabel}
                                sidebarName="primary-nav"
                                className="transition-colors !h-auto text-sidebar-foreground"
                            >
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-start font-semibold"
                                    aria-label={exitLabel}
                                    data-binding-editor-back=""
                                    data-rail-exit=""
                                    onClick={() => handleCloseEditor()}
                                >
                                    <div className={cn(ICON_GUTTER_CLASSES, "h-8")}>
                                        <ArrowLeft className="h-5 w-5 shrink-0" />
                                    </div>
                                    {/* Two lines, so the editor's name never truncates in the rail's width. */}
                                    <span className={cn("flex min-w-0 flex-col items-start pr-3 leading-tight", isCollapsed && "hidden")} data-rail-exit-label="">
                                        <span className="text-xs font-normal text-muted-foreground">Done with</span>
                                        <span className="truncate max-w-full">{editorKind}</span>
                                    </span>
                                </button>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>

                    {/* The editor's picker categories: the rail is the picker selector now. */}
                    <div className="flex-1 flex flex-col justify-center py-2">
                        <SidebarMenu className="relative" aria-label="Pick keys from">
                            {modalActiveIndex !== -1 && <SlidingIndicator y={modalActiveIndex * MENU_ITEM_GAP_PX} />}
                            {modalItems.map((item, index) => (
                                <SidebarNavItem
                                    key={item.url}
                                    item={item}
                                    isActive={index === modalActiveIndex}
                                    isCollapsed={isCollapsed}
                                    onClick={handleItemSelect}
                                />
                            ))}
                        </SidebarMenu>
                    </div>

                    {/* The rail keeps the person's width; its toggle moves here while the corner is the exit. */}
                    <div className="py-2 mb-3">
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    asChild
                                    size="nav"
                                    tooltip="Show labels"
                                    sidebarName="primary-nav"
                                    className="transition-colors text-gray-400 dark:text-neutral-400"
                                >
                                    <button
                                        type="button"
                                        className="flex w-full items-center justify-start"
                                        aria-label={isCollapsed ? "Expand navigation" : "Collapse navigation"}
                                        aria-expanded={!isCollapsed}
                                        onClick={() => toggleSidebar()}
                                    >
                                        <div className={cn(ICON_GUTTER_CLASSES, "h-full")}>
                                            {isCollapsed ? <PanelLeftOpen className="h-5 w-5 shrink-0" /> : <PanelLeftClose className="h-5 w-5 shrink-0" />}
                                        </div>
                                        <span className={cn("truncate", isCollapsed && "hidden")}>Show icons only</span>
                                    </button>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </div>
                </SidebarContent>
                ) : (
                <SidebarContent key="nav" className={cn("py-4 overflow-y-auto overflow-x-hidden flex flex-col", swapped && "rail-mode-swap", isCollapsed && "scrollbar-none")}>
                    {/* Header section - Logo, Connect, Import/Export */}
                    <SidebarMenu>
                        {/* While editing, the logo stays under the scrim and is not a control. */}
                        <SidebarMenuItem inert={editing} data-spotlight={editing ? "cover" : undefined}>
                            <SidebarMenuButton
                                asChild
                                size="nav"
                                sidebarName="primary-nav"
                                className="transition-colors !overflow-visible !h-auto"
                            >
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-start"
                                    aria-label={isCollapsed ? "Expand navigation" : "Collapse navigation"}
                                    aria-expanded={!isCollapsed}
                                    onClick={() => toggleSidebar()}
                                >
                                    <div className={cn(ICON_GUTTER_CLASSES, "h-8")}>
                                        {editing
                                            ? <ViewfinderMark className="!w-6 !h-6 !min-w-6 !min-h-6" data-logo-mark="viewfinder" />
                                            : <Logo className="!w-6 !h-6 !min-w-6 !min-h-6" data-logo-mark="brand" />}
                                    </div>
                                    <KeybardLogo className={cn("shrink-0 !h-[32px] !w-auto", isCollapsed && "hidden")} />
                                </button>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>

                    {/* Main navigation - vertically centered in available space */}
                    <div ref={navCenter.boxRef} className="flex-1 flex flex-col py-2" style={{ paddingTop: NAV_BOX_PADDING_PX + navCenter.offset }}>
                        <SidebarMenu ref={navCenter.menuRef} className="relative">
                            {/* While editing, the current category is marked by weight and the origin by its own bar. */}
                            {indicatorY !== -1 && !editing && <SlidingIndicator y={indicatorY} />}

                            {/* Top section items (Keyboard, Pointing Devices) */}
                            {topSectionItems.map((item) => (
                                <SidebarNavItem
                                    key={item.url}
                                    item={item}
                                    isActive={markedPanel === item.url}
                                    isPreviousPanel={railPanelFor(panelToGoBack) === item.url}
                                    alternativeHeader={alternativeHeader && !editing}
                                    isCollapsed={isCollapsed}
                                    onClick={handleItemSelect}
                                    spotlight={railSpotlight(item.url)}
                                    current={editing && shownPickerMode === item.url}
                                />
                            ))}

                            {/* Dynamic menu items from keyboard definition - right after Pointing Devices */}
                            {dynamicMenuItems.map((item) => (
                                <SidebarNavItem
                                    key={item.url}
                                    item={item}
                                    isActive={markedPanel === item.url}
                                    isPreviousPanel={railPanelFor(panelToGoBack) === item.url}
                                    alternativeHeader={alternativeHeader && !editing}
                                    isCollapsed={isCollapsed}
                                    onClick={handleItemSelect}
                                    spotlight={railSpotlight(item.url)}
                                    current={editing && shownPickerMode === item.url}
                                />
                            ))}

                            {/* Divider between top section and middle section */}
                            <div data-spotlight-rail-rule={editing ? "" : undefined} className="mx-4 my-2 h-[1px] bg-slate-400 dark:bg-neutral-600" />

                            {/* Middle section items (Special, Layer Keys, Mouse Keys, Tap Dances, Macros) */}
                            {middleSectionItems.map((item) => (
                                <SidebarNavItem
                                    key={item.url}
                                    item={item}
                                    isActive={markedPanel === item.url}
                                    isPreviousPanel={railPanelFor(panelToGoBack) === item.url}
                                    alternativeHeader={alternativeHeader && !editing}
                                    isCollapsed={isCollapsed}
                                    onClick={handleItemSelect}
                                    spotlight={railSpotlight(item.url)}
                                    current={editing && shownPickerMode === item.url}
                                />
                            ))}

                            <div data-spotlight-rail-rule={editing ? "" : undefined} className="mx-4 my-2 h-[1px] bg-slate-400 dark:bg-neutral-600" />

                            {featureSidebarItems.map((item) => (
                                <SidebarNavItem
                                    key={item.url}
                                    item={item}
                                    isActive={markedPanel === item.url}
                                    isPreviousPanel={railPanelFor(panelToGoBack) === item.url}
                                    alternativeHeader={alternativeHeader && !editing}
                                    isCollapsed={isCollapsed}
                                    onClick={handleItemSelect}
                                    spotlight={railSpotlight(item.url)}
                                    current={editing && shownPickerMode === item.url}
                                />
                            ))}

                            <div data-spotlight-rail-rule={editing ? "" : undefined} className="mx-4 my-2 h-[1px] bg-slate-400 dark:bg-neutral-600" />

                            {layoutSidebarItems.map((item) => (
                                <SidebarNavItem
                                    key={item.url}
                                    item={item}
                                    isActive={markedPanel === item.url}
                                    isPreviousPanel={railPanelFor(panelToGoBack) === item.url}
                                    alternativeHeader={alternativeHeader && !editing}
                                    isCollapsed={isCollapsed}
                                    onClick={handleItemSelect}
                                    spotlight={railSpotlight(item.url)}
                                    current={editing && shownPickerMode === item.url}
                                />
                            ))}
                        </SidebarMenu>
                    </div>

                    {/* Footer section - Quick Start, Manual, Overlay, Settings */}
                    <div className="py-2 mb-3">
                        <SidebarMenu className="relative">
                            {activeFooterIndex !== -1 && !editing && <SlidingIndicator y={activeFooterIndex * MENU_ITEM_GAP_PX} />}
                            {footerItems.map((item) => (
                                <SidebarNavItem
                                    key={item.url}
                                    item={item}
                                    isActive={markedPanel === item.url}
                                    isCollapsed={isCollapsed}
                                    onClick={handleItemSelect}
                                    dot={item.url === "settings" ? firmwareDot : undefined}
                                    spotlight={railSpotlight(item.url)}
                                    current={editing && shownPickerMode === item.url}
                                />
                            ))}
                        </SidebarMenu>

                    </div>
                </SidebarContent>
                )}
            </Sidebar>
        </>
    );
};

export default AppSidebar;
