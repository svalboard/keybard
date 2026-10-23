// The one image for both halves, end to end against the mock board in virtual time:
// the sheet reads each half's side, the same file goes to both halves, and the flow
// checks the sides afterwards, writing or asking only when it must.
import { beforeEach, describe, expect, it } from "vitest";

import type { FirmwareReleasePin } from "@/constants/firmware-releases";
import { SideSource, Strap } from "@/services/side";
import { writesForAnswer } from "@/services/side-decision";
import { assessmentFromAsk } from "@/features/firmware/SideFix";
import { UpdaterClient } from "@/services/updater/client";
import { planInstall, type Plan } from "@/services/updater/checks";
import { fakeSetup, fixtureOneImage, fixtureRelease, type FixtureRelease } from "@/services/updater/fake-host";
import type { FakeSidesOptions } from "@/services/updater/fake-sides";
import { memoryFlowStore, UpdateFlow, type FlowState } from "@/services/updater/flow";
import { HAND_EITHER, HAND_LEFT, HAND_RIGHT, Op } from "@/services/updater/protocol";
import { VirtualClock } from "@/services/updater/transport";

const L = HAND_LEFT;
const R = HAND_RIGHT;
let clock: VirtualClock;
let v3: FixtureRelease;
let one: FixtureRelease;

beforeEach(async () => {
    clock = new VirtualClock();
    v3 ??= await fixtureRelease("v3", 3000);
    one ??= await fixtureOneImage("x4", 4000);
});

const pin = (r: FixtureRelease): FirmwareReleasePin => ({
    tag: r.tag, kind: r.tag.startsWith("v") ? "v" : "x", fwVersion: r.fwVersion, updaterProtocol: 4,
    file: { uf2: `svalboard_sval_${r.tag}.uf2`, sha256: r.files[L].sha256, size: r.files[L].bytes.length },
    notesUrl: "",
});

async function plan(sides: FakeSidesOptions | undefined, release = one) {
    const { board, host, sides: fake } = fakeSetup({ clock, running: v3, sides });
    const p = await planInstall(new UpdaterClient(board), { kind: "release", release: pin(release), files: release.files }, { clock, releases: [pin(v3), pin(release)], sides: host.sides });
    return { board, host, fake, plan: p };
}

/** Run the flow; `answer` is called whenever it asks which half is which. */
async function run(sides: FakeSidesOptions | undefined, o: { override?: Partial<Plan>; answer?: (s: FlowState) => ReturnType<typeof writesForAnswer> } = {}) {
    const { board, host, fake, plan: p } = await plan(sides);
    if ("id" in p) throw new Error(`plan failed: ${p.id}`);
    const flow = UpdateFlow.create(host, memoryFlowStore(), { plan: { ...p, ...o.override }, afterwards: "restore", backup: { fileName: "Kip.svil", svil: "{}" } });
    const asks: FlowState[] = [];
    flow.subscribe((s) => {
        if (s.sideAsk && !asks.includes(s)) {
            asks.push(s);
            const writes = o.answer?.(s);
            if (writes) queueMicrotask(() => flow.answerSide(writes));
        }
    });
    const state = await flow.run();
    return { board, host, fake: fake!, state, asks, plan: p };
}

describe("the one image: files", () => {
    it("a hand-2 file goes to both halves, with no hand warning", async () => {
        const { plan: p } = await plan(undefined);
        if ("id" in p) throw new Error(p.id);
        expect(one.files[L].manifest.hand).toBe(HAND_EITHER);
        expect(p.target).toBe("both");
        expect(p.oneImage).toBe(true);
        expect(p.files[L]).toBe(p.files[R]);
        expect(p.warnings.filter((w) => w.id.startsWith("hand-"))).toEqual([]);
        expect(p.refusal).toBeNull();
    });
    it("a chosen hand-2 file serves both halves; with another file it's one too many", async () => {
        const { board } = fakeSetup({ clock, running: v3 });
        const p = await planInstall(new UpdaterClient(board), { kind: "file", files: [one.files[L]] }, { clock, releases: [] });
        if ("id" in p) throw new Error(p.id);
        expect(p.target).toBe("both");
        expect(p.refusal).toBeNull();
        const two = await planInstall(new UpdaterClient(board), { kind: "file", files: [one.files[L], v3.files[R]] }, { clock, releases: [] });
        if ("id" in two) throw new Error(two.id);
        expect(two.refusal?.id).toBe("file-twice");
    });
});

