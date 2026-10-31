import { useChanges } from "@/contexts/ChangesContext";
import React, { ReactNode, useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useKeyboard } from "@/contexts/KeyboardContext";
import { QMK_SETTINGS } from "@/constants/qmk-settings";
import { qmkService } from "@/services/qmk.service";
import { keyboardService } from "@/services/keyboard.service";
import { cn } from "@/lib/utils";
import type { QMKSettingsField } from "@/types/qmk";

// The QMK settings (QSIDs) have no panel of their own. Each group of fields is shown
// in the editor panel for the feature it tunes:
//   Typing behavior: Tap-Hold, Auto Shift, One Shot Keys, Magic, Grave Escape
//   Mouse Keys > Movement: Mouse keys
//   Combos and Leaders: their own timing inputs (the "Combo" and "Leader Key"
//   groups are not rendered here).

// Holds what the user types and saves it on Enter or blur. Saving on every keystroke
// clamped partial values and disabled the field mid-edit, which dropped focus.
const IntegerSettingInput: React.FC<{
    title: string;
    value: number;
    min: number;
    max: number;
    onCommit: (value: number) => void;
    className?: string;
}> = ({ title, value, min, max, onCommit, className }) => {
    const [draft, setDraft] = useState<string | null>(null);

    const commit = () => {
        if (draft === null) return;
        const parsed = parseInt(draft, 10);
        setDraft(null);
        if (Number.isNaN(parsed)) return;
        const clamped = Math.max(min, Math.min(max, parsed));
        if (clamped !== value) onCommit(clamped);
    };

    return (
        <Input
            type="number"
            aria-label={title}
            value={draft ?? value}
            min={min}
            max={max}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setDraft(null);
            }}
            className={className}
        />
    );
};

export interface QmkSettingsSectionsProps {
    /** QMK_SETTINGS tab names to show, in this order. */
    sections: string[];
    /** Sections that start expanded. */
    openByDefault?: string[];
    /** Show the fields without accordion headers (for a single section inside another panel). */
    flat?: boolean;
    /** Shown when the keyboard reports no QMK settings. */
    emptyMessage?: ReactNode;
}

