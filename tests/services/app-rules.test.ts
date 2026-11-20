// App rules (Sval 0x40, 0x41): app IDs, the record, chunked reads and writes against the
// simulated board at both report lengths, statuses, and the .svil and import paths.
// svalboard/qmk keyboards/svalboard/docs/protocol.md, "App rules".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankBoard } from "@/dev/fake-board/board";
import { FakeSvalFirmware, FLAG5_APP_RULES } from "@/dev/fake-board/firmware";
import {
    APP_RULE_OFF, APP_RULE_SITE, APP_RULE_TEXT_MAX, APP_RULES_BEGIN, APP_RULES_COMMIT, APP_RULES_INFO, APP_RULES_READ,
    APP_RULES_RECORD_BYTES, APP_RULES_WRITE, AppRulesError, CMD_SVIL_APP_FOREGROUND, CMD_SVIL_APP_RULES, appId, appIdHex,
    appLayersEnabledFromSvil, appRulesFromSvil, appRulesToSvil, chunkSize, cycleMask, hasAppRules, maskState, parseRecord,
    readAppForeground, readAppRules, readAppRulesInfo, recordUsed, ruleOn, sameRules, serializeRecord, truncateUtf8, withApp,
    withRuleOn, writeAppRules, type AppRulesLink,
} from "@/services/app-rules";
import { SvilUSB } from "@/services/usb.service";
import { importService } from "@/services/import.service";
import { prepareImport } from "@/services/import-preflight";
import type { AppRule, KeyboardInfo } from "@/types/keyboard.types";
import { APP_RULE_KEYS_STORAGE, appKeyFor, rememberAppKey } from "@/utils/app-rule-keys";

const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** A link to the simulated board through the client wrapper, with reports of `reportLength` bytes. */
function fakeLink(reportLength: number, fw = new FakeSvalFirmware(blankBoard())) {
    let id = 0;
    for (let seed = 1; !id; seed++) {
        const req = new Uint8Array(reportLength);
        req[0] = 0xdd;
        for (let i = 0; i < 20; i++) req[5 + i] = (i * 37 + seed) & 0xff;
        id = le32(fw.receive(req)!, 25);
    }
    const sent: number[][] = [];
    const link: AppRulesLink = {
        reportLength,
        async sendSvil(cmd, args) {
            const payload = [cmd, ...args];
            if (6 + payload.length > reportLength) throw new Error(`request of ${payload.length} bytes does not fit a ${reportLength}-byte report`);
            sent.push(payload);
            const req = new Uint8Array(reportLength);
            req[0] = 0xdd;
            req[1] = id & 0xff; req[2] = (id >>> 8) & 0xff; req[3] = (id >>> 16) & 0xff; req[4] = id >>> 24;
            req[5] = 0xdf;
            req.set(payload, 6);
            const reply = fw.receive(req)!;
            if (reply[5] === 0xff) throw new Error(`wrapper error ${reply[6]}`);
            return reply.slice(6);
        },
    };
    return { fw, link, sent };
}

const rule = (over: Partial<AppRule> = {}): AppRule => ({ appId: appId("notepad.exe"), defaultLayer: null, frontLayer: null, onMask: 0, offMask: 0, flags: 0, text: "notepad.exe", ...over });
const rules = (r: Uint8Array) => parseRecord(r).rules;

describe("app IDs", () => {
    it("match the protocol's test values", () => {
        expect(appId("notepad.exe")).toBe(0xb884a32c);
        expect(appId("Notepad.EXE")).toBe(0xb884a32c);
        expect(appId("chrome.exe")).toBe(0xfc0c788d);
        expect(appId("com.apple.Safari")).toBe(0xece537f6);
        expect(appId("firefox")).toBe(0xf4d4d03a);
    });

    it("drop spaces and tabs at the ends, lower ASCII only; empty is 0", () => {
        expect(appId(" \tnotepad.exe\t ")).toBe(0xb884a32c);
        expect(appId("")).toBe(0);
        expect(appId(" \t ")).toBe(0);
        // Non-ASCII letters keep their case.
        expect(appId("É.exe")).not.toBe(appId("é.exe"));
        expect(appIdHex(0xb884a32c)).toBe("B884A32C");
    });

    it("text cut at 64 UTF-8 bytes, never inside a character", () => {
        expect(truncateUtf8("com.apple.Safari")).toBe("com.apple.Safari");
        expect(truncateUtf8("é".repeat(40))).toBe("é".repeat(32)); // 64 bytes; a 33rd would make 66
        expect(truncateUtf8("ééé", 5)).toBe("éé");
        expect(APP_RULE_TEXT_MAX).toBe(64);
    });
});

