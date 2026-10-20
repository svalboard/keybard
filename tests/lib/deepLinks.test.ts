import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
    boardLayerFromSearch, claimDemoStart, claimEditStart, demoFromSearch, editFromSearch, editTargetExists,
    resetDeepLinksForTests, themeFromSearch, withDemoFeatures,
} from "@/lib/deepLinks";
import { fileService } from "@/services/file.service";

const DEMO = readFileSync(resolve(process.cwd(), "src/default-layouts/sval-default.svil"), "utf8");

beforeEach(() => resetDeepLinksForTests());

describe("?demo", () => {
    it("is the QWERTY Example with any value but combos", () => {
        expect(demoFromSearch("")).toBeNull();
        expect(demoFromSearch("?demo")).toBe("qwerty");
        expect(demoFromSearch("?demo=1")).toBe("qwerty");
        expect(demoFromSearch("?demo=combos")).toBe("combos");
        expect(demoFromSearch("?railMode=modal&demo=Combos&spotLight=tint")).toBe("combos");
    });

    it("the combos file has combos, tap dances and macros and keeps the exact uid", () => {
        const text = withDemoFeatures(DEMO);
        expect(/"uid"\s*:\s*(\d+)/.exec(text)?.[1]).toBe(/"uid"\s*:\s*(\d+)/.exec(DEMO)?.[1]);
        const plain = fileService.parseContent(DEMO);
        const kb = fileService.parseContent(text);
        expect(kb.kbid).toBe(plain.kbid);
        expect(kb.combos?.length).toBe(plain.combos?.length);
        expect(JSON.stringify(kb.combos?.[0])).not.toBe(JSON.stringify(plain.combos?.[0]));
        expect(JSON.stringify(kb.tapdances?.[0])).not.toBe(JSON.stringify(plain.tapdances?.[0]));
        expect(kb.macros?.[1]?.actions?.length).toBeGreaterThan(0);
        expect(plain.macros?.[1]?.actions?.length ?? 0).toBe(0);
        expect(kb.cosmetic?.combos).toEqual({ "0": "Quick escape", "2": "Next field" });
        expect(kb.cosmetic?.layer).toEqual(plain.cosmetic?.layer);
    });

    it("starts once per page load", () => {
        expect(claimDemoStart()).toBe(true);
        expect(claimDemoStart()).toBe(false);
    });
});

describe("?theme", () => {
    it("forces light or dark; anything else keeps the setting", () => {
        expect(themeFromSearch("?theme=dark")).toBe("dark");
        expect(themeFromSearch("?demo&theme=LIGHT")).toBe("light");
        expect(themeFromSearch("?theme=system")).toBeNull();
        expect(themeFromSearch("")).toBeNull();
    });
});

describe("?edit", () => {
    it("names a combo, tap dance or macro editor by index", () => {
        expect(editFromSearch("?edit=combo:3")).toEqual({ kind: "combo", index: 3 });
        expect(editFromSearch("?edit=tapdance:0&railMode=collapse")).toEqual({ kind: "tapdance", index: 0 });
        expect(editFromSearch("?edit=macro:12")).toEqual({ kind: "macro", index: 12 });
        expect(editFromSearch("?edit=leader:1")).toBeNull();
        expect(editFromSearch("?edit=combo")).toBeNull();
        expect(editFromSearch("?edit=combo:-1")).toBeNull();
    });

    it("only opens entries the layout has", () => {
        const counts = { combos: 50, tapdances: 50, macros: 2 };
        expect(editTargetExists({ kind: "macro", index: 1 }, counts)).toBe(true);
        expect(editTargetExists({ kind: "macro", index: 2 }, counts)).toBe(false);
        expect(editTargetExists({ kind: "combo", index: 49 }, counts)).toBe(true);
    });

    it("opens once per page load", () => {
        expect(claimEditStart()).toBe(true);
        expect(claimEditStart()).toBe(false);
    });
});

describe("?demo&boardLayer=N", () => {
    it("is the simulated board's live layer, only with ?demo", () => {
        expect(boardLayerFromSearch("?demo&boardLayer=2")).toBe(2);
        expect(boardLayerFromSearch("?demo=combos&boardLayer=0")).toBe(0);
        expect(boardLayerFromSearch("?demo&boardLayer=31")).toBe(31);
        expect(boardLayerFromSearch("?boardLayer=2")).toBeNull();
        expect(boardLayerFromSearch("?demo")).toBeNull();
    });

    it("ignores anything that isn't a layer from 0 to 31", () => {
        for (const bad of ["32", "-1", "1.5", "abc", "", "999"]) {
            expect(boardLayerFromSearch(`?demo&boardLayer=${bad}`)).toBeNull();
        }
    });
});
