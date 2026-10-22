import { FunctionComponent, useState, useRef, useLayoutEffect } from "react";
import { usePreviewedLayerColors } from "@/hooks/useLayerColorPreview";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { useLayer } from "@/contexts/LayerContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { Key } from "@/components/Key";
import { getKeyContents } from "@/utils/keys";
import { hoverBackgroundClasses, hoverBorderClasses, hoverHeaderClasses } from "@/utils/colors";
import { KeyContent } from "@/types/keyboard.types";
import { LAYOUTS, BUTTON_TO_KEYCODE_MAP, KEY_DISPLAY_OVERRIDES, LAYOUT_KEY_MAPS, US_SHIFT_ALIASES } from "@/components/Keyboards/layouts";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { applyModifiers, Modifier, ModifierSide, PLAIN_MODIFIER_KEYCODES } from "@/utils/modifierUtils";
import { QWERTY_KEY_PX, TRAY_MIN_KEY_PX } from "@/lib/pickerShape";

interface IProps {
    onKeyPress?: (button: string) => void;
    activeModifiers?: string[];
    /** Hand used when activeModifiers are applied (RSFT(kc) vs LSFT(kc)). */
    modifierSide?: ModifierSide;
    hideLanguageSelector?: boolean;
    disableTooltip?: boolean;
    /** Scale the keyboard to fit both its width and this height, by scaleFor, centered (the L-shaped picker's tray). */
    fit?: { maxHeight: number; scaleFor: (availableWidth: number, availableHeight: number, naturalWidth: number, naturalHeight: number) => number };
}