describe("the record", () => {
    it("round trips the header and packed rules, full text included", () => {
        const list = [rule({ defaultLayer: 2, frontLayer: 5, onMask: 0b1010, offMask: 0x4001, text: "notepad.exe" }), rule({ appId: appId("firefox"), text: "ééééééé" })];
        const bytes = serializeRecord(list);
        expect(bytes.length).toBe(4 + 12 + 11 + 12 + 14);
        expect(recordUsed(list)).toBe(bytes.length);
        expect(Array.from(bytes.subarray(0, 4))).toEqual([2, 2, 0, 0]);
        expect(Array.from(bytes.subarray(4, 8))).toEqual([0x2c, 0xa3, 0x84, 0xb8]);
        expect(bytes[4 + 4]).toBe(2);
        expect(bytes[4 + 11]).toBe(11); // text length
        expect(new TextDecoder().decode(bytes.subarray(16, 27))).toBe("notepad.exe");
        expect(bytes[27 + 4]).toBe(0xff); // the second rule: no default layer
        const back = parseRecord(bytes);
        expect(back.enabled).toBe(true);
        expect(back.rules[0]).toEqual({ ...list[0] });
        expect(back.rules[1].text).toBe("ééééééé");
        expect(sameRules(back.rules, list)).toBe(true);
    });

    it("keeps a long site whole", () => {
        const long = "a-rather-long-subdomain.practice.svalboard.com";
        const [back] = rules(serializeRecord([rule({ text: long, flags: APP_RULE_SITE })]));
        expect(back.text).toBe(long);
        expect(back.flags).toBe(APP_RULE_SITE);
    });

    it("the App Layers switch is header byte 2 bit 0", () => {
        const off = serializeRecord([rule()], false);
        expect(off[2]).toBe(1);
        expect(parseRecord(off).enabled).toBe(false);
        expect(parseRecord(serializeRecord([rule()], true)).enabled).toBe(true);
        expect(parseRecord(serializeRecord([], false))).toEqual({ rules: [], enabled: false });
    });

    it("a rule is on unless its flags say off; a new one is on", () => {
        const r = rule();
        expect(ruleOn(r)).toBe(true);
        const off = withRuleOn(r, false);
        expect(off.flags & APP_RULE_OFF).toBe(APP_RULE_OFF);
        const [back] = rules(serializeRecord([off]));
        expect(ruleOn(back)).toBe(false);
        expect(ruleOn(withRuleOn(back, true))).toBe(true);
        expect(withApp(rule({ flags: APP_RULE_SITE }), "x.exe").flags).toBe(0);
    });

    it("a record never stored has no rules and App Layers on; format 1 asks for newer firmware; too many rules is refused", () => {
        expect(parseRecord(new Uint8Array(APP_RULES_RECORD_BYTES))).toEqual({ rules: [], enabled: true });
        expect(() => parseRecord(Uint8Array.from([1, 1, 0, 0]))).toThrow(/shorter than its count/);
        expect(() => parseRecord(Uint8Array.from([3, 0, 0, 0]))).toThrow(/format 3/);
        expect(() => parseRecord(Uint8Array.from([2, 65, 0, 0]))).toThrow(/65 rules/);
        expect(() => parseRecord(Uint8Array.from([2, 1, 0, 0, 1, 2, 3]))).toThrow(/shorter/);
        expect(() => serializeRecord(Array.from({ length: 65 }, () => rule()))).toThrow(/at most 64/);
    });

    it("refuses a record past the board's 1792 bytes; 64 rules of 15-byte names fit", () => {
        expect(APP_RULES_RECORD_BYTES).toBe(1792);
        const fits = Array.from({ length: 64 }, (_, i) => rule({ text: `appnumber-${String(i).padStart(2, "0")}.ex` }));
        expect(recordUsed(fits)).toBe(4 + 64 * (12 + 15));
        expect(() => serializeRecord(fits)).not.toThrow();
        const big = Array.from({ length: 30 }, (_, i) => rule({ text: `${"x".repeat(60)}${i}` }));
        expect(recordUsed(big)).toBeGreaterThan(1792);
        expect(() => serializeRecord(big)).toThrow(/more than the board's 1792/);
    });
});

describe("layer pills", () => {
    it("cycle neutral, on, off, neutral; off wins", () => {
        let r = rule();
        expect(maskState(r, 3)).toBe("neutral");
        r = cycleMask(r, 3);
        expect([maskState(r, 3), r.onMask, r.offMask]).toEqual(["on", 8, 0]);
        r = cycleMask(r, 3);
        expect([maskState(r, 3), r.onMask, r.offMask]).toEqual(["off", 0, 8]);
        r = cycleMask(r, 3);
        expect([maskState(r, 3), r.onMask, r.offMask]).toEqual(["neutral", 0, 0]);
        expect(maskState({ onMask: 1, offMask: 1 }, 0)).toBe("off");
        expect(cycleMask(r, 16)).toBe(r);
        expect(cycleMask(r, 15)).toBe(r); // the auto mouse layer is never masked
    });

    it("never sends the auto mouse layer's mask bits, from any source", () => {
        const bytes = serializeRecord([rule({ onMask: 0xffff, offMask: 0x8001 })]);
        expect([bytes[4 + 6] | (bytes[4 + 7] << 8), bytes[4 + 8] | (bytes[4 + 9] << 8)]).toEqual([0x7fff, 0x0001]);
        const raw = serializeRecord([rule()]);
        raw[4 + 7] = 0x80;
        expect(rules(raw)[0].onMask).toBe(0);
        expect(appRulesFromSvil([{ app_id: 5, on_mask: 0x8003 }])![0].onMask).toBe(3);
    });
});

describe("requests against the simulated board", () => {
    it("the command numbers match SvilUSB", () => {
        expect(SvilUSB.CMD_SVIL_APP_FOREGROUND).toBe(CMD_SVIL_APP_FOREGROUND);
        expect(SvilUSB.CMD_SVIL_APP_RULES).toBe(CMD_SVIL_APP_RULES);
    });

    it("feature bit: GET_INFO byte 22 bit 0 on firmware with app rules only", async () => {
        expect(hasAppRules(FLAG5_APP_RULES)).toBe(true);
        expect(hasAppRules(0x02)).toBe(false);
        expect(hasAppRules(undefined)).toBe(false);
        for (const appRules of [true, false]) {
            const { link } = fakeLink(64, new FakeSvalFirmware(blankBoard(), { appRules }));
            const info = await link.sendSvil(0x00, [], { uint8: true });
            // After the command echo: byte 22 of GET_INFO counting the 0xDF prefix.
            expect(hasAppRules(info[21])).toBe(appRules);
        }
    });

    it("INFO describes the record", async () => {
        const { link } = fakeLink(64);
        expect(await readAppRulesInfo(link)).toEqual({ format: 2, max: 64, ruleHeadBytes: 12, count: 0, recordBytes: 1792, chunk: 48, layers: 16, used: 0, textMax: 64, headerFlags: 0 });
        expect(await readAppRules(link)).toMatchObject({ rules: [], enabled: true });
        await writeAppRules(link, [rule()], false);
        expect(await readAppRulesInfo(link)).toMatchObject({ count: 1, used: 4 + 12 + 11, headerFlags: 1 });
    });

    it.each([[64, 48], [32, 20]])("writes and reads back in chunks with %i-byte reports (%i bytes each)", async (length, chunk) => {
        const { fw, link, sent } = fakeLink(length);
        expect(chunkSize(link)).toBe(chunk);
        const list = [rule({ defaultLayer: 1, frontLayer: 3, onMask: 0b100, offMask: 0b10 }), rule({ appId: appId("firefox"), text: "firefox" }), rule({ appId: appId("com.apple.Safari"), text: "com.apple.Safari" })];
        const size = recordUsed(list);
        expect(await writeAppRules(link, list)).toBe(3);
        const writes = sent.filter((p) => p[1] === APP_RULES_WRITE);
        expect(writes.length).toBe(Math.ceil(size / chunk));
        expect(writes.every((p) => p[4] <= chunk)).toBe(true);
        expect(fw.appRulesOps.slice(0, 2)).toEqual([APP_RULES_INFO, APP_RULES_BEGIN]); // INFO: only format 2 takes writes
        expect(fw.appRulesOps.at(-1)).toBe(APP_RULES_COMMIT);
        expect(Array.from(fw.state.appRules.subarray(0, 4))).toEqual([2, 3, 0, 0]);
        sent.length = 0;
        const { rules: back } = await readAppRules(link);
        expect(back).toEqual(list);
        expect(sent[0]).toEqual([CMD_SVIL_APP_RULES, APP_RULES_INFO]);
        expect(sent.filter((p) => p[1] === APP_RULES_READ).length).toBe(Math.ceil(size / chunk));
    });

    it("a full list of 64 round trips over 32-byte reports; a shorter list zeroes the rest", async () => {
        const { fw, link } = fakeLink(32);
        const list = Array.from({ length: 64 }, (_, i) => rule({ appId: appId(`app${i}.exe`), text: `app${i}.exe`, onMask: (i * 511) & 0x7fff, defaultLayer: i % 16 }));
        await writeAppRules(link, list);
        expect((await readAppRules(link)).rules).toEqual(list);
        await writeAppRules(link, list.slice(0, 1));
        expect(fw.state.appRules.subarray(4 + 12 + 8).every((b) => b === 0)).toBe(true);
        expect((await readAppRules(link)).rules).toEqual(list.slice(0, 1));
    });

    it("STATUS names the rule that applies to the app in front", async () => {
        const { fw, link } = fakeLink(64);
        await writeAppRules(link, [rule({ appId: appId("firefox") }), rule({ frontLayer: 4, onMask: 2 })]);
        expect((await readAppForeground(link)).rule).toBeNull();
        const id = appId("notepad.exe");
        await link.sendSvil(CMD_SVIL_APP_FOREGROUND, [1, id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, id >>> 24, 0], { uint8: true });
        expect(fw.appForeground).toBe(id);
        expect(await readAppForeground(link)).toMatchObject({ appId: id, rule: 1, frontLayer: 4, onMask: 2, flags: 1, enabled: true });
    });

    it("a rule that is off never applies; the next one for the app does", async () => {
        const { link } = fakeLink(64);
        const id = appId("notepad.exe");
        await writeAppRules(link, [withRuleOn(rule({ frontLayer: 2 }), false), rule({ frontLayer: 4 })]);
        await link.sendSvil(CMD_SVIL_APP_FOREGROUND, [1, id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, id >>> 24, 0], { uint8: true });
        expect(await readAppForeground(link)).toMatchObject({ rule: 1, frontLayer: 4 });
    });

    it("App Layers off: no rule applies, STATUS says so, and the rules stay", async () => {
        const { link } = fakeLink(64);
        const id = appId("notepad.exe");
        await writeAppRules(link, [rule({ frontLayer: 4 })], false);
        await link.sendSvil(CMD_SVIL_APP_FOREGROUND, [1, id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, id >>> 24, 0], { uint8: true });
        expect(await readAppForeground(link)).toMatchObject({ rule: null, frontLayer: null, enabled: false });
        expect(await readAppRules(link)).toMatchObject({ enabled: false, rules: [rule({ frontLayer: 4 })] });
        await writeAppRules(link, [rule({ frontLayer: 4 })], true);
        expect(await readAppForeground(link)).toMatchObject({ rule: 0, frontLayer: 4, enabled: true });
    });

    it("a format 1 record (never released) is upgraded: labels become text, App Layers on", async () => {
        const board = blankBoard();
        const v1 = board.appRules;
        v1[0] = 1; v1[1] = 2;
        const put = (i: number, id: number, label: string) => {
            const o = 4 + i * 24;
            v1[o] = id & 0xff; v1[o + 1] = (id >>> 8) & 0xff; v1[o + 2] = (id >>> 16) & 0xff; v1[o + 3] = id >>> 24;
            v1[o + 4] = 1; v1[o + 5] = 0xff;
            v1.set(new TextEncoder().encode(label), o + 11);
        };
        put(0, appId("notepad.exe"), "notepad.exe");
        put(1, appId("site:practice.svalboard.com"), "…lboard.com");
        const { link } = fakeLink(64, new FakeSvalFirmware(board));
        const back = await readAppRules(link);
        expect(back.enabled).toBe(true);
        expect(back.rules.map((r) => [r.text, r.flags, r.defaultLayer])).toEqual([["notepad.exe", 0, 1], ["…lboard.com", APP_RULE_SITE, 1]]);
    });

    it("STATUS reports the layers in use with the rule applied, the mouse layer left alone", async () => {
        const { fw, link } = fakeLink(64);
        await writeAppRules(link, [rule({ appId: appId("notepad.exe"), defaultLayer: 1, frontLayer: 4, onMask: 0x8002, offMask: 0x8008 })]);
        fw.layerState = (1 << 3) | (1 << 5) | (1 << 15);
        const id = appId("notepad.exe");
        await link.sendSvil(CMD_SVIL_APP_FOREGROUND, [1, id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, id >>> 24, 0], { uint8: true });
        const s = await readAppForeground(link);
        expect(s.onMask).toBe(0x0002);
        expect(s.offMask).toBe(0x0008);
        expect(s.userLayers).toBe((1 << 3) | (1 << 5) | (1 << 15));
        expect(s.layers).toBe((1 << 1) | (1 << 4) | (1 << 5) | (1 << 15));
        expect(s.defaultState).toBe(1 << 1);
    });

    it("firmware without the command (0xFF echo) throws, and so does a nonzero status", async () => {
        const { link } = fakeLink(64, new FakeSvalFirmware(blankBoard(), { appRules: false }));
        await expect(readAppRules(link)).rejects.toThrow(/doesn't know command 0x41/);
        const refused = (op: number, status: number): AppRulesLink => ({
            reportLength: 64,
            sendSvil: async (cmd, args) => (args[0] === op ? Uint8Array.from([cmd, op, status, 0])
                : args[0] === APP_RULES_INFO ? Uint8Array.from([cmd, 0, 0, 2, 64, 12, 0, 0, 7, 48, 16, 4, 0, 64, 0]) : Uint8Array.from([cmd, args[0], 0, 0])),
        });
        await expect(writeAppRules(refused(APP_RULES_COMMIT, 5), [rule()])).rejects.toMatchObject({ name: "AppRulesError", status: 5 });
        await expect(writeAppRules(refused(APP_RULES_COMMIT, 4), [rule()])).rejects.toThrow(/invalid/);
        await expect(writeAppRules(refused(APP_RULES_BEGIN, 2), [rule()])).rejects.toBeInstanceOf(AppRulesError);
        await expect(readAppRulesInfo(refused(APP_RULES_INFO, 3))).rejects.toThrow(/too short/);
    });

    it("COMMIT of an edit copy that isn't a valid format 2 record changes nothing (status 4)", async () => {
        const { fw, link } = fakeLink(64);
        await writeAppRules(link, [rule()]);
        const before = fw.state.appRules.slice();
        await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_BEGIN], { uint8: true });
        await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_WRITE, 0, 0, 4, 1, 1, 0, 0], { uint8: true });
        const reply = await link.sendSvil(CMD_SVIL_APP_RULES, [APP_RULES_COMMIT], { uint8: true });
        expect(reply[2]).toBe(4);
        expect(fw.state.appRules).toEqual(before);
    });

    it("the simulated board keeps the rules across a reload", async () => {
        const { serializeBoard, deserializeBoard } = await import("@/dev/fake-board/board");
        const { fw, link } = fakeLink(64);
        await writeAppRules(link, [rule({ text: "kept.exe" })]);
        const again = deserializeBoard(serializeBoard(fw.state))!;
        expect(rules(again.appRules)[0].text).toBe("kept.exe");
    });
});

