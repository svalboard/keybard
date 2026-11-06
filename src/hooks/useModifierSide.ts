import { useEffect, useState } from "react";

import { MATRIX_COLS } from "@/constants/svalboard-layout";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { keyService } from "@/services/key.service";
import { KeyboardInfo } from "@/types/keyboard.types";
import { getKeycodeModifierSide, ModifierSide } from "@/utils/modifierUtils";

type SelectedTarget = ReturnType<typeof useKeyBinding>["selectedTarget"];

/** Numeric keycode of the key being edited across keymap and binding editors, or undefined when none is selected. */
export const getSelectedKeymapKeycode = (
    keyboard: KeyboardInfo | null | undefined,
    selectedTarget: SelectedTarget,
): number | undefined => {
    if (!keyboard || !selectedTarget) return undefined;

    switch (selectedTarget.type) {
        case "keyboard": {
            if (!keyboard.keymap) return undefined;
            const { layer, row, col } = selectedTarget;
            if (layer === undefined || row === undefined || col === undefined) return undefined;
            const matrixCols = keyboard.cols || MATRIX_COLS;
            return keyboard.keymap[layer]?.[row * matrixCols + col];
        }
        case "combo": {
            const { comboId, comboSlot } = selectedTarget;
            if (comboId === undefined || comboSlot === undefined) return undefined;
            const combo = keyboard.combos?.[comboId];
            if (!combo) return undefined;
            const keyStr = comboSlot === 4 ? combo.output : combo.keys?.[comboSlot];
            if (!keyStr || keyStr === "KC_NO") return 0;
            const parsed = typeof keyStr === "number" ? keyStr : keyService.parse(keyStr);
            return Number.isNaN(parsed) ? undefined : parsed;
        }
        case "tapdance": {
            const { tapdanceId, tapdanceSlot } = selectedTarget;
            if (tapdanceId === undefined || !tapdanceSlot) return undefined;
            const td = keyboard.tapdances?.[tapdanceId];
            if (!td) return undefined;
            const keyStr = td[tapdanceSlot];
            if (!keyStr || keyStr === "KC_NO") return 0;
            const parsed = typeof keyStr === "number" ? keyStr : keyService.parse(keyStr);
            return Number.isNaN(parsed) ? undefined : parsed;
        }
        case "override": {
            const { overrideId, overrideSlot } = selectedTarget;
            if (overrideId === undefined || !overrideSlot) return undefined;
            const ko = keyboard.key_overrides?.[overrideId];
            if (!ko) return undefined;
            const keyStr = ko[overrideSlot];
            if (!keyStr || keyStr === "KC_NO") return 0;
            const parsed = typeof keyStr === "number" ? keyStr : keyService.parse(keyStr);
            return Number.isNaN(parsed) ? undefined : parsed;
        }
        case "altrepeat": {
            const { altRepeatId, altRepeatSlot } = selectedTarget;
            if (altRepeatId === undefined || !altRepeatSlot) return undefined;
            const ark = keyboard.alt_repeat_keys?.[altRepeatId];
            if (!ark) return undefined;
            const keyStr = ark[altRepeatSlot];
            if (!keyStr || keyStr === "KC_NO") return 0;
            const parsed = typeof keyStr === "number" ? keyStr : keyService.parse(keyStr);
            return Number.isNaN(parsed) ? undefined : parsed;
        }
        case "leaders": {
            const { leaderId, leaderSlot, leaderSeqIndex } = selectedTarget;
            if (leaderId === undefined || !leaderSlot) return undefined;
            const ldr = keyboard.leaders?.[leaderId];
            if (!ldr) return undefined;
            const keyStr = leaderSlot === "output" ? ldr.output : (leaderSlot === "sequence" && leaderSeqIndex !== undefined ? ldr.sequence?.[leaderSeqIndex] : undefined);
            if (!keyStr || keyStr === "KC_NO") return 0;
            const parsed = typeof keyStr === "number" ? keyStr : keyService.parse(keyStr);
            return Number.isNaN(parsed) ? undefined : parsed;
        }
        case "macro": {
            const { macroId, macroIndex } = selectedTarget;
            if (macroId === undefined || macroIndex === undefined) return undefined;
            const act = keyboard.macros?.[macroId]?.actions?.[macroIndex];
            if (!act || !["tap", "down", "up"].includes(act[0])) return undefined;
            const keyStr = act[1];
            if (!keyStr || keyStr === "KC_NO") return 0;
            const parsed = typeof keyStr === "number" ? keyStr : keyService.parse(keyStr);
            return Number.isNaN(parsed) ? undefined : parsed;
        }
        default:
            return undefined;
    }
};

/**
 * Left/Right state for the modifier pickers. It follows the key being edited:
 * selecting a key that already holds a right-hand modifier (KC_RSFT, RCTL(kc),
 * RSFT_T(kc), OSM(MOD_RALT)...) flips it to "right", a left-hand one flips it
 * back to "left". Keys with no modifier leave the user's choice alone.
 */
export const useModifierSide = (): [ModifierSide, (side: ModifierSide) => void] => {
    const { selectedTarget } = useKeyBinding();
    const { keyboard } = useKeyboard();
    const [side, setSide] = useState<ModifierSide>("left");

    const selectedKeycode = getSelectedKeymapKeycode(keyboard, selectedTarget);
    const selectedSide = getKeycodeModifierSide(selectedKeycode);

    useEffect(() => {
        if (selectedSide) setSide(selectedSide);
    }, [selectedSide, selectedTarget]);

    return [side, setSide];
};