const QwertyKeyboard: FunctionComponent<IProps> = ({ onKeyPress: onKeyPressCallback, activeModifiers = [], modifierSide = "left", hideLanguageSelector = false, disableTooltip = false, fit }) => {
    const [layoutName, setLayoutName] = useState<"default" | "shift">("default");
    const { internationalLayout, setInternationalLayout, layoutMode } = useLayoutSettings();
    const { keyboard } = useKeyboard();
    const { selectedLayer } = useLayer();
    const { isBinding } = useKeyBinding();

    const isCompact = layoutMode === "bottombar";

    const layerColorName = usePreviewedLayerColors(keyboard?.cosmetic?.layer_colors)?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];

    const hoverHeaderClass = hoverHeaderClasses[layerColorName] || hoverHeaderClasses["primary"];


    const currentLayout = LAYOUTS[internationalLayout] || LAYOUTS["us"];
    const layoutKeyMap = LAYOUT_KEY_MAPS[internationalLayout] || {};

    const isShiftActive = activeModifiers.includes("Shift") || layoutName === "shift";

    const onKeyPress = (button: string) => {
        if (!isBinding || !keyboard) return;
        if (button === "{shiftleft}" || button === "{shiftright}" || button === "{capslock}") {
            setLayoutName(layoutName === "default" ? "shift" : "default");
        }
        if (onKeyPressCallback) {
            onKeyPressCallback(button);
        }
    };

    // Helper to get key width
    const getKeyWidth = (key: string): number => {
        // Special case for ISO Shift (smaller) vs ANSI Shift
        if (key === "{shiftleft}" && currentLayout.value !== "us") return 1.25; // ISO Left Shift
        if (key === "{shiftleft}" && currentLayout.value === "us") return 2.25; // ANSI Left Shift

        switch (key) {
            case "{backspace}": return 2;
            case "{tab}": return 1.5;
            case "\\": return 1.5;
            case "|": return 1.5;
            case "{capslock}": return 1.75;
            case "{enter}": return 2.25;
            case "{shiftright}": return 2.75;
            case "{controlleft}": return 1.25;
            case "{altleft}": return 1.25;
            case "{metaleft}": return 1.25;
            case "{space}": return 6.25;
            case "{metaright}": return 1.25;
            case "{altright}": return 1.25;
            case "{controlright}": return 1.25;
            default: return 1;
        }
    };

    const fitRef = useRef<HTMLDivElement>(null);
    const [availableWidth, setAvailableWidth] = useState(0);
    useLayoutEffect(() => {
        const element = fitRef.current;
        if (!element) return;
        const measure = () => setAvailableWidth(element.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const naturalWidth = Math.max(...currentLayout.default.map(row => {
        const keys = row.split(" ");
        return keys.reduce((sum, key) => sum + getKeyWidth(key) * 30, 0) + (keys.length - 1) * 4;
    }));
    const naturalHeight = currentLayout.default.length * 30 + (currentLayout.default.length - 1) * 4;
    const scale = fit
        ? fit.scaleFor(availableWidth, fit.maxHeight, naturalWidth, naturalHeight)
        : availableWidth > 0 ? Math.max(TRAY_MIN_KEY_PX / QWERTY_KEY_PX, Math.min(1, availableWidth / naturalWidth)) : 1;

    const renderRow = (defaultRowStr: string, shiftRowStr: string) => {
        const defaultKeys = defaultRowStr.split(" ");
        const shiftKeys = shiftRowStr.split(" ");

        return (
            <div className="flex gap-1 justify-center">
                {defaultKeys.map((defaultKey, i) => {
                    const shiftKey = shiftKeys[i] || defaultKey;

                    // Visual key is determined by shift state
                    const visualKey = isShiftActive ? shiftKey : defaultKey;

                    // Output key: when activeModifiers are present, parent applies them to the base key.
                    // When Shift is active only via keyboard layout toggle, send the visual shifted key.
                    const outputKey = (activeModifiers.length === 0 && isShiftActive) ? visualKey : defaultKey;

                    // To get correct QMK keycode for display/icon lookup, we resolve the visual key
                    // key is "ç" or "a" or "{shift}"
                    const labelKey = visualKey;

                    let keycode = layoutKeyMap[labelKey] ||
                        layoutKeyMap[labelKey.toLowerCase()] ||
                        BUTTON_TO_KEYCODE_MAP[labelKey] ||
                        BUTTON_TO_KEYCODE_MAP[labelKey.toLowerCase()] ||
                        labelKey;


                    // Don't modify special structural keys
                    // const isStructureKey = keycode.startsWith("KC_") === false && !["{", "}"].some(c => keycode.includes(c));

                    // Actually check if it is a modifier key itself (e.g. KC_LSFT) or a structural key
                    // Simplified: if it's a regular keycode (starts with KC_ or is a character), apply modifiers
                    // But prevent modifying the modifiers themselves if mistakenly passed?
                    // Safe approach: apply activeModifiers if provided, but skip if keycode is weird.
                    // Actually, if we are DRAGGING, we want the modified keycode.
                    // If we are CLICKING, onKeyPress handles it (via BasicKeyboards callback which applies modifiers).
                    // So this change PRIMARILY affects the Key component's `keycode` prop, which determines drag payload.

                    // Exclude special UI keys from being modified
                    // const isSpecial = ["{shiftleft}", "{shiftright}", "{capslock}", "{space}"].includes(defaultKey);
                    // Note: {space} is KC_SPC, which CAN be modified.

                    // Apply modifiers to the keycode if valid
                    // We only modify if it looks like a basic keycode
                    if (activeModifiers.length > 0 &&
                        !["KC_TRNS", "KC_NO"].includes(keycode) &&
                        !PLAIN_MODIFIER_KEYCODES.has(keycode) &&
                        !keycode.includes("{") // Don't modify UI placeholders
                    ) {
                        // Check if keycode is a US Shift Alias (e.g. KC_EXLM -> KC_1)
                        // This prevents double-shifting (Shift + KC_EXLM) which causes issues
                        if (US_SHIFT_ALIASES[keycode]) {
                            keycode = US_SHIFT_ALIASES[keycode];
                        }

                        keycode = applyModifiers(keycode, activeModifiers as Modifier[], false, modifierSide);
                    }

                    const displayLabel = KEY_DISPLAY_OVERRIDES[visualKey] || visualKey.replace("{", "").replace("}", "");
                    const width = getKeyWidth(defaultKey); // Use default key for width lookup to be consistent
                    const keyContents = keyboard ? getKeyContents(keyboard, keycode) : undefined;


                    return (
                        <Key
                            key={`${defaultKey}-${i}`}
                            data-picker-key={defaultKey}
                            x={0} y={0} w={width} h={1} row={0} col={0}
                            keycode={keycode}
                            label={displayLabel}
                            keyContents={keyContents as KeyContent | undefined}
                            layerColor="sidebar"
                            headerClassName={`bg-kb-sidebar-dark ${hoverHeaderClass}`}
                            isRelative
                            variant="small"
                            hoverBorderColor={hoverBorderColor}
                            hoverBackgroundColor={hoverBackgroundColor}
                            hoverLayerColor={layerColorName}
                            onClick={() => onKeyPress(outputKey)}
                            disableTooltip={disableTooltip}
                            forceLabel={true}
                            dragW={1}
                            dragH={1}
                        />
                    );
                })}
            </div>
        );
    };

    return (
        <div className="flex flex-col gap-1 w-full min-w-0">
            {/* Language selector - hidden when hideLanguageSelector is true */}
            {!hideLanguageSelector && (
                isCompact ? (
                    <div className="flex flex-row items-center justify-end -mb-1">
                        <select
                            className="border rounded text-[10px] text-slate-500 dark:text-neutral-400 py-0.5 px-1 border-gray-200 dark:border-neutral-500 bg-gray-50 dark:bg-neutral-800/60 !outline-none focus:border-gray-300 dark:focus:border-neutral-400 cursor-pointer"
                            value={internationalLayout}
                            onChange={(e) => setInternationalLayout(e.target.value)}
                            title="Keyboard layout"
                        >
                            {Object.values(LAYOUTS).map((kb) => (
                                <option key={kb.value} value={kb.value}>
                                    {kb.value.toUpperCase()}
                                </option>
                            ))}
                        </select>
                    </div>
                ) : (
                    <div className="flex flex-row items-center gap-2">
                        <select
                            className="border rounded-md text-lg text-slate-600 dark:text-neutral-300 py-4 border-none !outline-none focus:border-none focus:outline-none cursor-pointer font-semibold"
                            value={internationalLayout}
                            onChange={(e) => setInternationalLayout(e.target.value)}
                        >
                            {Object.values(LAYOUTS).map((kb) => (
                                <option key={kb.value} value={kb.value}>
                                    {kb.label}
                                </option>
                            ))}
                        </select>
                    </div>
                )
            )}

            <div ref={fitRef} className="w-full min-w-0 overflow-hidden" data-fitted-keyboard style={{ height: naturalHeight * scale }}>
                {/* Zoom, not a transform: the keyboard's laid-out width is its scaled width, so it never makes its box scroll sideways. */}
                <div className="flex flex-col gap-1" style={{ width: naturalWidth, zoom: scale, marginLeft: fit ? Math.max(0, (availableWidth - naturalWidth * scale) / 2) / scale : undefined }}>
                    {currentLayout.default.map((row, i) => (
                        <div key={i}>{renderRow(row, currentLayout.shift[i])}</div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default QwertyKeyboard;