describe("a board with the first record format", () => {
    /** A format 1 board as the first app rules firmware stored it. */
    function v1Board() {
        const board = blankBoard();
        const v1 = board.appRules;
        v1[0] = 1; v1[1] = 3;
        const put = (i: number, id: number, label: string, dl: number, fl: number, on: number) => {
            const o = 4 + i * 24;
            v1[o] = id & 0xff; v1[o + 1] = (id >>> 8) & 0xff; v1[o + 2] = (id >>> 16) & 0xff; v1[o + 3] = id >>> 24;
            v1[o + 4] = dl; v1[o + 5] = fl; v1[o + 6] = on & 0xff; v1[o + 7] = on >> 8; v1[o + 8] = 0; v1[o + 9] = 0;
            v1.set(new TextEncoder().encode(label), o + 11);
        };
        put(0, appId("notepad.exe"), "notepad.exe", 1, 0xff, 0);
        put(1, appId("site:onshape.com"), "onshape.com", 0xff, 3, 0b100);
        put(2, appId("site:practice.svalboard.com"), "…lboard.com", 2, 0xff, 0);
        return board;
    }

    it("reads its rules: labels as text, sites marked, IDs kept, App Layers on; writes are refused", async () => {
        const { link, fw } = fakeLink(64, new FakeSvalFirmware(v1Board(), { appRulesFormat: 1 }));
        const back = await readAppRules(link);
        expect(back.info.format).toBe(1);
        expect(back.enabled).toBe(true);
        expect(back.rules.map((r) => [r.appId, r.text, r.flags, r.defaultLayer, r.frontLayer, r.onMask])).toEqual([
            [appId("notepad.exe"), "notepad.exe", 0, 1, null, 0],
            [appId("site:onshape.com"), "onshape.com", APP_RULE_SITE, null, 3, 0b100],
            [appId("site:practice.svalboard.com"), "…lboard.com", APP_RULE_SITE, 2, null, 0],
        ]);
        const before = fw.state.appRules.slice();
        await expect(writeAppRules(link, back.rules)).rejects.toThrow(/Update the firmware to edit App Layers/);
        expect(fw.state.appRules).toEqual(before);
    });

    it("survives a firmware update: backup on format 1, restore onto a format 2 board, same IDs, layers and text", async () => {
        const { fileService } = await import("@/services/file.service");
        const { link: oldLink } = fakeLink(64, new FakeSvalFirmware(v1Board(), { appRulesFormat: 1 }));
        const old = await readAppRules(oldLink);
        const oldKb: KeyboardInfo = { rows: 1, cols: 1, layers: 16, keymap: [[4]], feature_flags5: 1, app_rules: old.rules, app_layers_enabled: old.enabled };
        // The backup .svil keeps them, then the update resets the board (blank, format 2).
        const svil = JSON.parse(JSON.stringify({ app_rules: appRulesToSvil(oldKb.app_rules!), app_layers_enabled: true }));
        const fromFile = appRulesFromSvil(svil.app_rules)!;
        expect(typeof fileService.loadFile).toBe("function");
        const { fw, link } = fakeLink(64);
        const queued: Array<() => Promise<void>> = [];
        await importService.syncWithKeyboard(
            { ...oldKb, app_rules: fromFile, app_layers_enabled: appLayersEnabledFromSvil(svil.app_layers_enabled) },
            { ...oldKb, app_rules: [] }, async (_d: string, cb: () => Promise<void>) => { queued.push(cb); },
            { keyboardService: { saveSvil: vi.fn() }, appRulesLink: link, labelService: {} });
        for (const cb of queued) await cb();
        expect(fw.state.appRules[0]).toBe(2);
        const after = await readAppRules(link);
        expect(after.enabled).toBe(true);
        expect(after.rules.map((r) => [r.appId, r.text, r.flags & APP_RULE_SITE, r.defaultLayer, r.frontLayer, r.onMask]))
            .toEqual(old.rules.map((r) => [r.appId, r.text, r.flags & APP_RULE_SITE, r.defaultLayer, r.frontLayer, r.onMask]));
    });
});

