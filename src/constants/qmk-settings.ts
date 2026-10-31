import { QMKSettings } from "../types/qmk";

// THIS IS FROM QMK REPO, with each maximum held at what the firmware variable
// the setting is applied to can use (VARIABLE_LIMITS below), and the step size
// hidden: QMK builds it in (info.json mousekey.move_delta), so no setting changes it.
export const QMK_SETTINGS: QMKSettings = {
  "tabs": [
    {
      "name": "Magic",
      "fields": [
        { "type": "boolean", "title": "Swap Caps Lock and Left Control", "qsid": 21, "width": 4, "bit": 0 },
        { "type": "boolean", "title": "Treat Caps Lock as Control", "qsid": 21, "width": 4, "bit": 1 },
        { "type": "boolean", "title": "Swap Left Alt and GUI", "qsid": 21, "width": 4, "bit": 2 },
        { "type": "boolean", "title": "Swap Right Alt and GUI", "qsid": 21, "width": 4, "bit": 3 },
        { "type": "boolean", "title": "Disable the GUI keys", "qsid": 21, "width": 4, "bit": 4 },
        { "type": "boolean", "title": "Swap ` and Escape", "qsid": 21, "width": 4, "bit": 5 },
        { "type": "boolean", "title": "Swap \\ and Backspace", "qsid": 21, "width": 4, "bit": 6 },
        { "type": "boolean", "title": "Enable N-key rollover", "qsid": 21, "width": 4, "bit": 7 },
        { "type": "boolean", "title": "Swap Left Control and GUI", "qsid": 21, "width": 4, "bit": 8 },
        { "type": "boolean", "title": "Swap Right Control and GUI", "qsid": 21, "width": 4, "bit": 9 }
      ]
    },
    {
      "name": "Grave Escape",
      "fields": [
        { "type": "boolean", "title": "Always send Escape if Alt is pressed", "qsid": 1, "bit": 0 },
        { "type": "boolean", "title": "Always send Escape if Control is pressed", "qsid": 1, "bit": 1 },
        { "type": "boolean", "title": "Always send Escape if GUI is pressed", "qsid": 1, "bit": 2 },
        { "type": "boolean", "title": "Always send Escape if Shift is pressed", "qsid": 1, "bit": 3 }
      ]
    },
    {
      "name": "Tap-Hold",
      "fields": [
        { "type": "integer", "title": "Tapping Term", "qsid": 7, "min": 50, "max": 10000, "width": 2 },
        { "type": "boolean", "title": "Permissive Hold", "qsid": 8, "bit": 0 },
        { "type": "boolean", "title": "Ignore Mod Tap Interrupt", "qsid": 8, "bit": 1 },
        { "type": "boolean", "title": "Tapping Force Hold", "qsid": 8, "bit": 2 },
        { "type": "boolean", "title": "Retro Tapping", "qsid": 8, "bit": 3 },
        { "type": "boolean", "title": "Permissive Hold (new)", "qsid": 22 },
        { "type": "boolean", "title": "Hold On Other Key Press", "qsid": 23 },
        { "type": "boolean", "title": "Retro Tapping (new)", "qsid": 24 },
        { "type": "integer", "title": "Quick Tap Term", "qsid": 25, "min": 0, "max": 10000, "width": 2 },
        { "type": "integer", "title": "Tap Code Delay", "qsid": 18, "min": 0, "max": 1000, "width": 2 },
        { "type": "integer", "title": "Tap Hold Caps Delay", "qsid": 19, "min": 0, "max": 1000, "width": 2 },
        { "type": "integer", "title": "Tapping Toggle", "qsid": 20, "min": 0, "max": 15, "width": 1 },
        { "type": "boolean", "title": "Chordal Hold", "qsid": 26 },
        { "type": "integer", "title": "Flow Tap", "qsid": 27, "min": 0, "max": 10000, "width": 2 }
      ]
    },
    {
      "name": "Auto Shift",
      "fields": [
         { "type": "boolean", "title": "Enable", "qsid": 3, "bit": 0 },
        { "type": "boolean", "title": "Enable for modifiers", "qsid": 3, "bit": 1 },
        { "type": "integer", "title": "Timeout", "qsid": 4, "min": 50, "max": 1000, "width": 2 },
        { "type": "boolean", "title": "Do not Auto Shift special keys", "qsid": 3, "bit": 2 },
        { "type": "boolean", "title": "Do not Auto Shift numeric keys", "qsid": 3, "bit": 3 },
        { "type": "boolean", "title": "Do not Auto Shift alpha characters", "qsid": 3, "bit": 4 },
        { "type": "boolean", "title": "Enable keyrepeat", "qsid": 3, "bit": 5 },
        { "type": "boolean", "title": "Disable keyrepeat when timeout is exceeded", "qsid": 3, "bit": 6 }
      ]
    },
    {
      "name": "Combo",
      "fields": [
        { "type": "integer", "title": "Time out period for combos", "qsid": 2, "min": 10, "max": 10000, "width": 2 }
      ]
    },
    {
      "name": "One Shot Keys",
      "fields": [
        { "type": "integer", "title": "Tapping this number of times holds the key until tapped once again", "qsid": 5, "min": 0, "max": 15, "width": 1 },
        { "type": "integer", "title": "Time (in ms) before the one shot key is released", "qsid": 6, "min": 0, "max": 60000, "width": 2 }
      ]
    },
    {
      "name": "Mouse keys",
      "fields": [
        { "type": "integer", "title": "Delay between pressing a movement key and cursor movement", "qsid": 9, "min": 0, "max": 2550, "width": 2 },
        { "type": "integer", "title": "Time between cursor movements in milliseconds", "qsid": 10, "min": 1, "max": 255, "width": 2 },
        { "type": "integer", "title": "Step size", "qsid": 11, "min": 0, "max": 1000, "width": 2, "hidden": true },
        { "type": "integer", "title": "Maximum cursor speed at which acceleration stops", "qsid": 12, "min": 0, "max": 255, "width": 2 },
        { "type": "integer", "title": "Time until maximum cursor speed is reached", "qsid": 13, "min": 0, "max": 255, "width": 2 },
        { "type": "integer", "title": "Delay between pressing a wheel key and wheel movement", "qsid": 14, "min": 0, "max": 2550, "width": 2 },
        { "type": "integer", "title": "Time between wheel movements", "qsid": 15, "min": 0, "max": 255, "width": 2 },
        { "type": "integer", "title": "Maximum number of scroll steps per scroll action", "qsid": 16, "min": 0, "max": 255, "width": 2 },
        { "type": "integer", "title": "Time until maximum scroll speed is reached", "qsid": 17, "min": 0, "max": 255, "width": 2 }
      ]
    },
    {
      "name": "Leader Key",
      "fields": [
        { "type": "integer", "title": "Leader timeout (ms)", "qsid": 28, "min": 50, "max": 5000, "width": 2 },
        { "type": "boolean", "title": "Per-key timing (reset timeout on each key)", "qsid": 29 }
      ]
    }
  ]
};