describe("the one image: sides before the update", () => {
    it("a per-hand board: no SIDE, the sides come from the updater, no side check row", async () => {
        const { plan: p } = await plan({ supported: false });
        if ("id" in p) throw new Error(p.id);
        expect(p.sidesBefore).toEqual({ usb: "right", other: "left" });
        expect(p.checks.some((c) => c.id === "sides")).toBe(false);
    });
    it("a one-image board with both sides known: a check row, and the sides noted", async () => {
        const { plan: p } = await plan({ supported: true, usb: { side: "right", source: SideSource.KEYBARD }, other: { side: "left", source: SideSource.KEYBARD } });
        if ("id" in p) throw new Error(p.id);
        expect(p.sidesBefore).toEqual({ usb: "right", other: "left" });
        expect(p.checks.find((c) => c.id === "sides")).toMatchObject({ state: "ok", label: "Each half knows its side" });
    });
    it("two halves on the same side: set it first (no update offered yet)", async () => {
        const { plan: p } = await plan({ supported: true, usb: { side: "right" }, other: { side: "right" } });
        expect(p).toMatchObject({ id: "sides", sides: { kind: "same", side: "right" } });
    });
    it("a half with no side: set it first", async () => {
        const { plan: p } = await plan({ supported: true, usb: { side: "right" }, other: { side: "unknown" } });
        expect(p).toMatchObject({ id: "sides", sides: { kind: "unknown", halves: ["other"], guess: { other: "left" } } });
    });
    it("the other half not reported yet: waits, then plans", async () => {
        const { plan: p } = await plan({ supported: true, pendingReads: 2 });
        expect("id" in p).toBe(false);
    });
});

/** The customer answers "the plugged-in half is `usb`" (the writes a click on that button sends). */
const says = (usb: "left" | "right") => (s: FlowState) => writesForAnswer(assessmentFromAsk(s.sideAsk!), usb);
/** "That's right". */
const thatsRight = () => [];

