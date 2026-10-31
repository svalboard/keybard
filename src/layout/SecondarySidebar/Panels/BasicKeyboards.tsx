import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import QwertyKeyboard from "@/components/Keyboards/QwertyKeyboard";
import { Button } from "@/components/ui/button";
import { useKeyBinding } from "@/contexts/KeyBindingContext";
import { useLayer } from "@/contexts/LayerContext";
import { useLayoutSettings } from "@/contexts/LayoutSettingsContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { hoverBackgroundClasses, hoverBorderClasses, hoverHeaderClasses } from "@/utils/colors";
import { cn } from "@/lib/utils";
import { KeyboardInfo, KeyContent } from "@/types/keyboard.types";
import { Key } from "@/components/Key";
import { getKeyContents } from "@/utils/keys";
import { keyService } from "@/services/key.service";
import { CODEMAP } from "@/constants/keygen";
import ModifierSideToggle from "@/components/ModifierSideToggle";
import { getSelectedKeymapKeycode, useModifierSide } from "@/hooks/useModifierSide";
import { usePickerTray } from "@/contexts/PickerTrayContext";
import { trayKeyboardScale } from "@/lib/pickerShape";
import { NUMPAD_COLUMNS, NUMPAD_GAP_PX, NUMPAD_VARIANT_PX, numpadCellSize, numpadVariantFor } from "@/lib/numpadFit";

import { BUTTON_TO_KEYCODE_MAP, LAYOUTS } from "@/components/Keyboards/layouts";

const getKeyCodeForButton = (keyboard: KeyboardInfo, button: string): string | undefined => {
    const k = BUTTON_TO_KEYCODE_MAP[button] || BUTTON_TO_KEYCODE_MAP[button.toLowerCase()];
    if (k) return k;
    const customKeycode = keyboard.custom_keycodes?.findIndex((ck) => ck.name === button);
    if (customKeycode === undefined || customKeycode < 0) return button;
    return `USER${customKeycode?.toString().padStart(2, "0")}`;
};

import {
    Modifier,
    modifierOptions,
    decomposeKeycode,
    getOsmKeycode,
    applyModifiers,
    PLAIN_MODIFIER_KEYCODES
} from "@/utils/modifierUtils";

interface Props {
    isPicker?: boolean;
    /**
     * With the L-shaped picker, this copy is the one on screen and puts its
     * keyboard in the tray under the layout; the small pickers stay here.
     */
    trayPortal?: boolean;
}

