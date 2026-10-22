// Key service - keycode parsing and stringifying
import { CODEMAP, KEYMAP, KEYALIASES } from '../constants/keygen';
// Numbers the tables above for the newest known QMK keycode version on import.
import '../constants/keycode-numbering';
import type { KeyString, KeyMapEntry } from '../types/keymap';
import type { KeyboardInfo } from '../types/keyboard.types';
import { customKeycodeShortName } from '../constants/custom-keycode-labels';

interface KeyParseDesc {
  type: 'layer' | 'macro' | 'tapdance' | 'key';
  mask?: string;
  idx?: number;
  str?: string;
  title?: string;
}

export class KeyService {
  public localization: string = 'english_us';

  /**
   * Update keymap with custom keycodes from keyboard
   */
  generateAllKeycodes(kbinfo: KeyboardInfo): void {
    // Populate USER00...USER63 keys as needed (legacy Vial range: 0x7e00+)
    for (let i = 0; i < 64; i++) {
      const userkey = 'USER' + ('' + i).padStart(2, '0');
      const code = KEYMAP[userkey].code;
      if (kbinfo.custom_keycodes && kbinfo.custom_keycodes[i]) {
        const custom = kbinfo.custom_keycodes[i];
        KEYMAP[userkey] = {
          code,
          qmkid: custom.name,
          str: customKeycodeShortName(custom),
          title: custom.title,
        };
        KEYMAP[custom.name] = {
          code,
          qmkid: custom.name,
          str: customKeycodeShortName(custom),
          title: custom.title,
        };
        KEYALIASES[custom.name] = userkey;
        // Update CODEMAP so stringify() returns the custom name
        CODEMAP[code] = custom.name;
      }
    }

    // Also populate QK_USER...QK_USER_31 keys (QMK range: 0x7e40+)
    // These are the keycodes that Svil/QMK firmware actually uses
    for (let i = 0; i < 32; i++) {
      const qkUserKey = i === 0 ? 'QK_USER' : `QK_USER_${i}`;
      const code = 0x7e40 + i; // QK_USER base is 0x7e40
      if (kbinfo.custom_keycodes && kbinfo.custom_keycodes[i]) {
        const custom = kbinfo.custom_keycodes[i];
        KEYMAP[qkUserKey] = {
          code,
          qmkid: custom.name,
          str: customKeycodeShortName(custom),
          title: custom.title,
        };
        // Also register by custom name
        KEYMAP[custom.name] = {
          code,
          qmkid: custom.name,
          str: customKeycodeShortName(custom),
          title: custom.title,
        };
        KEYALIASES[custom.name] = qkUserKey;
        // Update CODEMAP so stringify() returns the custom name
        CODEMAP[code] = custom.name;
      }
    }

    // Add 'type' and 'idx' to everything we can customize
    // 256 max macros (M0-M127 at QK_MACRO 0x7700, M128-M255 at 0x7680)
    for (let i = 0; i < 256; i++) {
      KEYMAP['M' + i].type = 'macro';
      KEYMAP['M' + i].idx = i;
    }

    // 32 max layers
    for (let i = 0; i < 32; i++) {
      for (const k of ['MO', 'DF', 'TG', 'TT', 'OSL', 'TO']) {
        const key = `${k}(${i})`;
        KEYMAP[key].type = 'layer';
        KEYMAP[key].subtype = k;
        KEYMAP[key].idx = i;
      }
      // Alias persistent default layer to DF until keygen provides PDF codes
      KEYALIASES[`PDF(${i})`] = `DF(${i})`;
    }

    // Assign types to other special keys
    KEYMAP['QK_ALT_REPEAT_KEY'].type = 'altrepeat';

    // 256 tap dances
    for (let i = 0; i < 256; i++) {
      const key = `TD(${i})`;
      KEYMAP[key].type = 'tapdance';
      KEYMAP[key].idx = i;
    }
  }

