import { useSyncExternalStore } from "react";

/**
 * Whether the Touchpad tuning dialog is open (opened from Pointing Devices'
 * "Tune touchpad…" link, or ?panel=pointing&tune=touchpad). One dialog per
 * page, mounted once (TouchpadTuningDialog in EditorLayout).
 */
let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
    if (open === next) return;
    open = next;
    for (const l of [...listeners]) l();
}

export function openTouchpadTuning(): void {
    set(true);
}

export function closeTouchpadTuning(): void {
    set(false);
}

export function useTouchpadTuningOpen(): boolean {
    return useSyncExternalStore(
        (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
        () => open,
        () => false,
    );
}