const BasicKeyboards = ({ isPicker, trayPortal = false }: Props) => {
    const [activeModifiers, setActiveModifiers] = useState<Modifier[]>([]);
    const [modifierSide, setModifierSide] = useModifierSide();
    const { assignKeycode, isBinding, selectedTarget } = useKeyBinding();
    const { keyboard } = useKeyboard();
    const { selectedLayer } = useLayer();
    const { keyVariant, layoutMode, internationalLayout, setInternationalLayout } = useLayoutSettings();

    const isHorizontal = layoutMode === "bottombar";
    const tray = usePickerTray();
    const inTray = trayPortal && !isHorizontal && !!tray.body && !!tray.header;



    const layerColorName = keyboard?.cosmetic?.layer_colors?.[selectedLayer] || "primary";
    const hoverBorderColor = hoverBorderClasses[layerColorName] || hoverBorderClasses["primary"];
    const hoverBackgroundColor = hoverBackgroundClasses[layerColorName] || hoverBackgroundClasses["primary"];
    const hoverHeaderClass = hoverHeaderClasses[layerColorName] || hoverHeaderClasses["primary"];

    // Compute the base keycode (inner key stripped of modifiers) from the selected key
    const getBaseKeycode = (): string => {
        const numericKeycode = getSelectedKeymapKeycode(keyboard, selectedTarget);
        if (numericKeycode === undefined) return "KC_NO";

        const decomposed = decomposeKeycode(numericKeycode);
        if (decomposed) return decomposed.baseKeycode;

        // Layer-tap (QK_LAYER_TAP: 0x4000-0x4FFF): extract inner 8-bit keycode
        const baseCode = (numericKeycode >= 0x4000 && numericKeycode <= 0x4FFF)
            ? (numericKeycode & 0x00FF)
            : numericKeycode;

        // Not a modifier key — use the keycode string directly
        const str = baseCode in CODEMAP ? (CODEMAP[baseCode] as string) : null;
        return str || "KC_NO";
    };

    const baseKeycode = getBaseKeycode();
    const hasModifiers = activeModifiers.length > 0;

    // Three constructed keycodes: plain modifier, mod-tap, one-shot
    const modifierKeycode = hasModifiers ? applyModifiers(baseKeycode, activeModifiers, false, modifierSide) : baseKeycode;
    const modifierContents = keyboard ? getKeyContents(keyboard, modifierKeycode) : undefined;

    const standaloneModifierKeycode = hasModifiers ? applyModifiers("KC_NO", activeModifiers, false, modifierSide) : "KC_NO";
    const standaloneModifierLabel = hasModifiers
        ? standaloneModifierKeycode.replace(/\(.*\)$/, "")
        : "MOD";

    const modTapKeycode = hasModifiers ? applyModifiers(baseKeycode, activeModifiers, true, modifierSide) : null;
    const modTapContents = modTapKeycode && keyboard ? getKeyContents(keyboard, modTapKeycode) : undefined;

    const osmKeycode = getOsmKeycode(activeModifiers, modifierSide);
    const osmContents = osmKeycode && keyboard ? getKeyContents(keyboard, osmKeycode) : undefined;

    const handleClearModifiers = () => {
        setActiveModifiers([]);
    };

    const handleModifierToggle = (modifier: Modifier) => {
        setActiveModifiers((prev) => {
            const next = prev.includes(modifier)
                ? prev.filter((item) => item !== modifier)
                : [...prev, modifier];

            return next;
        });
    };

    const handleKeyClick = (keycode: string) => {
        if (!isBinding || !keyboard) return;

        // Ensure we translate names like 'SV_...' to actual keycodes if needed
        const mappedKeycode = getKeyCodeForButton(keyboard, keycode) || keycode;
        // Blank, Transparent and plain modifier keys are never modified
        const isBlank = keycode === "KC_NO" || keycode === "KC_TRNS" || PLAIN_MODIFIER_KEYCODES.has(mappedKeycode);
        const finalKeycode = isBlank ? mappedKeycode : applyModifiers(mappedKeycode, activeModifiers, false, modifierSide);
        assignKeycode(finalKeycode);

    };

    const handleKeyboardInput = (button: string) => {
        if (!isBinding || !keyboard) return;
        handleKeyClick(button);
    };

    const numpadKeys = [
        { keycode: "KC_PSCR", label: "PrtSc" }, { keycode: "KC_SLCK", label: "ScrLk" }, { keycode: "KC_PAUS", label: "Pause" },
        { keycode: "KC_NLCK", label: "NumLk" }, { keycode: "KC_PEQL", label: "=" }, { keycode: "KC_KP_SLASH", label: "/" }, { keycode: "KC_KP_ASTERISK", label: "*" },

        { keycode: "KC_INS", label: "Ins" }, { keycode: "KC_HOME", label: "Home" }, { keycode: "KC_PGUP", label: "PgUp" },
        { keycode: "KC_KP_7", label: "7" }, { keycode: "KC_KP_8", label: "8" }, { keycode: "KC_KP_9", label: "9" }, { keycode: "KC_KP_MINUS", label: "-" },

        { keycode: "KC_DEL", label: "Del" }, { keycode: "KC_END", label: "End" }, { keycode: "KC_PGDN", label: "PgDn" },
        { keycode: "KC_KP_4", label: "4" }, { keycode: "KC_KP_5", label: "5" }, { keycode: "KC_KP_6", label: "6" }, { keycode: "KC_KP_PLUS", label: "+" },

        { keycode: "BLANK", label: "" }, { keycode: "KC_UP", label: "Up" }, { keycode: "BLANK", label: "" },
        { keycode: "KC_KP_1", label: "1" }, { keycode: "KC_KP_2", label: "2" }, { keycode: "KC_KP_3", label: "3" }, { keycode: "KC_KP_ENTER", label: "Enter" },

        { keycode: "KC_LEFT", label: "Left" }, { keycode: "KC_DOWN", label: "Down" }, { keycode: "KC_RGHT", label: "Right" },
        { keycode: "KC_KP_0", label: "0" }, { keycode: "KC_KP_DOT", label: "." },
    ];


    const blankKeys = [
        { keycode: "KC_NO", label: "" },
        { keycode: "KC_TRNS", label: "▽" },
    ];

    // F1-F24 function keys
    const functionKeys = Array.from({ length: 24 }, (_, i) => ({
        keycode: `KC_F${i + 1}`,
        label: `F${i + 1}`
    }));

    // The numpad takes the canvas key size when its column has room and
    // shrinks to the column otherwise, so it never scrolls sideways.
    const numpadKeySize = NUMPAD_VARIANT_PX[keyVariant];
    // A callback ref: the numpad's column can mount after this panel does.
    const [numpadBox, numpadBoxRef] = useState<HTMLDivElement | null>(null);
    const [numpadWidth, setNumpadWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
        if (!numpadBox) return;
        const measure = () => setNumpadWidth(numpadBox.clientWidth);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(numpadBox);
        return () => observer.disconnect();
    }, [numpadBox]);
    const numpadCell = numpadCellSize(numpadWidth, numpadKeySize);
    const numpadVariant = numpadVariantFor(numpadCell, keyVariant);

    const renderKeyGrid = (keys: { keycode: string, label: string, useServiceLabel?: boolean }[], gridColSize?: number, variantOverride?: "small" | "medium" | "default") => {
        const effectiveVariant = variantOverride || keyVariant;
        // A sized grid sets each cell from its column size; otherwise the variant's own size.
        const keySizeClass = gridColSize ? "" : effectiveVariant === 'small' ? 'h-[30px] w-[30px]' : effectiveVariant === 'medium' ? 'h-[45px] w-[45px]' : 'h-[60px] w-[60px]';
        const cellStyle = gridColSize ? { width: gridColSize, height: gridColSize } : undefined;

        const gridStyle = gridColSize ? {
            display: 'grid',
            gridTemplateColumns: `repeat(${NUMPAD_COLUMNS}, ${gridColSize}px)`,
            gap: `${NUMPAD_GAP_PX}px`
        } : undefined;

        return (
            <div className={cn(!gridColSize && "flex flex-wrap gap-1")} style={gridStyle}>
                {keys.map((k, i) => {
                    if (k.keycode === "BLANK") {
                        return <div key={`blank-${i}`} className={keySizeClass} style={cellStyle} />;
                    }

                    const finalKeycode = (k.keycode === "BLANK" || k.keycode === "KC_NO" || k.keycode === "KC_TRNS")
                        ? k.keycode
                        : applyModifiers(k.keycode, activeModifiers, false, modifierSide);

                    const keyContents = keyboard ? getKeyContents(keyboard, finalKeycode) : undefined;
                    // Use custom label for numpad keys, otherwise fall back to keyService
                    const displayLabel = k.useServiceLabel ? (keyService.define(k.keycode)?.str || k.label || k.keycode) : (k.label || k.keycode);
                    const isDoubleHeight = k.keycode === "KC_KP_ENTER";




                    return (
                        <Key
                            key={`${k.keycode}-${i}`}
                            x={0} y={0} w={1} h={1} row={0} col={0}
                            keycode={finalKeycode}
                            label={displayLabel}
                            keyContents={keyContents as KeyContent | undefined}
                            layerColor="sidebar"
                            headerClassName={`bg-kb-sidebar-dark ${hoverHeaderClass}`}
                            isRelative
                            variant={effectiveVariant}
                            className={cn(
                                keySizeClass,
                                isDoubleHeight ? "row-span-2" : ""
                            )}
                            style={cellStyle}
                            hoverBorderColor={hoverBorderColor}
                            hoverBackgroundColor={hoverBackgroundColor}
                            hoverLayerColor={layerColorName}
                            onClick={() => handleKeyClick(k.keycode)}
                            disableTooltip={true}
                        />
                    );
                })}
            </div>
        );
    };

    // Compact horizontal layout for bottom panel
    if (isHorizontal) {
        return (
            <div className="flex min-w-0 flex-row flex-wrap gap-4 items-start content-start">
                {/* Left column: Language selector + Modifiers */}
                <div className="flex min-w-0 max-w-full flex-col gap-1">
                    {/* Language selector at top */}
                    <select
                        className="border rounded text-[10px] text-slate-600 dark:text-neutral-300 py-0.5 px-1 border-gray-200 dark:border-neutral-500 bg-gray-50 dark:bg-neutral-800/60 !outline-none focus:border-gray-300 dark:focus:border-neutral-400 cursor-pointer w-full mb-1"
                        value={internationalLayout}
                        onChange={(e) => setInternationalLayout(e.target.value)}
                        title="Keyboard layout"
                    >
                        {Object.values(LAYOUTS).map((kb: any) => (
                            <option key={kb.value} value={kb.value}>
                                {kb.value.toUpperCase()}
                            </option>
                        ))}
                    </select>

                    {/* Modifiers section */}
                    <div className="flex items-center justify-between gap-1">
                        <span className="text-[9px] font-bold text-slate-500 dark:text-neutral-400 uppercase">Modifiers</span>
                        <ModifierSideToggle side={modifierSide} onChange={setModifierSide} compact />
                    </div>
                    <Button
                        type="button"
                        variant={activeModifiers.length === 0 ? "default" : "secondary"}
                        size="sm"
                        className={cn(
                            "rounded-md px-2 py-0.5 h-6 transition-all text-[10px] font-medium border-none w-full",
                            activeModifiers.length === 0 ? "bg-kb-active text-kb-active-fg shadow-sm" : "bg-kb-gray-medium text-slate-700 dark:text-neutral-200 hover:bg-kb-surface dark:hover:bg-neutral-700"
                        )}
                        onClick={handleClearModifiers}
                        title="Clear modifiers"
                    >
                        None
                    </Button>

                    {/* Modifier choices stay in a compact row. */}
                    <div className="grid grid-cols-4 gap-1">
                        {modifierOptions.map((modifier) => {
                            const isActive = activeModifiers.includes(modifier);
                            return (
                                <Button
                                    key={modifier}
                                    type="button"
                                    variant={isActive ? "default" : "secondary"}
                                    size="sm"
                                    className={cn(
                                        "rounded-md px-0.5 py-0.5 h-6 transition-all text-[11px] font-medium border-none",
                                        isActive ? "bg-kb-active text-kb-active-fg shadow-sm" : "bg-kb-gray-medium text-slate-700 dark:text-neutral-200 hover:bg-kb-surface dark:hover:bg-neutral-700"
                                    )}
                                    onClick={() => handleModifierToggle(modifier)}
                                    title={modifier}
                                >
                                    {modifier.toUpperCase()}
                                </Button>
                            );
                        })}
                    </div>

                    {/* Four constructed keys: Standalone Modifier, Modifier, Mod-Tap, One-Shot */}
                    <div className="border-t border-gray-200 dark:border-neutral-700 pt-1 mt-1 grid grid-rows-[auto_auto] grid-flow-col gap-1">
                        <span className="text-[10px] font-bold text-slate-400 dark:text-neutral-400 uppercase">Standalone</span>
                        <div className={cn(!hasModifiers && "opacity-30 pointer-events-none")}>
                            <Key
                                x={0} y={0} w={1} h={1} row={0} col={0}
                                keycode={standaloneModifierKeycode}
                                label={standaloneModifierLabel}
                                keyContents={undefined}
                                forceLabel={true}
                                layerColor={hasModifiers ? layerColorName : "sidebar"}
                                headerClassName={hasModifiers ? `bg-kb-sidebar-dark ${hoverHeaderClass}` : "bg-kb-sidebar-dark"}
                                isRelative variant="small" className="h-[30px] w-full"
                                onClick={hasModifiers ? () => assignKeycode(standaloneModifierKeycode) : undefined}
                                hoverBorderColor={hasModifiers ? hoverBorderColor : undefined}
                                hoverBackgroundColor={hasModifiers ? hoverBackgroundColor : undefined}
                                hoverLayerColor={hasModifiers ? layerColorName : undefined}
                                dragItemData={{ forceAssign: true, keycode: standaloneModifierKeycode }}
                                disableHover={!hasModifiers}
                                disableTooltip={true}
                            />
                        </div>
                        <span className="text-[10px] font-bold text-slate-400 dark:text-neutral-400 uppercase">Modifier</span>
                        <div className={cn(!hasModifiers && "opacity-30 pointer-events-none")}>
                            <Key
                                x={0} y={0} w={1} h={1} row={0} col={0}
                                keycode={modifierKeycode}
                                label={modifierContents?.str || modifierKeycode}
                                keyContents={modifierContents as KeyContent | undefined}
                                layerColor={hasModifiers ? layerColorName : "sidebar"}
                                headerClassName={hasModifiers ? `bg-kb-sidebar-dark ${hoverHeaderClass}` : "bg-kb-sidebar-dark"}
                                isRelative variant="small" className="h-[30px] w-full"
                                onClick={hasModifiers ? () => assignKeycode(modifierKeycode) : undefined}
                                hoverBorderColor={hasModifiers ? hoverBorderColor : undefined}
                                hoverBackgroundColor={hasModifiers ? hoverBackgroundColor : undefined}
                                hoverLayerColor={hasModifiers ? layerColorName : undefined}
                                disableHover={!hasModifiers}
                                disableTooltip={true}
                            />
                        </div>
                        <span className="text-[10px] font-bold text-slate-400 dark:text-neutral-400 uppercase">Mod-Tap</span>
                        <div className={cn(!hasModifiers && "opacity-30 pointer-events-none")}>
                            <Key
                                x={0} y={0} w={1} h={1} row={0} col={0}
                                keycode={modTapKeycode || "KC_NO"}
                                label={modTapContents?.str || modTapKeycode || ""}
                                keyContents={modTapContents as KeyContent | undefined}
                                layerColor={hasModifiers ? layerColorName : "sidebar"}
                                headerClassName={hasModifiers ? `bg-kb-sidebar-dark ${hoverHeaderClass}` : "bg-kb-sidebar-dark"}
                                isRelative variant="small" className="h-[30px] w-full"
                                onClick={modTapKeycode ? () => assignKeycode(modTapKeycode) : undefined}
                                hoverBorderColor={hasModifiers ? hoverBorderColor : undefined}
                                hoverBackgroundColor={hasModifiers ? hoverBackgroundColor : undefined}
                                hoverLayerColor={hasModifiers ? layerColorName : undefined}
                                disableHover={!hasModifiers}
                                disableTooltip={true}
                            />
                        </div>
                        <span className="text-[10px] font-bold text-slate-400 dark:text-neutral-400 uppercase">One-Shot</span>
                        <div className={cn(!hasModifiers && "opacity-30 pointer-events-none")}>
                            <Key
                                x={0} y={0} w={1} h={1} row={0} col={0}
                                keycode={osmKeycode || "OSM(MOD_LCTL)"}
                                label={osmContents?.str || "OSM"}
                                keyContents={osmContents || (keyboard ? getKeyContents(keyboard, "OSM(MOD_LCTL)") : undefined)}
                                layerColor={hasModifiers ? layerColorName : "sidebar"}
                                headerClassName={hasModifiers ? `bg-kb-sidebar-dark ${hoverHeaderClass}` : "bg-kb-sidebar-dark"}
                                isRelative variant="small" className="h-[30px] w-full"
                                onClick={osmKeycode ? () => assignKeycode(osmKeycode) : undefined}
                                hoverBorderColor={hasModifiers ? hoverBorderColor : undefined}
                                hoverBackgroundColor={hasModifiers ? hoverBackgroundColor : undefined}
                                hoverLayerColor={hasModifiers ? layerColorName : undefined}
                                disableHover={!hasModifiers}
                                disableTooltip={true}
                            />
                        </div>
                    </div>
                </div>

                {/* Fit the complete keyboard to the available panel column. */}
                <div className="w-[520px] max-w-full min-w-0">
                    <QwertyKeyboard onKeyPress={handleKeyboardInput} activeModifiers={activeModifiers} modifierSide={modifierSide} hideLanguageSelector disableTooltip={true} />
                </div>

                {/* Blank/Transparent keys */}
                <div className="flex min-w-0 max-w-full flex-col gap-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-neutral-400 uppercase">Blank</span>
                    <div className="flex flex-col gap-1">
                        {blankKeys.map((k, i) => {
                            const keyContents = keyboard ? getKeyContents(keyboard, k.keycode) : undefined;
                            return (
                                <Key
                                    key={`${k.keycode}-${i}`}
                                    x={0} y={0} w={1} h={1} row={0} col={0}
                                    keycode={k.keycode}
                                    label={k.label || k.keycode}
                                    keyContents={keyContents as KeyContent | undefined}
                                    layerColor="sidebar"
                                    headerClassName={`bg-kb-sidebar-dark ${hoverHeaderClass}`}
                                    isRelative
                                    variant="small"
                                    hoverBorderColor={hoverBorderColor}
                                    hoverBackgroundColor={hoverBackgroundColor}
                                    hoverLayerColor={layerColorName}
                                    onClick={() => handleKeyClick(k.keycode)}
                                    disableTooltip={true}
                                />
                            );
                        })}
                    </div>
                </div>

                {/* Numpad section - compact grid */}
                <div className="flex min-w-0 max-w-full flex-col gap-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-neutral-400 uppercase">Numpad</span>
                    <div className="grid grid-cols-7 gap-0.5">
                        {numpadKeys.map((k, i) => {
                            if (k.keycode === "BLANK") {
                                return <div key={`blank-${i}`} className="w-[30px] h-[30px]" />;
                            }
                            const keyContents = keyboard ? getKeyContents(keyboard, k.keycode) : undefined;
                            const displayLabel = k.label || k.keycode;
                            return (
                                <Key
                                    key={`${k.keycode}-${i}`}
                                    x={0} y={0} w={1} h={1} row={0} col={0}
                                    keycode={k.keycode}
                                    label={displayLabel}
                                    keyContents={keyContents as KeyContent | undefined}
                                    layerColor="sidebar"
                                    headerClassName={`bg-kb-sidebar-dark ${hoverHeaderClass}`}
                                    isRelative
                                    variant="small"
                                    hoverBorderColor={hoverBorderColor}
                                    hoverBackgroundColor={hoverBackgroundColor}
                                    hoverLayerColor={layerColorName}
                                    onClick={() => handleKeyClick(k.keycode)}
                                    disableTooltip={true}
                                />
                            );
                        })}
                    </div>
                </div>

                {/* Function Keys section */}
                <div className="flex min-w-0 max-w-full flex-col gap-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-neutral-400 uppercase">Function Keys</span>
                    <div className="flex flex-wrap gap-0.5 max-w-[260px]">
                        {functionKeys.map((k) => {
                            const keyContents = keyboard ? getKeyContents(keyboard, k.keycode) : undefined;
                            return (
                                <Key
                                    key={k.keycode}
                                    x={0} y={0} w={1} h={1} row={0} col={0}
                                    keycode={k.keycode}
                                    label={k.label}
                                    keyContents={keyContents as KeyContent | undefined}
                                    layerColor="sidebar"
                                    headerClassName={`bg-kb-sidebar-dark ${hoverHeaderClass}`}
                                    isRelative
                                    variant="small"
                                    className="h-[30px] w-[30px]"
                                    hoverBorderColor={hoverBorderColor}
                                    hoverBackgroundColor={hoverBackgroundColor}
                                    hoverLayerColor={layerColorName}
                                    onClick={() => handleKeyClick(k.keycode)}
                                    disableTooltip={true}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    }

    // Standard vertical layout for sidebar
    return (
        <div className="space-y-6 relative">
            {isPicker && (
                <div className="pb-2">
                    <span className="font-semibold text-xl text-kb-ink">Standard Keys</span>
                </div>
            )}

            {inTray ? <>
                {createPortal(
                    <select
                        className="text-sm font-medium text-kb-ink bg-transparent border-none p-0 cursor-pointer outline-none focus:ring-0"
                        value={internationalLayout}
                        onChange={(e) => setInternationalLayout(e.target.value)}
                        aria-label="Keyboard layout"
                    >
                        {Object.values(LAYOUTS).map((kb: any) => (
                            <option key={kb.value} value={kb.value}>
                                {kb.label}
                            </option>
                        ))}
                    </select>,
                    tray.header!,
                )}
                {createPortal(
                    <QwertyKeyboard onKeyPress={handleKeyboardInput} activeModifiers={activeModifiers} modifierSide={modifierSide} hideLanguageSelector disableTooltip={true}
                        fit={{ maxHeight: tray.keyboardHeight, scaleFor: trayKeyboardScale }} />,
                    tray.body!,
                )}
            </> : <div className="flex flex-col gap-2">
                <div className="flex flex-row items-center justify-start">
                    <select
                        className="font-semibold text-lg text-kb-ink bg-transparent border-none p-0 cursor-pointer outline-none focus:ring-0"
                        value={internationalLayout}
                        onChange={(e) => setInternationalLayout(e.target.value)}
                        aria-label="Keyboard layout"
                    >
                        {Object.values(LAYOUTS).map((kb: any) => (
                            <option key={kb.value} value={kb.value}>
                                {kb.label}
                            </option>
                        ))}
                    </select>
                </div>
                <QwertyKeyboard onKeyPress={handleKeyboardInput} activeModifiers={activeModifiers} modifierSide={modifierSide} hideLanguageSelector disableTooltip={true} />
            </div>}

            <section className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                    <span className="font-semibold text-lg text-kb-ink">Modifiers</span>
                    <ModifierSideToggle side={modifierSide} onChange={setModifierSide} />
                </div>
                {/* One line at any panel width: the five buttons share it equally. */}
                <div className="grid grid-cols-5 gap-1" data-modifier-buttons="">
                    <Button
                        type="button"
                        variant={activeModifiers.length === 0 ? "default" : "secondary"}
                        size="sm"
                        className={cn(
                            "rounded-md h-8 min-w-0 px-1 transition-all text-sm font-bold border-none",
                            activeModifiers.length === 0 ? "bg-kb-active text-kb-active-fg shadow-sm" : "bg-kb-gray-medium text-slate-700 dark:text-neutral-200 hover:bg-kb-surface dark:hover:bg-neutral-700"
                        )}
                        onClick={handleClearModifiers}
                        title="Clear modifiers"
                    >
                        None
                    </Button>
                    {modifierOptions.map((modifier) => {
                        const isActive = activeModifiers.includes(modifier);
                        return (
                            <Button
                                key={modifier}
                                type="button"
                                variant={isActive ? "default" : "secondary"}
                                size="sm"
                                className={cn(
                                    "rounded-md h-8 min-w-0 px-1 transition-all text-sm font-bold border-none",
                                    isActive ? "bg-kb-active text-kb-active-fg shadow-sm" : "bg-kb-gray-medium text-slate-700 dark:text-neutral-200 hover:bg-kb-surface dark:hover:bg-neutral-700"
                                )}
                                onClick={() => handleModifierToggle(modifier)}
                            >
                                {modifier.toUpperCase()}
                            </Button>
                        );
                    })}
                </div>
            </section>

            <section className="flex flex-col gap-2">
                <span className="font-semibold text-lg text-kb-ink">Mod, Mod-Tap, and One-Shot Mod</span>
                {(() => {
                    const dimClass = "opacity-30 pointer-events-none";
                    const keySizeClass = keyVariant === 'small' ? 'h-[30px] w-[30px]' : keyVariant === 'medium' ? 'h-[45px] w-[45px]' : 'h-[60px] w-[60px]';
                    const keys = [
                        {
                            keycode: standaloneModifierKeycode,
                            label: standaloneModifierLabel,
                            forceLabel: true,
                            keyContents: undefined,
                            onClick: hasModifiers ? () => assignKeycode(standaloneModifierKeycode) : undefined,
                            dragItemData: { forceAssign: true, keycode: standaloneModifierKeycode },
                        },
                        {
                            keycode: modTapKeycode || "KC_NO",
                            label: "",
                            keyContents: hasModifiers
                                ? (modTapContents as KeyContent)
                                : { type: "modtap", str: "MT", top: "MT" } as KeyContent,
                            onClick: modTapKeycode ? () => assignKeycode(modTapKeycode) : undefined,
                        },
                        {
                            keycode: osmKeycode || "OSM(MOD_LCTL)",
                            label: "",
                            keyContents: hasModifiers
                                ? (osmContents as KeyContent)
                                : { type: "OSM", str: "OSM", top: "OSM" } as KeyContent,
                            onClick: osmKeycode ? () => assignKeycode(osmKeycode) : undefined,
                        },
                    ];
                    return (
                        <div className={cn("flex flex-wrap gap-1", !hasModifiers && dimClass)}>
                            {keys.map((k, i) => (
                                <Key
                                    key={`${k.keycode}-${i}`}
                                    x={0} y={0} w={1} h={1} row={0} col={0}
                                    keycode={k.keycode}
                                    label={k.label}
                                    keyContents={k.keyContents as KeyContent | undefined}
                                    forceLabel={k.forceLabel}
                                    layerColor="sidebar"
                                    headerClassName={hasModifiers ? `bg-kb-sidebar-dark ${hoverHeaderClass}` : "bg-kb-sidebar-dark"}
                                    isRelative variant={keyVariant}
                                    className={keySizeClass}
                                    onClick={k.onClick}
                                    hoverBorderColor={hasModifiers ? hoverBorderColor : undefined}
                                    hoverBackgroundColor={hasModifiers ? hoverBackgroundColor : undefined}
                                    hoverLayerColor={hasModifiers ? layerColorName : undefined}
                                    dragItemData={k.dragItemData}
                                    disableHover={!hasModifiers}
                                    disableTooltip={true}
                                />
                            ))}
                        </div>
                    );
                })()}
            </section>

            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <span className="font-semibold text-lg text-kb-ink">Blank and Transparent</span>
                    {renderKeyGrid(blankKeys)}
                </div>
                <div className="flex flex-col gap-2">
                    <span className="font-semibold text-lg text-kb-ink">Numpad</span>
                    <div ref={numpadBoxRef} className="w-full min-w-0" data-numpad-box="">{renderKeyGrid(numpadKeys, numpadCell, numpadVariant)}</div>
                </div>
                <div className="flex flex-col gap-2">
                    <span className="font-semibold text-lg text-kb-ink">Function Keys</span>
                    {renderKeyGrid(functionKeys)}
                </div>
            </div>
        </div >
    );
};

export default BasicKeyboards;
