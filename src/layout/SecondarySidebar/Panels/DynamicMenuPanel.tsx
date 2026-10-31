import { selectPointingMenu, type PointingMenuSection } from "@/utils/pointing-menu";
import { withEffectiveTiming } from "@/utils/scan-timing";
import { useCallback, useMemo } from "react";
import { CustomUIRenderer } from "@/components/CustomUI";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { useMenuValues } from "@/hooks/useMenuValues";
import { openTouchpadTuning } from "@/components/touchpad-tuning/tuning-open";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { boardHasTouchpad, PAD_KEYS } from "@/utils/touchpad-taps";
import { PAD_TUNING_KEYS, TUNE_TOUCHPAD_ACTION } from "@/utils/touchpad-tuning";

// The tuning values are shown in Settings, never here; on a board without a
// touchpad, nothing of the Touchpad section shows.
const TUNING_HIDDEN: ReadonlySet<string> = new Set(PAD_TUNING_KEYS);
const PAD_HIDDEN: ReadonlySet<string> = new Set([...PAD_KEYS, ...PAD_TUNING_KEYS, TUNE_TOUCHPAD_ACTION]);

interface DynamicMenuPanelProps {
    menuIndex: number;
    /** When true, renders controls in a horizontal flow layout (for BottomPanel) */
    horizontal?: boolean;
    /** Let the containing panel own scrolling when this menu is embedded. */
    embedded?: boolean;
    section?: PointingMenuSection;
}

/**
 * Dynamic panel that renders a VIA3 custom UI menu
 * Seeds values from kbinfo.custom_values (loaded at connect time),
 * and keeps manual drafts visible until Apply or Discard.
 * On value change, updates both the keyboard and kbinfo.custom_values.
 */
const DynamicMenuPanel: React.FC<DynamicMenuPanelProps> = ({ menuIndex, horizontal = false, embedded = false, section = "all" }) => {
    const { keyboard, isConnected } = useKeyboard();

    // Get the menu for this panel
    const menu = keyboard?.menus?.[menuIndex];
    // The touchpad taps show only while a half has a touchpad. The tuning
    // values live in Settings (Touchpad tuning); here a link opens them.
    const hasTouchpad = boardHasTouchpad(keyboard);
    const displayItems = useMemo(() => selectPointingMenu(
        (menu?.content ?? []) as CustomUIMenuItem[], section, hasTouchpad ? TUNING_HIDDEN : PAD_HIDDEN,
    ), [menu, section, hasTouchpad]);
    const { values, setValue: handleValueChange, loading, error } = useMenuValues(menu);
    const shownValues = useMemo(() => withEffectiveTiming(values), [values]);

    const handleButtonClick = useCallback(async (key: string) => {
        if (key === TUNE_TOUCHPAD_ACTION) { openTouchpadTuning(); return; }
        await handleValueChange(key, 1);
    }, [handleValueChange]);

    // No menu found
    if (!menu) {
        return (
            <section className={`${embedded ? "" : "h-full "}flex flex-col items-center justify-center p-4`}>
                <p className="text-muted-foreground">Menu not found</p>
            </section>
        );
    }

    // Not connected
    if (!isConnected) {
        return (
            <section className={`${embedded ? "" : "h-full "}flex flex-col p-4`}>
                <h2 className="text-lg font-semibold mb-4">{menu.label}</h2>
                <p className="text-muted-foreground">Connect to a keyboard to view settings</p>
            </section>
        );
    }

    // Loading
    if (loading) {
        return (
            <section className={`${embedded ? "" : "h-full "}flex flex-col p-4`}>
                <h2 className="text-lg font-semibold mb-4">{menu.label}</h2>
                <p className="text-muted-foreground">Loading settings...</p>
            </section>
        );
    }

    // Error
    if (error) {
        return (
            <section className={`${embedded ? "" : "h-full "}flex flex-col p-4`}>
                <h2 className="text-lg font-semibold mb-4">{menu.label}</h2>
                <p className="text-red-500 dark:text-red-400">{error}</p>
            </section>
        );
    }

    // Render the menu
    // Horizontal mode: compact flowing layout for bottom panel
    // Vertical mode: title on top, controls stacked below
    if (horizontal) {
        return (
            <section className={embedded ? "px-2 py-1" : "px-2 py-1"}>
                <CustomUIRenderer
                    items={displayItems}
                    values={shownValues}
                    onValueChange={handleValueChange}
                    onButtonClick={handleButtonClick}
                    horizontal
                    compact
                />
            </section>
        );
    }

    return (
        <section className={embedded ? "" : "flex flex-col"}>
            <div className={embedded ? "pb-4" : "pb-4"}>
                <CustomUIRenderer
                    items={displayItems}
                    values={shownValues}
                    onValueChange={handleValueChange}
                    onButtonClick={handleButtonClick}
                />
            </div>
        </section>
    );
};

export default DynamicMenuPanel;
