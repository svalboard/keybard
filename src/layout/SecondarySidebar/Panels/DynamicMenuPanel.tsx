import { selectPointingMenu, type PointingMenuSection } from "@/utils/pointing-menu";
import { readBackKeys, timingWrites, withEffectiveTiming } from "@/utils/scan-timing";
import { useEffect, useState, useCallback, useMemo } from "react";
import { CustomUIRenderer } from "@/components/CustomUI";
import { customValueService } from "@/services/custom-value.service";
import { useChanges } from "@/contexts/ChangesContext";
import { useKeyboard } from "@/contexts/KeyboardContext";
import type { CustomUIMenuItem } from "@/types/keyboard.types";
import { boardHasTouchpad, PAD_KEYS } from "@/utils/touchpad-taps";

const NO_KEYS: ReadonlySet<string> = new Set();
const PAD_KEY_SET: ReadonlySet<string> = new Set(PAD_KEYS);

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
    const { keyboard, setKeyboard, isConnected } = useKeyboard();
    const { queue } = useChanges();
    const [values, setValues] = useState<Map<string, number>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Get the menu for this panel
    const menu = keyboard?.menus?.[menuIndex];
    // The touchpad taps show only while a half has a touchpad.
    const hasTouchpad = boardHasTouchpad(keyboard);
    const displayItems = useMemo(() => selectPointingMenu(
        (menu?.content ?? []) as CustomUIMenuItem[], section, hasTouchpad ? NO_KEYS : PAD_KEY_SET,
    ), [menu, section, hasTouchpad]);

    // Load values when panel opens or keyboard connects
    useEffect(() => {
        if (!menu) {
            setLoading(false);
            return;
        }

        const loadValues = async () => {
            setLoading(true);
            setError(null);
            try {
                // First: seed from kbinfo.custom_values (instant, no USB)
                if (keyboard?.custom_values) {
                    customValueService.populateCacheFromEntries(keyboard.custom_values);
                }

                setValues(customValueService.getCache());
            } catch (err) {
                console.error("Failed to load custom values:", err);
                setError("Failed to load settings from keyboard");
            } finally {
                setLoading(false);
            }
        };

        loadValues();
    }, [menu, isConnected, keyboard?.custom_values]);

    // Draft and device writes share the same queue; persistence completes before
    // the queue acknowledges success. Reopening the panel preserves manual drafts.
    // Writes key (and, for a scan wait on older firmware, the other wait it
    // would otherwise leave on the preset), saves, then reads back what the
    // board stored for the values it may have changed (clamped, rounded, or
    // set together) so every view shows the board's own values.
    const handleValueChange = useCallback(async (key: string, value: number) => {
        if (!menu || !isConnected || !keyboard) return;
        const refs = customValueService.extractAllItemsWithRefs([menu]);
        const find = (k: string) => refs.find(({ ref }) => ref.key === k);
        const found = find(key);
        if (!found) { setError(`Unknown setting: ${key}`); return; }
        const writes = timingWrites(key, value, customValueService.getCache()).filter(([k]) => find(k));
        const store = (pairs: [string, number][]) => {
            setValues(prev => {
                const next = new Map(prev);
                for (const [k, v] of pairs) next.set(k, v);
                return next;
            });
            setKeyboard(current => {
                if (!current) return current;
                const entries = [...(current.custom_values ?? [])];
                for (const [k, v] of pairs) {
                    const f = find(k);
                    if (!f) continue;
                    const index = entries.findIndex(entry => entry.key === k);
                    const entry = { key: k, channel: f.ref.channel, valueId: f.ref.valueId, data: customValueService.intToBytes(v, customValueService.getByteWidth(f.item)) };
                    if (index >= 0) entries[index] = { ...entries[index], ...entry };
                    else entries.push(entry);
                }
                return { ...current, custom_values: entries };
            });
        };
        store(writes);
        await queue(`Setting ${key}`, async () => {
            for (const [k, v] of writes) await customValueService.setValue(k, v, [menu]);
            await customValueService.save(found.ref.channel);
            const back: [string, number][] = [];
            for (const k of readBackKeys(key)) {
                const f = find(k);
                if (!f) continue;
                const v = await customValueService.get(f.ref.channel, f.ref.valueId, customValueService.getByteWidth(f.item));
                customValueService.setCached(k, v);
                back.push([k, v]);
            }
            if (back.length) store(back);
        }, { type: "custom_ui", writeKey: `custom:${key}` });
    }, [menu, isConnected, queue, keyboard, setKeyboard]);
    const shownValues = useMemo(() => withEffectiveTiming(values), [values]);

    const handleButtonClick = useCallback(async (key: string) => {
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