describe("the one image: the update and after", () => {
    it("migrated: one chord, the same image to both halves, then the sides shown once: That's right", async () => {
        const { board, fake, state, asks } = await run({ supported: false }, { answer: thatsRight });
        expect(state.phase).toBe("result");
        expect(state.approvalsAsked).toBe(1);
        expect(board.halves[L].cfg.fwVersion).toBe(4000);
        expect(board.halves[R].cfg.fwVersion).toBe(4000);
        expect(board.halves[L].cfg.imageId).toBe(board.halves[R].cfg.imageId);
        expect(board.requests.filter((r) => r.op === Op.ARM).map((a) => a.hand)).toEqual([L, R]);
        expect(asks).toHaveLength(1);
        expect(asks[0].sideAsk).toMatchObject({ reason: "confirm", from: "migrated", usb: "right", other: "left", suggested: "right" });
        expect(fake.writes).toEqual([]);
        expect(state.result?.sides).toEqual({ usb: "right", other: "left", wrote: [], migrated: true });
    });
    it("migrated, Swap: both halves set, other half first, after the customer's confirm", async () => {
        const { fake, state } = await run({ supported: false }, { answer: says("left") });
        expect(fake.writes.map((w) => `${w.role}:${w.side}:${w.status}`)).toEqual(["other:right:7", "usb:left:0"]);
        expect(state.phase).toBe("result");
        expect(state.result?.sides).toMatchObject({ usb: "left", other: "right", wrote: ["other", "usb"] });
    });
    it("a one-image board whose sides Keybard read before, unchanged: nothing asked, nothing written", async () => {
        const { fake, state, asks } = await run({ supported: true, usb: { source: SideSource.KEYBARD }, other: { source: SideSource.KEYBARD } });
        expect(asks).toEqual([]);
        expect(fake.writes).toEqual([]);
        expect(state.result?.sides).toMatchObject({ usb: "right", other: "left", wrote: [] });
    });
    it("a per-hand board and a per-hand release (no SIDE): today's flow, no side result", async () => {
        const { board, host } = fakeSetup({ clock, running: v3 });
        // Per-hand files (the svup form a developer build makes): releases are one pair UF2 from x4 on.
        const x4 = await fixtureRelease("x4", 4000);
        const p = await planInstall(new UpdaterClient(board), { kind: "file", files: [x4.files[L], x4.files[R]] }, { clock, releases: [], sides: host.sides });
        if ("id" in p) throw new Error(p.id);
        const state = await UpdateFlow.create(host, memoryFlowStore(), { plan: p, afterwards: "restore", backup: { fileName: "k.svil", svil: "{}" } }).run();
        expect(state.phase).toBe("result");
        expect(state.result?.sides ?? null).toBeNull();
    });
    it("the other half came back unknown: Keybard asks to keep the sides, never writes by itself", async () => {
        const { fake, state, asks } = await run({ supported: false, after: { other: { side: "unknown" } } }, { answer: says("right") });
        expect(asks).toHaveLength(1);
        expect(asks[0].sideAsk).toMatchObject({ reason: "unknown", restore: true, suggested: "right" });
        expect(fake.writes).toEqual([{ role: "other", side: "left", status: 7 }]);
        expect(state.result?.sides).toMatchObject({ usb: "right", other: "left", wrote: ["other"] });
    });
    it("no answer, no write: the flow waits on the question", async () => {
        const { host, fake, plan: p } = await plan({ supported: false, after: { other: { side: "unknown" } } });
        if ("id" in p) throw new Error(p.id);
        const flow = UpdateFlow.create(host, memoryFlowStore(), { plan: p, afterwards: "restore", backup: { fileName: "k.svil", svil: "{}" } });
        const asked = new Promise<FlowState>((resolve) => flow.subscribe((s) => { if (s.sideAsk) resolve(s); }));
        const done = flow.run();
        const s = await asked;
        for (let i = 0; i < 20; i++) await clock.sleep(1000);
        expect(s.step).toBe("sides");
        expect(flow.state.phase).toBe("running");
        expect(fake!.writes).toEqual([]);
        flow.answerSide([]);
        await done;
    });
    it("both came back unknown: one answer sets both, the other half first (USB reconnects)", async () => {
        const { board, fake, state } = await run({ supported: false, after: { usb: { side: "unknown" }, other: { side: "unknown" } } }, { answer: says("right") });
        expect(state.phase).toBe("result");
        expect(fake.writes.map((w) => `${w.role}:${w.side}`)).toEqual(["other:left", "usb:right"]);
        expect(board.usbReboots).toBeGreaterThanOrEqual(2);
    });
    it("unknown and not known before: asks which half is plugged in, no guess", async () => {
        const { fake, state, asks } = await run(
            { supported: true, after: { usb: { side: "unknown" }, other: { side: "unknown" } } },
            { override: { sidesBefore: { usb: null, other: null } }, answer: says("left") },
        );
        expect(asks).toHaveLength(1);
        expect(asks[0].sideAsk).toMatchObject({ reason: "unknown", usb: "unknown", other: "unknown", suggested: null, restore: false });
        expect(fake.writes.map((w) => `${w.role}:${w.side}`)).toEqual(["other:right", "usb:left"]);
        expect(state.result?.sides).toMatchObject({ usb: "left", other: "right" });
    });
    it("same side after, not known before: no guess; the answer sets the half that's wrong", async () => {
        const { fake, state, asks } = await run(
            { supported: true, after: { usb: { side: "right" }, other: { side: "right" } } },
            { override: { sidesBefore: { usb: null, other: null } }, answer: says("left") },
        );
        expect(asks[0].sideAsk).toMatchObject({ reason: "same", usb: "right", other: "right", suggested: null });
        expect(fake.writes).toEqual([{ role: "usb", side: "left", status: 0 }]);
        expect(state.phase).toBe("result");
    });
    it("the thumb PCBA set sides Keybard didn't know before: shown once to confirm", async () => {
        const { asks, state } = await run(
            { supported: true, after: { usb: { side: "right", source: SideSource.STRAP, strap: Strap.RIGHT }, other: { side: "left", source: SideSource.STRAP, strap: Strap.LEFT } } },
            { override: { sidesBefore: { usb: null, other: null } }, answer: thatsRight },
        );
        expect(asks).toHaveLength(1);
        expect(asks[0].sideAsk).toMatchObject({ reason: "confirm", from: "strap" });
        expect(state.phase).toBe("result");
    });
    it("sides Keybard knew before, now from the thumb PCBA and unchanged: nothing asked (the firmware didn't pick them)", async () => {
        const { asks, fake, state } = await run({ supported: true, usb: { source: SideSource.KEYBARD }, after: { usb: { side: "right", source: SideSource.STRAP, strap: Strap.RIGHT } } });
        expect(asks).toEqual([]);
        expect(fake.writes).toEqual([]);
        expect(state.phase).toBe("result");
    });
    it("status 4: the thumb PCBA wins; Keybard explains it and asks again, never retries", async () => {
        let n = 0;
        const { fake, state, asks } = await run(
            { supported: true, after: { usb: { side: "right", strap: Strap.RIGHT, source: SideSource.STRAP }, other: { side: "right" } } },
            { override: { sidesBefore: { usb: null, other: null } }, answer: (s) => says(n++ === 0 ? "left" : "right")(s) },
        );
        expect(asks[0].sideAsk!.suggested).toBe("right");
        expect(fake.writes).toEqual([{ role: "usb", side: "left", status: 4 }, { role: "other", side: "left", status: 7 }]);
        expect(asks).toHaveLength(2);
        expect(asks[1].sideAsk!.note).toContain("right thumb PCBA");
        expect(asks[1].sideAsk!.note).toContain("https://www.svalboard.com/discord");
        expect(state.phase).toBe("result");
    });
    it("status 4 on the other half: asks again, offering the plugged-in half that fits", async () => {
        const { fake, state, asks } = await run(
            { supported: false, after: { other: { side: "right", strap: Strap.RIGHT, source: SideSource.STRAP } } },
            { answer: (s) => says(s.sideAsk!.suggested!)(s) },
        );
        expect(asks[0].sideAsk).toMatchObject({ reason: "same", restore: true, suggested: "right" });
        expect(asks[1].sideAsk).toMatchObject({ reason: "same", restore: false, suggested: "left" });
        expect(asks[1].sideAsk!.note).toContain("a right thumb PCBA");
        expect(fake.writes.map((w) => `${w.role}:${w.side}:${w.status}`)).toEqual(["other:left:4", "usb:left:0"]);
        expect(state.result?.sides).toMatchObject({ usb: "left", other: "right" });
    });
    it("a refusal every time ends on F22, with the reason", async () => {
        const { state, fake } = await run(
            { supported: true, after: { usb: { side: "right", strap: Strap.RIGHT }, other: { side: "right", strap: Strap.RIGHT } } },
            { override: { sidesBefore: { usb: null, other: null } }, answer: says("right") },
        );
        expect(fake.writes.every((w) => w.status === 4)).toBe(true);
        expect(state.phase).toBe("failed");
        expect(state.failure).toMatchObject({ id: "F22" });
        expect(state.failure?.detail).toContain("thumb PCBA");
    });
});
