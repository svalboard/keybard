// The QWERTY Example is the shipping keymap (svalboard/qmk keymaps/sval/keymap.c): every key is
// named, and the Mouse layer keeps the firmware's sniper key.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileService } from "../../src/services/file.service";
import { keyService } from "../../src/services/key.service";
import { ImportService } from "../../src/services/import.service";
import { prepareImport } from "../../src/services/import-preflight";
import { getKeyLabel } from "../../src/utils/layers";
import type { KeyboardInfo } from "../../src/types/keyboard.types";

const text = readFileSync(resolve(process.cwd(), "src/default-layouts/sval-default.svil"), "utf8");
const svil = JSON.parse(text);
const flat = (layer: unknown[]): string[] => (Array.isArray(layer[0]) ? (layer as string[][]).flat() : (layer as string[]));

// Mouse layer (MBO), left pinky south: SV_SNIPER_3 in the firmware, which numbers its
// custom keycodes from QK_USER_0 (0x7E40) in sval.json's customKeycodes order.
const MOUSE = 15;
const PINKY_SOUTH = 24;
const SV_SNIPER_3 = 0x7e40 + 13;

describe("the QWERTY Example", () => {
    it("names every key (no raw codes left by a conversion)", () => {
        const raw = svil.layout.flatMap((layer: unknown[], l: number) => flat(layer).map((k, i) => [l, i, String(k)] as const)).filter(([, , k]: readonly [number, number, string]) => /^0x/i.test(k));
        expect(raw).toEqual([]);
    });

    it("has the firmware's 3x sniper key on the Mouse layer (left pinky south)", () => {
        expect(flat(svil.layout[MOUSE])[PINKY_SOUTH]).toBe("SV_SNIPER_3");
    });

    // Board config layer, left index center: SV_OUTPUT_STATUS, as in the firmware. The
    // firmware's DPI keys stay out; pointer speed is set in Keybard.
    it("has the firmware's output status key on the board config layer, and no DPI keys", () => {
        expect(flat(svil.layout[14])[8]).toBe("SV_OUTPUT_STATUS");
        expect(svil.layout.flatMap(flat).filter((k: string) => /DPI/.test(k))).toEqual([]);
    });

    // This file's tests share one key table, so these run in order: no board first.
    it("loads with no board connected and shows the key as Sniper 3x", () => {
        const kb = fileService.parseContent(text);
        expect(kb.keymap![MOUSE][PINKY_SOUTH]).toBe(SV_SNIPER_3);
        expect(kb.raw_keycode_count).toBe(0);
        expect(getKeyLabel(kb, SV_SNIPER_3).label).toBe("Sniper\n3x");
        expect(keyService.stringify(SV_SNIPER_3)).toBe("SV_SNIPER_3");
    });

    it("writes the firmware's code for the key to a connected Svalboard", async () => {
        // A connected Svalboard registers its definition's custom keycodes on connect.
        const firmwareNames = ["SV_LEFT_DPI_INC", "SV_LEFT_DPI_DEC", "SV_RIGHT_DPI_INC", "SV_RIGHT_DPI_DEC", "SV_LEFT_SCROLL_TOGGLE",
            "SV_RIGHT_SCROLL_TOGGLE", "SV_RECALIBRATE_POINTER", "SV_MH_CHANGE_TIMEOUTS", "SV_CAPS_WORD", "SV_AXIS_SCROLL_LOCK",
            "SV_TOGGLE_23_67", "SV_TOGGLE_45_67", "SV_SNIPER_2", "SV_SNIPER_3", "SV_SNIPER_5", "SV_SCROLL_HOLD", "SV_SCROLL_TOGGLE",
            "SV_OUTPUT_STATUS", "SV_TOGGLE_AUTOMOUSE", "SV_TURBO_SCAN", "SV_NATURAL_SCROLL_TOGGLE", "SV_SNIPER_2_TG", "SV_SNIPER_3_TG",
            "SV_SNIPER_5_TG", "SV_BOOST_2", "SV_BOOST_3", "SV_BOOST_5", "SV_BOOST_2_TG", "SV_BOOST_3_TG", "SV_BOOST_5_TG", "SV_VELOCITY_SCROLL"];
        const file = fileService.parseContent(text);
        const board = {
            ...structuredClone(file),
            custom_keycodes: firmwareNames.map(name => ({ name, title: name, shortName: name })),
            keymap: file.keymap!.map(layer => layer.map(() => 0)),
            svil_proto: 3, macros_size: 4096, macro_count: 256, combo_count: 256, tapdance_count: 256, key_override_count: 256,
        } as KeyboardInfo;
        keyService.generateAllKeycodes(board);

        const next = prepareImport(fileService.parseContent(text), board);
        expect(next.errors).toEqual([]);
        // Loading the file keeps the connected board's own names and labels.
        expect(getKeyLabel(board, SV_SNIPER_3).label).toBe("SV_SNIPER_3");
        const updateKey = vi.fn().mockResolvedValue(undefined);
        const writes: Array<() => Promise<void>> = [];
        await new ImportService().syncWithKeyboard(next.keyboard, board, async (_desc, cb) => { writes.push(cb); }, {
            keyboardService: { updateKey, saveSvil: vi.fn(), updateQMKSetting: vi.fn(), updateFragmentSelection: vi.fn().mockResolvedValue(true) },
        } as any);
        for (const write of writes) await write();

        const cols = board.cols!;
        expect(updateKey).toHaveBeenCalledWith(MOUSE, Math.floor(PINKY_SOUTH / cols), PINKY_SOUTH % cols, SV_SNIPER_3);
    });
});