  /**
   * Convert a keynum to a string. e.g: 0x0004 -> 'KC_A', 0x0104 -> "LCTRL(KC_A)"
   */
  stringify(keynum: number): string {
    if (keynum === undefined || keynum === null) {
      return "0x0000";
    }
    const modmask = keynum & 0xff00;
    const keyid = keynum & 0x00ff;
    const modMaskStr = modmask in CODEMAP ? (CODEMAP[modmask] as string) : "";
    if (modmask !== 0 && keyid === 0 && modMaskStr && modMaskStr.match(/^(\w+)\(kc\)/)) {
      if (modMaskStr === "ALL_T(kc)") {
        return "HYPR_T(KC_NO)";
      }
      return modMaskStr.replace(/\(kc\)/, "(KC_NO)");
    }
    // Check full keycode first (handles OSM, special keycodes that aren't mod+key combos)
    if (keynum in CODEMAP) {
      return CODEMAP[keynum] as string;
    }

    if (modmask !== 0 && keyid in CODEMAP) {
      const kcstr = CODEMAP[keyid];
      const maskstr = CODEMAP[modmask] as string;
      if (!maskstr) {
        return '0x' + keynum.toString(16).padStart(4, '0');
      }
      if (maskstr.match(/^(\w+)\(kc\)/)) {
        if (maskstr === "ALL_T(kc)") {
          return `HYPR_T(${kcstr})`;
        }
        return maskstr.replace(/\(kc\)/, '(' + kcstr + ')');
      } else if (keyid === 0) {
        return maskstr;
      } else {
        return '0x' + keynum.toString(16).padStart(4, '0');
      }
    }

    return `0x${keynum.toString(16)}`;
  }

  /**
   * Convert keystring to keynum. e.g: "KC_A" -> 0x0004, "LCTRL(KC_A)" -> 0x0104
   */
  parse(keystr: KeyString): number {
    if (!keystr || keystr === -1 || keystr === 0xff) {
      return 0xff;
    }

    if (keystr in KEYALIASES) {
      keystr = KEYALIASES[keystr];
    }

    if (keystr in KEYMAP) {
      return KEYMAP[keystr].code;
    }

    if (typeof keystr === 'number') {
      return keystr;
    }

    const match = keystr.match(/^(\w+)\((\w+)\)$/);
    if (match) {
      let maskKey = match[1] + '(kc)';
      if (maskKey in KEYALIASES) {
        maskKey = KEYALIASES[maskKey] as string;
      }
      const cMask = KEYMAP[maskKey]?.code;
      if (cMask !== undefined) {
        let keyPart = match[2];
        if (keyPart === 'kc') {
          keyPart = 'KC_NO';
        }
        if (keyPart in KEYALIASES) {
          keyPart = KEYALIASES[keyPart] as string;
        }
        if (keyPart in KEYMAP) {
          const keymask = KEYMAP[keyPart].code;
          return cMask + keymask;
        }
      }
    }

    return parseInt(keystr);
  }

  /**
   * Return a key definition for a given keystr
   */
  define(keystr: KeyString | number): KeyMapEntry | undefined {
    const orig = keystr;

    if (typeof keystr === 'string' && keystr.match(/^0x\w+$/)) {
      keystr = parseInt(keystr, 16);
    }

    if (typeof keystr === 'number' || (typeof keystr === 'string' && keystr.match(/^\d+$/))) {
      keystr = parseInt(keystr as string);
    }

    if (typeof keystr === 'number' && keystr in CODEMAP) {
      keystr = CODEMAP[keystr];
    }

    keystr = this.canonical(keystr as string);

    if (keystr in KEYMAP) {
      return KEYMAP[keystr];
    }

    console.log('Unknown keystr', orig, keystr);
    return undefined;
  }

