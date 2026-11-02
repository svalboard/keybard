import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileService } from '../../src/services/file.service';
import { keyService } from '../../src/services/key.service';
import type { KeyboardInfo } from '../../src/types/keyboard.types';
import { createTestKeyboardInfo } from '../fixtures/keyboard-info.fixture';
import { createTestFragments, createFragmentState, FRAGMENT_NAMES, FRAGMENT_IDS } from '../fixtures/fragments.fixture';
import { generateComplexKeymap } from '../utils/keymap-helpers';

// Helper to create kbinfo with numeric hex kbid for export testing
const createExportableKeyboardInfo = (overrides?: Partial<KeyboardInfo>): KeyboardInfo => {
    return createTestKeyboardInfo({
        kbid: '1234567890ABCDEF', // Valid hex for BigInt conversion
        ...overrides,
    });
};

// Helper function to create mock files
const createMockFile = (content: string, filename = 'test.svil'): File => {
  const blob = new Blob([content], { type: 'application/json' });
  return new File([blob], filename, { type: 'application/json' });
};

// Helper to create a large file
const createLargeFile = (): File => {
  const largeContent = 'x'.repeat(1048577); // 1MB + 1 byte
  const blob = new Blob([largeContent], { type: 'application/json' });
  return new File([blob], 'large.svil', { type: 'application/json' });
};

