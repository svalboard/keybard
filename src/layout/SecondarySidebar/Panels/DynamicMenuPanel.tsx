import { selectPointingMenu, type PointingMenuSection } from "@/utils/pointing-menu";
import { withEffectiveTiming } from "@/utils/scan-timing";
import { useCallback, useMemo } from "react";
import { CustomUIRenderer } from "@/components/CustomUI";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { useMenuValues } from "@/hooks/useMenuValues";
import { openTouchpadTuning } from "@/components/touchpad-tuning/tuning-open";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { boardHasTouchpad, PAD_KEYS, PADS_OS_KEY, padsInTouchpadMode } from "@/utils/touchpad-taps";
import { PAD_MODE_KEY } from "@/utils/touchpad-tuning";
import { useTouchpadModeChange } from "@/components/touchpad-tuning/TouchpadMode";
import { keyboardService } from "@/services/keyboard.service";
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
    const { values, setValue, loading, error } = useMenuValues(menu);
    const { setKeyboard } = useKeyboard();
    // Touchpad mode (VIA 59): to built-in gestures only after the check; then
    // POINTING_HARDWARE again, whose touchpad-mode bit follows it at once.
    const writeMode = useCallback(async (mode: number) => {
        await setValue(PAD_MODE_KEY, mode, { now: true }); // at once, never a pending change
        if (!keyboard) return;
        const next = { ...keyboard };
        await keyboardService.getPointingHardware(next);
        setKeyboard((prev) => (prev ? { ...prev, pointing_hardware: next.pointing_hardware } : prev));
    }, [setValue, keyboard, setKeyboard]);
    const modeChange = useTouchpadModeChange(writeMode);
    const handleValueChange = useCallback(async (key: string, value: number) => {
        if (key === PAD_MODE_KEY) { modeChange.change(value, values.get(PAD_MODE_KEY) ?? 0); return; }
        await setValue(key, value);
    }, [modeChange, setValue, values]);
    // Touchpad mode at connect: the chip's tap switches are hidden (touchpad-taps.ts PADS_OS_KEY).
    const padsOs = padsInTouchpadMode(keyboard);
    const shownValues = useMemo(() => {
        // Always set, so the switches show on a board that reports nothing.
        const out = new Map(withEffectiveTiming(values));
        out.set(PADS_OS_KEY, padsOs ? 1 : 0);
        return out;
    }, [values, padsOs]);

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
                {modeChange.confirm}
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
                {modeChange.confirm}
            </div>
        </section>
    );
};

export default DynamicMenuPanel;