export const COMBO_TERM_QSID = 2;
export const LEADER_TIMEOUT_QSID = 28;
export const LEADER_PER_KEY_QSID = 29;

/**
 * QMK settings that can't work at 0, with the default used in place of a 0: a
 * combo term of 0 never fires a combo, a tapping term of 0 makes every tap-hold
 * key a hold, an Auto Shift timeout of 0 shifts every key, a mouse key interval
 * of 0 moves the cursor every scan, and a leader timeout of 0 ends every
 * sequence at once. Firmware from x4.3.3 replaces a stored 0 with the same
 * values (sval_qmk_settings.c), and so does an import. Settings where 0 means
 * something (one-shot timeout, Flow Tap, quick tap term, tap code delay) aren't here.
 */
export const ZERO_REPLACED_SETTINGS: Readonly<Record<number, number>> = {
  [COMBO_TERM_QSID]: 50,
  4: 175,
  7: 200,
  10: 20,
  [LEADER_TIMEOUT_QSID]: 300,
};

/** The full firmware release that replaces a stored 0 in those settings (first in x4.3.3); the replaced-settings note links it. */
export const ZERO_SETTINGS_RELEASE = "v4.3.3";

/** The value a setting takes on the board: its default in place of a 0 that can't work. */
export function effectiveSetting(qsid: number, value: number | undefined): number | undefined {
  if (value === 0 && qsid in ZERO_REPLACED_SETTINGS) return ZERO_REPLACED_SETTINGS[qsid];
  return value;
}

/**
 * Settings whose largest working value is set by the firmware variable they are
 * applied to, not by taste. QMK's mouse key variables are 8-bit (mousekey.c):
 * the intervals, speeds and times to max hold 0-255, and the delays are applied
 * in 10 ms units, so 0-2550 ms. QMK counts at most 15 taps (tap.count is 4
 * bits), so a tapping toggle or one-shot tap toggle above 15 is never reached.
 * Above these, older firmware wrapped the value (an interval of 256 became 0
 * and moved the cursor every scan); firmware from this change holds it at the
 * limit. Each is the field's maximum in the table above, and an import holds a
 * larger value at the limit.
 */
export const VARIABLE_LIMITS: Readonly<Record<number, number>> = {
  5: 15,
  9: 2550,
  10: 255,
  12: 255,
  13: 255,
  14: 2550,
  15: 255,
  16: 255,
  17: 255,
  20: 15,
};

/** The mouse key step size: stored and reported, but QMK builds it in, so it isn't shown. */
export const MOUSEKEY_STEP_SIZE_QSID = 11;

/** A setting's range in the settings table. */
export function settingRange(qsid: number): { min: number; max: number } {
  for (const tab of QMK_SETTINGS.tabs) {
    for (const field of tab.fields) {
      if (field.qsid === qsid && field.type === "integer") return { min: field.min, max: field.max };
    }
  }
  return { min: 0, max: 65535 };
}

/** A typed value for a setting, clamped to its range; an empty or unreadable entry keeps the current value. */
export function parseSettingInput(qsid: number, input: string, current: number): number {
  const parsed = parseInt(input.trim(), 10);
  if (Number.isNaN(parsed)) return current;
  const { min, max } = settingRange(qsid);
  return Math.max(min, Math.min(max, parsed));
}