describe("app keys this browser remembers", () => {
    beforeEach(() => localStorage.removeItem(APP_RULE_KEYS_STORAGE));
    it("maps an ID back to the key as typed", () => {
        expect(appKeyFor(appId("notepad.exe"))).toBeUndefined();
        rememberAppKey("  Notepad.exe ");
        expect(appKeyFor(appId("notepad.exe"))).toBe("Notepad.exe");
        expect(appKeyFor(0)).toBeUndefined();
    });
});

describe("layout files and import", () => {
    afterEach(() => vi.restoreAllMocks());

    it(".svil keeps the key and text with the rule; a key in the file gives the ID", () => {
        const list = [rule({ key: "notepad.exe", onMask: 3 }), rule({ appId: 0x1234, text: "Old" }), withRuleOn(rule({ key: "notepad.exe" }), false)];
        const svil = appRulesToSvil(list);
        expect(svil[0]).toMatchObject({ app_id: 0xb884a32c, key: "notepad.exe", text: "notepad.exe", on_mask: 3, default_layer: null, flags: 0 });
        expect(svil[1].key).toBeUndefined();
        expect(svil[2].flags).toBe(APP_RULE_OFF);
        const back = appRulesFromSvil(JSON.parse(JSON.stringify(svil)))!;
        expect(sameRules(back, list)).toBe(true);
        expect(appRulesFromSvil([{ key: "firefox", app_id: 1, default_layer: 300, on_mask: 0x1ffff }])![0])
            .toMatchObject({ appId: appId("firefox"), defaultLayer: null, onMask: 0x7fff, text: "firefox", flags: 0 });
        // Older files: a label stands in for the text.
        expect(appRulesFromSvil([{ app_id: 7, label: "Old one" }])![0]).toMatchObject({ appId: 7, text: "Old one" });
        expect(appRulesFromSvil(undefined)).toBeNull();
        expect(appRulesFromSvil(Array.from({ length: 70 }, () => ({ app_id: 5 })))!.length).toBe(64);
    });

    it("a rule from a file without flags is on; the switch is on unless the file says false", () => {
        expect(ruleOn(appRulesFromSvil([{ key: "notepad.exe" }])![0])).toBe(true);
        expect(ruleOn(appRulesFromSvil([{ key: "notepad.exe", flags: 1 }])![0])).toBe(false);
        expect(appLayersEnabledFromSvil(undefined)).toBe(true);
        expect(appLayersEnabledFromSvil(true)).toBe(true);
        expect(appLayersEnabledFromSvil(false)).toBe(false);
    });

    it("a file's rules stop where the board's record is full", () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ key: `${"x".repeat(55)}${i}.exe` }));
        const got = appRulesFromSvil(many)!;
        expect(got.length).toBeLessThan(40);
        expect(recordUsed(got)).toBeLessThanOrEqual(APP_RULES_RECORD_BYTES);
    });

    const board = (over: Partial<KeyboardInfo> = {}): KeyboardInfo => ({ rows: 1, cols: 1, layers: 1, keymap: [[4]], feature_flags5: 1, app_rules: [], ...over });

    it("the preflight takes the file's rules on a board that has them, and says so on one that doesn't", () => {
        const file = board({ app_rules: [rule()] });
        expect(prepareImport(file, board()).keyboard.app_rules).toEqual([rule()]);
        const without = prepareImport(file, board({ feature_flags5: 0, app_rules: undefined }));
        expect(without.keyboard.app_rules).toBeUndefined();
        expect(without.unavailable).toContain("App rules");
    });

    it("import writes the whole list once when it differs, and not at all when it doesn't", async () => {
        const { fw, link } = fakeLink(64);
        const queued: string[] = [];
        const cbs: Array<() => Promise<void>> = [];
        const enqueue = async (desc: string, cb: () => Promise<void>) => { queued.push(desc); cbs.push(cb); };
        const services = { keyboardService: { saveSvil: vi.fn() }, appRulesLink: link, labelService: {} };
        await importService.syncWithKeyboard(board({ app_rules: [rule()] }), board(), enqueue, services);
        expect(queued).toContain("Update app rules");
        await cbs[queued.indexOf("Update app rules")]();
        expect(rules(fw.state.appRules)).toEqual([rule()]);
        queued.length = 0;
        await importService.syncWithKeyboard(board({ app_rules: [rule()] }), board({ app_rules: [rule()] }), enqueue, services);
        expect(queued).not.toContain("Update app rules");
        // The switch alone differs: written, and stored off.
        await importService.syncWithKeyboard(board({ app_rules: [rule()], app_layers_enabled: false }), board({ app_rules: [rule()] }), enqueue, services);
        expect(queued).toContain("Update app rules");
        cbs.length = 0; queued.length = 0;
        await importService.syncWithKeyboard(board({ app_rules: [rule()], app_layers_enabled: false }), board({ app_rules: [rule()] }), enqueue, services);
        await cbs[0]();
        expect(parseRecord(fw.state.appRules).enabled).toBe(false);
    });
});