export const QmkSettingsSections: React.FC<QmkSettingsSectionsProps> = ({ sections, openByDefault = [], flat = false, emptyMessage = null }) => {
    const { keyboard, setKeyboard } = useKeyboard();
    const { queue } = useChanges();
    const panelId = useId();
    const [expanded, setExpanded] = useState<Record<string, boolean>>(
        () => Object.fromEntries(sections.map((name) => [name, openByDefault.includes(name)])),
    );
    const [saving, setSaving] = useState<Record<string, boolean>>({});

    if (!keyboard) return null;

    // Check if keyboard has QMK settings
    if (!keyboard.settings || Object.keys(keyboard.settings).length === 0) {
        return <>{emptyMessage}</>;
    }

    const toggleSection = (name: string) => {
        setExpanded(prev => ({ ...prev, [name]: !prev[name] }));
    };

    // Get value from settings, accounting for bit fields
    const getBoolValue = (qsid: number, bit?: number): boolean => {
        const value = keyboard.settings?.[qsid] ?? 0;
        if (bit === undefined) {
            // Standalone boolean - non-zero is true
            return value !== 0;
        }
        // Bit field - extract specific bit
        return ((value >> bit) & 1) === 1;
    };

    const getIntValue = (qsid: number): number => {
        return keyboard.settings?.[qsid] ?? 0;
    };

    // Check if a QSID is supported by this keyboard
    const isSupported = (qsid: number): boolean => {
        return keyboard.settings?.[qsid] !== undefined;
    };

    // A field to show: supported, and not one the firmware ignores (hidden)
    const isShown = (field: QMKSettingsField): boolean => {
        return isSupported(field.qsid) && !(field.type === "integer" && field.hidden);
    };

    // Handle boolean toggle (with or without bit field)
    const handleBoolToggle = async (qsid: number, bit: number | undefined, checked: boolean) => {
        const key = `${qsid}-${bit ?? 'full'}`;
        setSaving(prev => ({ ...prev, [key]: true }));

        try {
            let newVal: number;
            if (bit === undefined) {
                // Standalone boolean
                newVal = checked ? 1 : 0;
            } else {
                // Bit field
                const currentVal = keyboard.settings?.[qsid] ?? 0;
                newVal = checked
                    ? currentVal | (1 << bit)      // Set bit
                    : currentVal & ~(1 << bit);    // Clear bit
            }

            const updated = {
                ...keyboard,
                settings: { ...keyboard.settings, [qsid]: newVal }
            };
            setKeyboard(updated);

            await queue(`QMK setting ${qsid}`, async () => {
                await qmkService.push(updated, qsid);
                await keyboardService.saveSvil();
            }, { writeKey: `qmk:${qsid}` });
        } catch (err) {
            console.error("Failed to update QMK setting:", err);
        } finally {
            setSaving(prev => ({ ...prev, [key]: false }));
        }
    };

    // Handle integer change
    const handleIntChange = async (qsid: number, value: number, min: number, max: number) => {
        const key = `${qsid}-int`;
        setSaving(prev => ({ ...prev, [key]: true }));

        try {
            const clamped = Math.max(min, Math.min(max, value));
            const updated = {
                ...keyboard,
                settings: { ...keyboard.settings, [qsid]: clamped }
            };
            setKeyboard(updated);

            await queue(`QMK setting ${qsid}`, async () => {
                await qmkService.push(updated, qsid);
                await keyboardService.saveSvil();
            }, { writeKey: `qmk:${qsid}` });
        } catch (err) {
            console.error("Failed to update QMK setting:", err);
        } finally {
            setSaving(prev => ({ ...prev, [key]: false }));
        }
    };

    // Render a single field
    const renderField = (field: QMKSettingsField, index: number) => {
        // Check if this QSID is supported and shown
        if (!isShown(field)) {
            return null;
        }

        if (field.type === "boolean") {
            const key = `${field.qsid}-${field.bit ?? 'full'}`;
            const isSaving = saving[key];
            const checked = getBoolValue(field.qsid, field.bit);

            return (
                <div
                    key={`${field.qsid}-${field.bit ?? 'full'}-${index}`}
                    className="flex flex-row items-center justify-between py-2 px-1"
                >
                    <span className="text-sm">{field.title}</span>
                    <Switch
                        aria-label={field.title}
                        checked={checked}
                        onCheckedChange={(c) => handleBoolToggle(field.qsid, field.bit, c)}
                        disabled={isSaving}
                        className={cn(isSaving && "opacity-50")}
                    />
                </div>
            );
        }

        if (field.type === "integer") {
            const key = `${field.qsid}-int`;
            const isSaving = saving[key];
            const value = getIntValue(field.qsid);

            return (
                <div
                    key={`${field.qsid}-${index}`}
                    className="flex flex-row items-center justify-between py-2 px-1 gap-4"
                >
                    <div className="flex flex-col flex-1 min-w-0">
                        <span className="text-sm">{field.title}</span>
                        <span className="text-xs text-muted-foreground">
                            Range: {field.min} - {field.max}
                        </span>
                    </div>
                    <IntegerSettingInput
                        title={field.title}
                        value={value}
                        min={field.min}
                        max={field.max}
                        onCommit={(newVal) => handleIntChange(field.qsid, newVal, field.min, field.max)}
                        className={cn("w-24 text-right select-text", isSaving && "opacity-50")}
                    />
                </div>
            );
        }

        return null;
    };

    // Render a section
    const renderSection = (name: string, fields: QMKSettingsField[]) => {
        // Filter to only supported fields
        const supportedFields = fields.filter(isShown);
        if (supportedFields.length === 0) {
            return null;
        }

        const isExpanded = expanded[name];

        return (
            <div key={name} className="border-b border-gray-200 dark:border-neutral-700">
                <button
                    type="button"
                    aria-expanded={!!isExpanded}
                    aria-controls={`${panelId}-${encodeURIComponent(name)}`}
                    onClick={() => toggleSection(name)}
                    className="flex justify-between items-center w-full p-3 hover:bg-muted/50 transition-colors"
                >
                    <span className="font-medium text-sm">{name}</span>
                    <ChevronDown
                        className={cn(
                            "h-4 w-4 transition-transform duration-200",
                            isExpanded && "rotate-180"
                        )}
                    />
                </button>
                {isExpanded && (
                    <div id={`${panelId}-${encodeURIComponent(name)}`} className="px-3 pb-3 space-y-1">
                        {supportedFields.map((field, index) => renderField(field, index))}
                    </div>
                )}
            </div>
        );
    };

    const tabs = sections
        .map((name) => QMK_SETTINGS.tabs.find((tab) => tab.name === name))
        .filter((tab): tab is (typeof QMK_SETTINGS.tabs)[number] => !!tab);

    if (flat) {
        const fields = tabs.flatMap((tab) => tab.fields).filter(isShown);
        if (fields.length === 0) return null;
        return <div className="flex flex-col space-y-1">{fields.map((field, index) => renderField(field, index))}</div>;
    }

    return (
        <div className="flex flex-col">
            {tabs.map(tab => renderSection(tab.name, tab.fields))}
        </div>
    );
};

export default QmkSettingsSections;