  /**
   * Get canonical key string (resolve aliases)
   */
  canonical(keystr: KeyString): KeyString {
    if (!keystr && keystr !== 0) {
      return keystr;
    }
    if (typeof keystr === 'number') {
      return keystr;
    }
    if (keystr.match(/^0x/)) {
      return keystr;
    }
    if (keystr in KEYALIASES) {
      return KEYALIASES[keystr];
    }
    const match = keystr.match(/^(\w+)\((\w+)\)$/);
    if (match) {
      const wrapper = match[1];
      const inner = match[2];
      const canonInner = inner in KEYALIASES ? KEYALIASES[inner] : inner;
      return `${wrapper}(${canonInner})`;
    }
    return keystr;
  }

  /**
   * Parse key description for UI display
   */
  parseDesc(keystr: KeyString): KeyParseDesc {
    if (keystr in KEYALIASES) {
      keystr = KEYALIASES[keystr];
    }

    let m;

    if (typeof keystr === 'number') {
      keystr = `0x${keystr.toString(16).padStart(2, '0')}`;
    }

    // Layers: MO(0) ... MO(15)
    m = keystr.match(/^(MO|DF|TG|TT|OSL|TO)\((\w+)\)$/);
    if (m) {
      return {
        type: 'layer',
        mask: m[1],
        idx: parseInt(m[2]),
      };
    }

    // Macros: M0 ... M50
    m = keystr.match(/^M(\d+)$/);
    if (m) {
      return {
        type: 'macro',
        mask: 'M',
        idx: parseInt(m[1]),
      };
    }

    // Tap Dances
    m = keystr.match(/^TD\((\d+)\)$/);
    if (m) {
      return {
        type: 'tapdance',
        mask: 'TD',
        idx: parseInt(m[1]),
      };
    }

    // HOLD-Tap keys
    m = keystr.match(/^(\w+)\((\w+)\)$/);
    if (m) {
      let mod = KEYMAP[m[1] + '(kc)'];
      if (!mod) {
        mod = KEYMAP[m[1]];
        if (mod && mod.qmkid in KEYALIASES) {
          const alias = KEYALIASES[mod.qmkid];
          mod = KEYMAP[alias];
        }
      } else if (mod && mod.qmkid in KEYALIASES) {
        const alias = KEYALIASES[mod.qmkid];
        mod = KEYMAP[alias];
      }
      if (mod) {
        let keyPart = m[2];
        if (keyPart === 'kc') {
          keyPart = 'KC_NO';
        }
        const key = KEYMAP[keyPart];
        if (key) {
          return {
            type: 'key',
            str: mod.str.replace(/\(kc\)/, '') + key.str,
            title: key.title,
          };
        }
      }
    }

    // Normal keys
    if (keystr in KEYMAP) {
      const key = KEYMAP[keystr];
      return {
        type: 'key',
        str: key.str,
        title: key.title,
      };
    }

    if (keystr.match(/^0x/)) {
      return {
        type: 'key',
        str: keystr,
      };
    }

    // Unknown
    return {
      type: 'key',
      str: '<span style="color: red; font-weight: bold;">?? BROKEN ??</span>',
      title: keystr,
    };
  }

  /**
   * Convert keymap integers to strings
   */
  stringifyKeymap(keymapint: number[][]): KeyString[][] {
    const ret: KeyString[][] = [];
    for (const layer of keymapint) {
      const l: KeyString[] = [];
      for (const key of layer) {
        if (key === 0xff) {
          l.push('-1');
        } else {
          l.push(this.stringify(key));
        }
      }
      ret.push(l);
    }
    return ret;
  }

  /**
   * Convert keymap strings to integers
   */
  parseKeymap(keymapstr: KeyString[][][]): number[][] {
    const ret: number[][] = [];
    for (const layer of keymapstr) {
      const l: number[] = [];
      for (const row of layer) {
        for (const col of row) {
          if (!col) {
            l.push(0xff);
          } else if (col === 0xff) {
            l.push(0xff);
          } else {
            l.push(this.parse(col));
          }
        }
      }
      ret.push(l);
    }
    return ret;
  }

}

// Export singleton instance
export const keyService = new KeyService();