describe('FileService', () => {
  it('leaves the touchpad mode out of an export (a per-board setting, not layout)', () => {
    const kb = { rows: 1, cols: 1, layers: 1, keymap: [[4]], custom_values: [
      { key: 'id_pad_touchpad_mode', channel: 0, valueId: 59, data: [1] },
      { key: 'id_pad_tap', channel: 0, valueId: 51, data: [1] },
    ] } as never;
    const svil = JSON.parse(fileService.kbinfoToSvil(kb));
    const keys = (svil.custom_values ?? []).map((v: { key: string }) => v.key);
    expect(keys).toContain('id_pad_tap');
    expect(keys).not.toContain('id_pad_touchpad_mode');
  });

  it('preserves the renamed Python GUI protocol version', () => {
    const result = fileService.parseContent(JSON.stringify({
      uid: 12345, sval_protocol: 3, layout: [[['KC_A']]],
      macro: [], combo: [], tap_dance: [], key_override: [],
    }));
    expect(result.svil_proto).toBe(3);
    expect(result.keymap?.[0][0]).toBe(keyService.parse('KC_A'));
  });

  describe('loadFile', () => {
    it('successfully loads valid .svil file with layout', async () => {
      const validData = {
        version: 1,
        uid: 12345,
        layout: [
          [
            ['KC_A', 'KC_B', 'KC_C'],
            ['KC_D', 'KC_E', 'KC_F'],
          ],
        ],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
      };

      const file = createMockFile(JSON.stringify(validData));
      const result = await fileService.loadFile(file);

      expect(result.rows).toBe(2);
      expect(result.cols).toBe(3);
      // parseContent converts decimal UID to hex string via BigInt
      expect(result.kbid).toBe('3039'); // 12345 decimal = 0x3039
    });

    it('successfully parses .vil file with uid field', async () => {
      const vilData = {
        uid: 98765,
        layout: [
          [
            ['KC_A', 'KC_B'],
            ['KC_C', 'KC_D'],
          ],
        ],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
        settings: {},
      };

      const file = createMockFile(JSON.stringify(vilData));
      const result = await fileService.loadFile(file);

      expect(result.kbid).toBe('181cd'); // 98765 decimal = 0x181cd
      // vilToKBINFO uses || so default rows/cols from DEFAULT_KB_INFO are kept
      // keymap is flattened correctly based on layout dimensions
      expect(result.keymap?.[0].length).toBe(4); // 2 rows * 2 cols = 4 keys
    });

    it('successfully parses .svil file with optional fields', async () => {
      const dataWithOptionals = {
        version: 1,
        uid: 11111,
        layout: [
          [['KC_A', 'KC_B']],
          [['KC_C', 'KC_D']],
        ],
        macro: [[['text', 'hello']]],
        tap_dance: [{ on: true, on_tap: 'KC_E', on_hold: 'KC_F', on_double_tap: 'KC_G', on_tap_hold: 'KC_H', tapping_term: 200 }],
        combo: [],
        key_override: [],
        svil_protocol: 1,
        via_protocol: 12,
      };

      const file = createMockFile(JSON.stringify(dataWithOptionals));
      const result = await fileService.loadFile(file);

      expect(result.kbid).toBe('2b67'); // 11111 decimal = 0x2b67
      expect(result.layers).toBe(2);
      expect(result.tapdances?.length).toBe(1);
    });

    it('throws "File too large" error for files > 1MB', async () => {
      const largeFile = createLargeFile();

      await expect(fileService.loadFile(largeFile)).rejects.toThrow('File too large');
    });

    it('throws error for malformed JSON', async () => {
      const invalidJson = '{ invalid json content }';
      const file = createMockFile(invalidJson);

      // JSON.parse throws SyntaxError for malformed JSON
      await expect(fileService.loadFile(file)).rejects.toThrow();
    });

    it('throws error when file has no uid', async () => {
      // parseContent requires uid (for .vil/.svil) to detect format
      const missingIdentifier = { rows: 6, cols: 14, layers: 4 };
      const file = createMockFile(JSON.stringify(missingIdentifier));

      await expect(fileService.loadFile(file)).rejects.toThrow('Unknown file format');
    });

    it('throws error for non-object JSON (array)', async () => {
      const arrayData = '[1, 2, 3]';
      const file = createMockFile(arrayData);

      // Arrays don't have uid property
      await expect(fileService.loadFile(file)).rejects.toThrow('Unknown file format');
    });

    it('throws error for null JSON', async () => {
      const nullData = 'null';
      const file = createMockFile(nullData);

      // null.kbid throws TypeError
      await expect(fileService.loadFile(file)).rejects.toThrow();
    });

    it('converts string keycodes to numbers in keymap', async () => {
      const dataWithStringKeycodes = {
        version: 1,
        uid: 12345,
        layout: [
          [['KC_A', 'KC_B', 'KC_C']],
          [['KC_LCTL', 'KC_LSFT', 'KC_ENT']],
        ],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
      };

      const file = createMockFile(JSON.stringify(dataWithStringKeycodes));
      const result = await fileService.loadFile(file);

      // Verify keymap was converted to numbers
      expect(result.keymap).toBeDefined();
      expect(result.keymap?.[0]).toBeDefined();
      expect(result.keymap?.[0][0]).toBeTypeOf('number');
      expect(result.keymap?.[0][1]).toBeTypeOf('number');
      expect(result.keymap?.[1][0]).toBeTypeOf('number');

      // KC_A should be 0x0004
      expect(result.keymap?.[0][0]).toBe(0x0004);
    });

    it('keeps numeric keycodes as parsed values', async () => {
      // .svil format stores keycodes as strings, they get parsed to numbers on import
      const dataWithKeycodes = {
        version: 1,
        uid: 12345,
        layout: [
          [['KC_A', 'KC_B', 'KC_C']], // KC_A=0x04, KC_B=0x05, KC_C=0x06
        ],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
      };

      const file = createMockFile(JSON.stringify(dataWithKeycodes));
      const result = await fileService.loadFile(file);

      expect(result.keymap?.[0][0]).toBe(0x0004);
      expect(result.keymap?.[0][1]).toBe(0x0005);
      expect(result.keymap?.[0][2]).toBe(0x0006);
    });
  });

  describe('kbinfoToSvil', () => {
    it('exports keymap as layout[layer][row][col] format', () => {
      const rows = 3;
      const cols = 4;
      const layers = 2;

      const kbinfo = createExportableKeyboardInfo({
        rows,
        cols,
        layers,
        keymap: [
          [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F],
          [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B],
        ],
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);

      expect(svil.layout).toBeDefined();
      expect(svil.layout.length).toBe(layers);
      expect(svil.layout[0].length).toBe(rows);
      expect(svil.layout[0][0].length).toBe(cols);
    });

    it('converts numeric keycodes to strings', () => {
      const kbinfo = createExportableKeyboardInfo({
        rows: 2,
        cols: 2,
        layers: 1,
        keymap: [[0x04, 0x05, 0x06, 0x07]], // KC_A, KC_B, KC_C, KC_D
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);

      // All values should be strings
      expect(typeof svil.layout[0][0][0]).toBe('string');
      expect(svil.layout[0][0][0]).toBe('KC_A');
    });

    it('preserves fragment selections in export', () => {
      const kbinfo = createExportableKeyboardInfo({
        rows: 4,
        cols: 4,
        layers: 1,
        keymap: [Array(16).fill(0x04)],
      });

      // Add fragments
      kbinfo.fragments = createTestFragments();
      kbinfo.composition = {
        instances: [
          {
            id: 'test_instance',
            fragment_options: [
              { fragment: FRAGMENT_NAMES.FINGER_5KEY, placement: { x: 0, y: 0 }, matrix_map: [[0, 0]], default: true },
              { fragment: FRAGMENT_NAMES.FINGER_6KEY, placement: { x: 0, y: 0 }, matrix_map: [[0, 0]] },
            ],
          },
        ],
      };
      kbinfo.fragmentState = createFragmentState({
        userSelections: [['test_instance', FRAGMENT_NAMES.FINGER_6KEY]],
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);

      expect(svil.fragment_selections).toBeDefined();
      expect(svil.fragment_selections['test_instance']).toBe(FRAGMENT_NAMES.FINGER_6KEY);
    });

    it('exports UID as unquoted large integer in JSON', () => {
      const kbinfo = createTestKeyboardInfo({
        rows: 2,
        cols: 2,
        layers: 1,
        keymap: [Array(4).fill(0x04)],
        kbid: 'FFFFFFFFFFFFFFFF', // Max 64-bit hex value
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);

      // UID should be an unquoted number (BigInt serialized as numeric literal)
      expect(svilJson).toContain('"uid":');
      // The BigInt value 0xFFFFFFFFFFFFFFFF = 18446744073709551615
      // Should be present as a numeric literal (not quoted string)
      expect(svilJson).toContain('18446744073709551615');
      // Verify it's not a quoted string
      expect(svilJson).not.toContain('"18446744073709551615"');
    });

    it('excludes macros when includeMacros=false', () => {
      const kbinfo = createExportableKeyboardInfo({
        rows: 2,
        cols: 2,
        layers: 1,
        keymap: [Array(4).fill(0x04)],
        macro_count: 5,
        macros: [
          { mid: 0, actions: [['text', 'hello']] },
          { mid: 1, actions: [['text', 'world']] },
        ] as any,
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, false);
      const svil = JSON.parse(svilJson);

      // Macros should be empty arrays
      expect(svil.macro.every((m: any[]) => m.length === 0)).toBe(true);
    });

    it('preserves non-ASCII macro text in backups', () => {
      const kbinfo = createExportableKeyboardInfo({
        rows: 2,
        cols: 2,
        layers: 1,
        keymap: [Array(4).fill(0x04)],
        macros: [
          { mid: 0, actions: [['text', 'hello\u00A0world\u2019s']] }, // Non-breaking space and smart quote
        ] as any,
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);

      // Backups must preserve the original text verbatim
      const macroText = svil.macro[0]?.[0]?.[1];
      expect(macroText).toBe('hello\u00A0world\u2019s');
      expect(fileService.parseContent(svilJson).macros?.[0].actions[0][1]).toBe(macroText);
    });

    it('exports fragment definitions and composition', () => {
      const kbinfo = createExportableKeyboardInfo({
        rows: 4,
        cols: 4,
        layers: 1,
        keymap: [Array(16).fill(0x04)],
      });

      kbinfo.fragments = createTestFragments();
      kbinfo.composition = {
        instances: [
          { id: 'test', fragment: FRAGMENT_NAMES.FINGER_5KEY, placement: { x: 0, y: 0 }, matrix_map: [[0, 0]] },
        ],
      };

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);

      expect(svil.fragments).toBeDefined();
      expect(Object.keys(svil.fragments).length).toBe(Object.keys(kbinfo.fragments).length);
      expect(svil.composition).toBeDefined();
      expect(svil.composition.instances.length).toBe(1);
    });
  });

  describe('svilToKBINFO', () => {
    it('imports layout[l][r][c] to flat keymap[l][r*cols+c]', () => {
      const svil = {
        version: 1,
        uid: 12345,
        layout: [
          [
            ['KC_A', 'KC_B', 'KC_C', 'KC_D'],
            ['KC_E', 'KC_F', 'KC_G', 'KC_H'],
          ],
        ],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.keymap.length).toBe(1); // 1 layer
      expect(kbinfo.keymap[0].length).toBe(8); // 2 rows * 4 cols
      expect(kbinfo.rows).toBe(2);
      expect(kbinfo.cols).toBe(4);
    });

    it('parses string keycodes to numeric', () => {
      const svil = {
        version: 1,
        uid: 12345,
        layout: [[['KC_A', 'KC_B']]],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.keymap[0][0]).toBe(0x04); // KC_A
      expect(kbinfo.keymap[0][1]).toBe(0x05); // KC_B
    });

    it('handles -1 as KC_NO', () => {
      const svil = {
        version: 1,
        uid: 12345,
        layout: [[[-1, 'KC_A', -1]]],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.keymap[0][0]).toBe(0); // KC_NO
      expect(kbinfo.keymap[0][1]).toBe(0x04); // KC_A
      expect(kbinfo.keymap[0][2]).toBe(0); // KC_NO
    });

    it('restores fragment selections from file', () => {
      const svil = {
        version: 1,
        uid: 12345,
        layout: [[['KC_A']]],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
        fragment_selections: {
          'left_finger': FRAGMENT_NAMES.FINGER_5KEY,
          'right_finger': FRAGMENT_NAMES.FINGER_6KEY,
        },
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.fragmentState).toBeDefined();
      expect(kbinfo.fragmentState.userSelections.get('left_finger')).toBe(FRAGMENT_NAMES.FINGER_5KEY);
      expect(kbinfo.fragmentState.userSelections.get('right_finger')).toBe(FRAGMENT_NAMES.FINGER_6KEY);
    });

    it('restores fragment definitions and composition', () => {
      const fragments = createTestFragments();
      const composition = {
        instances: [
          { id: 'test', fragment: FRAGMENT_NAMES.FINGER_5KEY, placement: { x: 0, y: 0 }, matrix_map: [[0, 0] as [number, number]] },
        ],
      };

      const svil = {
        version: 1,
        uid: 12345,
        layout: [[['KC_A']]],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
        fragments,
        composition,
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.fragments).toBeDefined();
      expect(Object.keys(kbinfo.fragments).length).toBe(Object.keys(fragments).length);
      expect(kbinfo.composition).toBeDefined();
      expect(kbinfo.composition.instances.length).toBe(1);
    });

    it('converts tap dance dict format correctly', () => {
      const svil = {
        version: 1,
        uid: 12345,
        layout: [[['KC_A']]],
        macro: [],
        tap_dance: [
          {
            on: true,
            on_tap: 'KC_A',
            on_hold: 'KC_B',
            on_double_tap: 'KC_C',
            on_tap_hold: 'KC_D',
            tapping_term: 200,
          },
        ],
        combo: [],
        key_override: [],
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.tapdances).toBeDefined();
      expect(kbinfo.tapdances[0].tap).toBe('KC_A');
      expect(kbinfo.tapdances[0].hold).toBe('KC_B');
      expect(kbinfo.tapdances[0].doubletap).toBe('KC_C');
      expect(kbinfo.tapdances[0].taphold).toBe('KC_D');
      expect(kbinfo.tapdances[0].tapping_term).toBe(200);
    });

    it('converts combo dict format correctly', () => {
      const svil = {
        version: 1,
        uid: 12345,
        layout: [[['KC_A']]],
        macro: [],
        tap_dance: [],
        combo: [
          {
            on: true,
            keys: ['KC_A', 'KC_B'],
            output: 'KC_C',
            combo_term: 50,
          },
        ],
        key_override: [],
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.combos).toBeDefined();
      expect(kbinfo.combos[0].keys).toEqual(['KC_A', 'KC_B']);
      expect(kbinfo.combos[0].output).toBe('KC_C');
      // ComboOptions: bit 15 = enabled, bits 0-14 = combo term.
      expect((kbinfo.combos[0].options & 0x8000) !== 0).toBe(true);
      expect(kbinfo.combos[0].options & 0x7FFF).toBe(50);
    });

    it('converts key override dict format correctly', () => {
      const svil = {
        version: 1,
        uid: 12345,
        layout: [[['KC_A']]],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [
          {
            on: true,
            trigger: 'KC_A',
            replacement: 'KC_B',
            layers: 0xFFFF,
            trigger_mods: 1,
            options: 0,
          },
        ],
      };

      const kbinfo = (fileService as any).svilToKBINFO(svil);

      expect(kbinfo.key_overrides).toBeDefined();
      expect(kbinfo.key_overrides[0].trigger).toBe('KC_A');
      expect(kbinfo.key_overrides[0].replacement).toBe('KC_B');
      // On/off lives only in options bit 7; "on": true defers to options.
      expect(kbinfo.key_overrides[0]).not.toHaveProperty('enabled');
      expect(kbinfo.key_overrides[0].options).toBe(0);
    });
  });

  describe('Round-trip Tests', () => {
    it('preserves all keymap data through svil export/import', () => {
      const rows = 5;
      const cols = 14;
      const layers = 4;
      const originalKeymap = generateComplexKeymap(rows, cols, layers);

      const kbinfo = createExportableKeyboardInfo({
        rows,
        cols,
        layers,
        keymap: originalKeymap,
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);
      const imported = (fileService as any).svilToKBINFO(svil);

      const importedKeymap = imported.keymap.map((layer: any[]) =>
        layer.map((k: any) => typeof k === 'string' ? keyService.parse(k) : k)
      );

      expect(importedKeymap.length).toBe(originalKeymap.length);
      for (let l = 0; l < originalKeymap.length; l++) {
        expect(importedKeymap[l].length).toBe(originalKeymap[l].length);
        for (let pos = 0; pos < originalKeymap[l].length; pos++) {
          expect(importedKeymap[l][pos]).toBe(originalKeymap[l][pos]);
        }
      }
    });

    it('preserves tap dance data through export/import', () => {
      const kbinfo = createExportableKeyboardInfo({
        rows: 2,
        cols: 2,
        layers: 1,
        keymap: [Array(4).fill(0x5740)], // TD(0)
        tapdance_count: 2,
        tapdances: [
          { idx: 0, tap: 'KC_A', hold: 'KC_B', doubletap: 'KC_C', taphold: 'KC_D', tapping_term: 200 },
          { idx: 1, tap: 'KC_E', hold: 'KC_F', doubletap: 'KC_G', taphold: 'KC_H', tapping_term: 150 },
        ] as any,
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);
      const imported = (fileService as any).svilToKBINFO(svil);

      expect(imported.tapdances.length).toBe(2);
      expect(imported.tapdances[0].tap).toBe('KC_A');
      expect(imported.tapdances[1].tap).toBe('KC_E');
    });

    it('preserves combo data through export/import', () => {
      // ComboOptions: bit 15 = enabled, bits 0-14 = combo term.
      const kbinfo = createExportableKeyboardInfo({
        rows: 2,
        cols: 2,
        layers: 1,
        keymap: [Array(4).fill(0x04)],
        combo_count: 2,
        combos: [
          { cmbid: 0, keys: ['KC_A', 'KC_B'], output: 'KC_C', options: 0x8000 | 50 },
          { cmbid: 1, keys: ['KC_D', 'KC_E'], output: 'KC_F', options: 75 },
        ] as any,
      });

      const svilJson = (fileService as any).kbinfoToSvil(kbinfo, true);
      const svil = JSON.parse(svilJson);

      // The intermediate file representation splits options into on + combo_term.
      expect(svil.combo[0].on).toBe(true);
      expect(svil.combo[0].combo_term).toBe(50);
      expect(svil.combo[1].on).toBe(false);
      expect(svil.combo[1].combo_term).toBe(75);

      const imported = (fileService as any).svilToKBINFO(svil);

      expect(imported.combos.length).toBe(2);
      expect(imported.combos[0].output).toBe('KC_C');
      expect((imported.combos[0].options & 0x8000) !== 0).toBe(true);
      expect(imported.combos[0].options & 0x7FFF).toBe(50);
      expect((imported.combos[1].options & 0x8000) !== 0).toBe(false);
      expect(imported.combos[1].options & 0x7FFF).toBe(75);
    });
  });

  describe('parseContent', () => {
    it('detects .svil format by uid + version', () => {
      const svilContent = JSON.stringify({
        version: 1,
        uid: 12345,
        layout: [[['KC_A', 'KC_B'], ['KC_C', 'KC_D']]],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
      });

      const kbinfo = (fileService as any).parseContent(svilContent);

      // parseContent converts decimal UID to hex string via BigInt
      expect(kbinfo.kbid).toBe('3039'); // 12345 decimal = 0x3039
      expect(kbinfo.rows).toBe(2);
      expect(kbinfo.cols).toBe(2);
    });

    it('detects .vil format by uid only', () => {
      const vilContent = JSON.stringify({
        uid: 12345,
        layout: [[['KC_A', 'KC_B'], ['KC_C', 'KC_D']]],
        macro: [],
        tap_dance: [],
        combo: [],
        key_override: [],
        settings: {},
      });

      const kbinfo = (fileService as any).parseContent(vilContent);

      // parseContent converts decimal UID to hex string via BigInt
      expect(kbinfo.kbid).toBe('3039'); // 12345 decimal = 0x3039
    });

    it('throws for unknown format', () => {
      const unknownContent = JSON.stringify({
        something: 'else',
        without: 'uid',
      });

      expect(() => (fileService as any).parseContent(unknownContent)).toThrow('Unknown file format');
    });
  });
});

describe('FileService .svil native format', () => {
  const layoutData = {
    version: 1,
    uid: 12345,
    layout: [[['KC_A', 'KC_B'], ['KC_C', 'KC_D']]],
    macro: [],
    tap_dance: [],
    combo: [],
    key_override: [],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads a legacy .viable-named file (detection is content-based)', async () => {
    const file = createMockFile(JSON.stringify(layoutData), 'old-layout.viable');
    const result = await fileService.loadFile(file);
    expect(result.kbid).toBe('3039');
    expect(result.rows).toBe(2);
  });

  it('exports with a .svil suggested name and .svil accept type', async () => {
    const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(writable) });
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);

    await fileService.downloadSvil(createExportableKeyboardInfo(), true);
    await fileService.downloadSvil(createExportableKeyboardInfo(), false);

    expect(showSaveFilePicker).toHaveBeenCalledTimes(2);
    const [withMacros, noMacros] = showSaveFilePicker.mock.calls.map((c) => c[0]);
    expect(withMacros.suggestedName).toBe('keyboard.svil');
    expect(noMacros.suggestedName).toBe('keyboard-nomacro.svil');
    expect(withMacros.types[0].accept).toEqual({ 'application/json': ['.svil'] });
    expect(JSON.stringify(withMacros)).not.toContain('.viable');
    expect(writable.write).toHaveBeenCalledTimes(2);
  });
});

describe('FileService legacy viable_protocol key', () => {
  const layout = [[['KC_A', 'KC_B'], ['KC_C', 'KC_D']]];

  it('loads a file that still carries the viable_protocol key', async () => {
    const file = createMockFile(
      JSON.stringify({ uid: 12345, viable_protocol: 1, layout, macro: [], tap_dance: [], combo: [], key_override: [] }),
      'old-layout.viable',
    );
    const result = await fileService.loadFile(file);
    expect(result.kbid).toBe('3039');
    expect(result.svil_proto).toBe(1);
  });

  it('exports svil_protocol and never viable_protocol', () => {
    const json = fileService.kbinfoToSvil(createExportableKeyboardInfo(), true);
    expect(json).toContain('"svil_protocol"');
    expect(json).not.toContain('viable_protocol');
  });
});