// ---- website rules ------------------------------------------------------------------
// Keybard Host normalizes and matches sites the same way (companion/overlay-host/tests/test_site_rules.py
// has the same vectors).
import { normalizeSite, siteKey, siteMatches, siteOfRule, siteProblem, withSite } from "@/services/app-rules";
import { ruleKey } from "@/utils/app-rule-keys";

describe("website rules", () => {
    const rule: AppRule = { appId: 0, defaultLayer: null, frontLayer: 3, onMask: 0, offMask: 0, flags: 0, text: "", key: "" };

    it("shares its ID vectors with Keybard Host", () => {
        expect(siteKey("onshape.com")).toBe("site:onshape.com");
        expect(appId(siteKey("onshape.com"))).toBe(0xB2AF5B45);
        expect(appId(siteKey("cad.onshape.com"))).toBe(0x7E364D67);
    });

    it("comes down to the bare site, whatever is typed", () => {
        for (const typed of ["onshape.com", "Onshape.COM", " onshape.com\t", "https://www.onshape.com/documents?x=1",
            "http://onshape.com:8080", "*.onshape.com", "site:onshape.com", "SITE: onshape.com", "onshape.com.",
            "user@onshape.com", "onshape.com#top", "www.onshape.com"]) {
            expect(normalizeSite(typed), typed).toBe("onshape.com");
        }
        expect(normalizeSite("www.com")).toBe("www.com");
        expect(normalizeSite("localhost:5173")).toBe("localhost");
        for (const typed of ["", "   ", "site:", "https://", "*."]) expect(normalizeSite(typed), typed).toBe("");
    });

    it("keeps an IDN as plain text, punycode or not", () => {
        expect(normalizeSite("xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
        expect(normalizeSite("bücher.de")).toBe("bücher.de");
        expect(appId(siteKey("bücher.de"))).not.toBe(appId(siteKey("xn--bcher-kva.de")));
    });

    it("flags only a site that isn't one name", () => {
        expect(siteProblem("onshape.com")).toBeNull();
        expect(siteProblem("practice.svalboard.com")).toBeNull();
        expect(siteProblem("averyverylongname.com")).toBeNull();
        expect(siteProblem("")).toBeNull();
        expect(siteProblem("on shape.com")).toMatch(/without spaces/);
    });

    it("says exactly which addresses it matches", () => {
        expect(siteMatches("https://practice.svalboard.com/lesson")).toBe("Matches practice.svalboard.com and every address under it.");
        expect(siteMatches("onshape.com")).toBe("Matches onshape.com and every address under it.");
        expect(siteMatches("")).toBeNull();
        expect(siteMatches("on shape.com")).toBeNull();
    });

    it("sets the ID from the whole site as typed, and stores the whole site", () => {
        expect(withSite(rule, "https://www.Onshape.com/x")).toMatchObject({ key: "site:https://www.Onshape.com/x", appId: 0xB2AF5B45, text: "onshape.com", flags: APP_RULE_SITE });
        // cad.onshape.com stays cad.onshape.com: never widened to onshape.com.
        expect(withSite(rule, "https://cad.onshape.com/documents")).toMatchObject({ appId: 0x7E364D67, text: "cad.onshape.com" });
        expect(withSite(rule, "practice.svalboard.com")).toMatchObject({ appId: appId("site:practice.svalboard.com"), text: "practice.svalboard.com" });
        expect(withSite(rule, "practice.svalboard.com").appId).not.toBe(appId("site:svalboard.com"));
        expect(withSite(rule, "on shape.com")).toMatchObject({ appId: 0 });
        expect(withSite(rule, "")).toMatchObject({ key: "site:", appId: 0, text: "" });
    });

    it("round-trips through the board, a long site whole, without this browser remembering it", () => {
        localStorage.clear();
        for (const site of ["onshape.com", "practice.svalboard.com"]) {
            const [back] = rules(serializeRecord([withSite(rule, site)]));
            expect(siteOfRule(back)).toBe(site);
            expect(ruleKey(back)).toBe(`site:${site}`);
        }
        // A program rule whose text only looks like a site is not a website rule.
        expect(siteOfRule({ appId: appId("chrome.exe"), text: "onshape.com" })).toBeNull();
        // A program rule's text names it too.
        expect(ruleKey(rules(serializeRecord([withApp(rule, "Notepad.exe")]))[0])).toBe("Notepad.exe");
    });

    it("comes from a layout file normalized, with its whole site as the text", () => {
        const [fromFile] = appRulesFromSvil([{ app_id: 1, key: "site:https://www.onshape.com/", label: "Onshape", default_layer: null, front_layer: 2, on_mask: 0, off_mask: 0 }])!;
        expect(fromFile).toMatchObject({ key: "site:onshape.com", appId: 0xB2AF5B45, text: "onshape.com", frontLayer: 2, flags: APP_RULE_SITE });
        const [long] = appRulesFromSvil([{ app_id: 5, key: "site:practice.svalboard.com", label: "x" }])!;
        expect(long).toMatchObject({ key: "site:practice.svalboard.com", appId: appId("site:practice.svalboard.com"), text: "practice.svalboard.com" });
    });

    it("an upgraded site cut short shows as it is, its ID kept", () => {
        localStorage.clear();
        const cut = { ...rule, appId: appId("site:practice.svalboard.com"), text: "…lboard.com", flags: APP_RULE_SITE };
        expect(siteOfRule(cut)).toBeNull();
        expect(ruleKey(cut)).toBeUndefined();
        rememberAppKey("site:practice.svalboard.com");
        expect(ruleKey(cut)).toBe("site:practice.svalboard.com");
    });

    it("remembers a website rule's key in its normalized form", () => {
        localStorage.clear();
        rememberAppKey("site:https://www.onshape.com/");
        expect(appKeyFor(0xB2AF5B45)).toBe("site:onshape.com");
    });
});
