import type { KeyContent } from "@/types/keyboard.types";
import { KEYALIASES } from "@/constants/keygen";
import { getLabelForKeycode, US_SHIFT_ALIASES } from "@/components/Keyboards/layouts";

/**
 * Resolves the primary label for a keycode respecting the current layout.
 */
export function getKeyDisplayLabel(
    keycode: string | undefined,
    keyContents: KeyContent | undefined,
    layoutId: string = "us"
): string {
    if (!keycode || keycode === "KC_NO" || keycode === "KC_TRNS") return "";
    const layoutLabel = getLabelForKeycode(keycode, layoutId);
    if (layoutLabel) return layoutLabel;
    if (keyContents?.str) {
        const parts = keyContents.str.split("\n");
        return parts[parts.length - 1] || parts[0] || "";
    }
    return keycode;
}

export function getKeyDisplayText(
    keycode: string,
    label: string,
    keyContents: KeyContent | undefined,
    forceLabel: boolean,
    layoutId: string
) {
    let displayLabel = label || getKeyDisplayLabel(keycode, keyContents, layoutId);
    let bottomStr = "";
    let topLabel = "";

    if (keyContents?.type === "modmask") {
        // Modifier+key combo (e.g., LGUI(TAB))
        const keysArr = keyContents.str?.split("\n") || [];
        let keyStr = keysArr[0] || "";

        // Handle "Mouse\n1" case where split gives keysArr=["Mouse", "1"]
        // We want keyStr to be "Mouse 1" so getCenterContent can parse it correctly
        if (keyStr === "Mouse" && keysArr[1]) {
            keyStr = `Mouse ${keysArr[1]}`;
        }

        // Show the key in center (blank if no base key)
        displayLabel = (keyStr === "" || keyStr === "KC_NO") ? "" : keyStr;

        // Auto-fix for KC_BTN codes that didn't resolve to "Mouse X" strings
        const btnMatch = displayLabel.match(/KC_BTN(\d+)/);
        if (btnMatch) {
            displayLabel = `Mouse ${btnMatch[1]}`;
        }


        // Show modifier on bottom (e.g., "LGUI" from "LGUI(TAB)")
        const modMatch = keycode.match(/^([A-Z_]+)\(/);
        bottomStr = modMatch ? modMatch[1] : (keyContents.top || "MOD");

        // Standalone mod (KC_NO) should render in center, not footer
        if (keyStr === "" || keyStr === "KC_NO") {
            displayLabel = bottomStr;
            bottomStr = "";
        } else {
            const baseKeycodeMatch = keycode.match(/\((.*)\)$/);
            let baseKeycode = baseKeycodeMatch ? baseKeycodeMatch[1] : null;
            if (baseKeycode && baseKeycode in KEYALIASES) {
                baseKeycode = String(KEYALIASES[baseKeycode]);
            }
            if (baseKeycode && baseKeycode in US_SHIFT_ALIASES) {
                baseKeycode = US_SHIFT_ALIASES[baseKeycode];
            }
            const wrapper = modMatch ? modMatch[1] : "";
            const hasShiftWrapper = wrapper.includes("S") || wrapper === "MEH" || wrapper === "HYPR" || wrapper === "ALL_T";
            const hasShiftMod = (typeof keyContents.modids === "number" && (keyContents.modids & 0x0200) !== 0) || hasShiftWrapper;
            if (hasShiftMod && baseKeycode) {
                const shiftedLabel = getLabelForKeycode(`LSFT(${baseKeycode})`, layoutId);
                if (shiftedLabel) displayLabel = shiftedLabel;
            }
        }



        // Smart Override for International Keys
        if (shouldOverrideForInternational(label, keyStr, displayLabel, bottomStr)) {
            displayLabel = label;
            bottomStr = "";
        }

        // Clean Shifted Characters
        if (shouldHideShiftBadge(displayLabel, bottomStr, keycode)) {
            bottomStr = "";
        }

    } else if (keyContents?.type === "modtap") {
        // Modifier-tap key (e.g., LGUI_T(KC_TAB))
        const keysArr = keyContents.str?.split("\n") || [];
        let keyStr = keysArr[0] || "";

        // Handle "Mouse\n1" case
        if (keyStr === "Mouse" && keysArr[1]) {
            keyStr = `Mouse ${keysArr[1]}`;
        }

        displayLabel = (keyStr === "" || keyStr === "KC_NO") ? "" : keyStr;

        // Auto-fix for KC_BTN codes
        const btnMatch = displayLabel.match(/KC_BTN(\d+)/);
        if (btnMatch) {
            displayLabel = `Mouse ${btnMatch[1]}`;
        }

        // Extract modifier prefix from keycode
        const modMatch = keycode.match(/^(\w+_T)\(/);
        topLabel = keyContents.top || (modMatch ? modMatch[1] : "MOD_T");

        const baseKeycodeMatch = keycode.match(/\((.*)\)$/);
        let baseKeycode = baseKeycodeMatch ? baseKeycodeMatch[1] : null;
        if (baseKeycode && baseKeycode in KEYALIASES) {
            baseKeycode = String(KEYALIASES[baseKeycode]);
        }
        if (baseKeycode && baseKeycode in US_SHIFT_ALIASES) {
            baseKeycode = US_SHIFT_ALIASES[baseKeycode];
        }
        const wrapper = modMatch ? modMatch[1] : "";
        const hasShiftWrapper = wrapper.includes("S") || wrapper === "MEH_T" || wrapper === "HYPR_T" || wrapper === "ALL_T";
        const hasShiftMod = (typeof keyContents.modids === "number" && (keyContents.modids & 0x0200) !== 0) || hasShiftWrapper;
        if (hasShiftMod && baseKeycode) {
            const shiftedLabel = getLabelForKeycode(`LSFT(${baseKeycode})`, layoutId);
            if (shiftedLabel) displayLabel = shiftedLabel;
        }

    } else if (keyContents?.type === "layerhold") {
        // Layer-tap key (e.g., LT1(KC_ENTER))
        const ltMatch = keycode.match(/^LT(\d+)/);
        topLabel = ltMatch ? `LT${ltMatch[1]}` : "LT";

        const keysArr = keyContents.str?.split("\n") || [];
        let keyStr = keysArr[0] || "";

        // Handle "Mouse\n1" case
        if (keyStr === "Mouse" && keysArr[1]) {
            keyStr = `Mouse ${keysArr[1]}`;
        }

        displayLabel = keyStr;

        // Auto-fix for KC_BTN codes
        const btnMatch = displayLabel.match(/KC_BTN(\d+)/);
        if (btnMatch) {
            displayLabel = `Mouse ${btnMatch[1]}`;
        }

        if (displayLabel === "KC_NO") displayLabel = "";

    } else if (keyContents?.type === "tapdance") {
        displayLabel = keyContents.tdid?.toString() || "";
    } else if (keyContents?.type === "macro") {
        displayLabel = keyContents.top?.replace("M", "") || "";
    } else if (keyContents?.type === "user") {
        displayLabel = keyContents.str || "";
    } else if (keyContents?.type === "OSM") {
        topLabel = "OSM";
        displayLabel = keyContents.str || "";
    }

    // If forceLabel is true, use the provided label instead of the derived one
    if (forceLabel) {
        displayLabel = label;
    }

    if (displayLabel === "KC_NO" || displayLabel.toLowerCase() === "0x0000" || displayLabel.toLowerCase() === "0xnan") displayLabel = "";

    return { displayLabel, bottomStr, topLabel };
}

function shouldOverrideForInternational(label: string, keyStr: string, displayLabel: string, bottomStr: string) {
    // Smart Override for International Keys (e.g. UK Shift+3 = £)
    // Use case-insensitive check so 'q' doesn't override 'Q'
    return (
        label &&
        label.toUpperCase() !== keyStr.toUpperCase() &&
        label !== "KC_NO" &&
        label !== "KC_TRNS" &&
        displayLabel !== "" &&
        displayLabel.length === 1 &&
        (bottomStr === "LSFT" || bottomStr === "RSFT")
    );
}

function shouldHideShiftBadge(displayLabel: string, bottomStr: string, keycode: string) {
    // Clean Shifted Characters: If just Shift modifier and single char label that is likely a symbol (not a letter), hide the badge
    // EXCLUDE Numpad keys
    // Note: bottomStr can be "LSFT", "RSFT", "LSft", "RSft" depending on source
    const normalizedBottomStr = bottomStr.toUpperCase();
    return (
        (normalizedBottomStr === "LSFT" || normalizedBottomStr === "RSFT") &&
        displayLabel.length === 1 &&
        !/[a-zA-Z]/.test(displayLabel) &&
        !keycode.includes("KC_P") && !keycode.includes("KC_KP")
    );
}
