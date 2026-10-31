import React from "react";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { QMK_SETTINGS } from "@/constants/qmk-settings";
import { QmkSettingsSections } from "./QMKSettingsPanel";

const MOUSE_KEYS_SECTION = "Mouse keys";
const MOUSE_QSIDS = QMK_SETTINGS.tabs.find((tab) => tab.name === MOUSE_KEYS_SECTION)?.fields
    .filter((f) => !(f.type === "integer" && f.hidden)).map((f) => f.qsid) ?? [];

/**
 * The QMK mouse key timing and speed values, below the keys they tune.
 * Nothing renders when the board doesn't report them.
 */
const MouseMovementSection: React.FC = () => {
    const { keyboard } = useKeyboard();
    const supported = MOUSE_QSIDS.some((qsid) => keyboard?.settings?.[qsid] !== undefined);
    if (!supported) return null;
    return (
        <section aria-labelledby="mouse-movement-heading" className="flex flex-col gap-1 pt-4 pr-[26px] min-w-0 max-w-[560px]">
            <h3 id="mouse-movement-heading" className="font-semibold text-sm text-kb-ink">Movement</h3>
            <p className="text-xs text-muted-foreground">How fast the mouse keys move the pointer and scroll. Changes follow your update mode.</p>
            <QmkSettingsSections sections={[MOUSE_KEYS_SECTION]} flat />
        </section>
    );
};

export default MouseMovementSection;
