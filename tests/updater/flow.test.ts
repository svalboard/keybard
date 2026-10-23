// The install flow end to end against FakeSvalboard, in virtual time.
import { beforeEach, describe, expect, it } from "vitest";
import { UpdaterClient } from "@/services/updater/client";
import { planInstall, type Plan, type PreFailure } from "@/services/updater/checks";
import { fakeSetup, fixtureOneImage, FakeHost, type FixtureRelease } from "@/services/updater/fake-host";
import { memoryFlowStore, settingsResetProblem, UpdateFlow, type Afterwards, type FlowState } from "@/services/updater/flow";
import { HAND_LEFT, HAND_RIGHT, Op, Status, makeRsp } from "@/services/updater/protocol";
import { buildSvup, loadSvup } from "@/services/updater/svup";
import { loadFirmwareFile } from "@/services/updater/uf2";
import { VirtualClock } from "@/services/updater/transport";
import type { FirmwareReleasePin } from "@/constants/firmware-releases";

const L = HAND_LEFT;
const R = HAND_RIGHT;
let clock: VirtualClock;
let v3: FixtureRelease;
let x32: FixtureRelease;
let dev: FixtureRelease;

beforeEach(async () => {
    clock = new VirtualClock();
    v3 ??= await fixtureOneImage("v3", 3000);
    x32 ??= await fixtureOneImage("x4", 4000);
    dev ??= await fixtureOneImage("x4", 4000, { noChord: true });
});

const pin = (r: FixtureRelease): FirmwareReleasePin => ({
    tag: r.tag, kind: r.tag.startsWith("v") ? "v" : "x", fwVersion: r.fwVersion, updaterProtocol: 4,
    file: { uf2: `svalboard_sval_${r.tag}.uf2`, sha256: r.files[L].sha256, size: r.files[L].bytes.length },
    notesUrl: "",
});

interface RunOptions {
    setup?: Partial<Parameters<typeof fakeSetup>[0]>;
    release?: FixtureRelease;
    afterwards?: Afterwards;
    onlyHand?: 0 | 1;
    backup?: boolean;
}

async function plan(o: RunOptions = {}) {
    const { board, host } = fakeSetup({ clock, running: v3, ...o.setup });
    const release = o.release ?? x32;
    const p = await planInstall(new UpdaterClient(board), { kind: "release", release: pin(release), files: release.files }, { clock, onlyHand: o.onlyHand, releases: [pin(v3), pin(x32)] });
    return { board, host, plan: p };
}

async function run(o: RunOptions = {}) {
    const { board, host, plan: p } = await plan(o);
    if ("id" in p) throw new Error(`plan failed: ${p.id}`);
    const store = memoryFlowStore();
    const flow = UpdateFlow.create(host, store, { plan: p, afterwards: o.afterwards ?? "restore", backup: o.backup === false ? null : { fileName: "Kip-v3-2026-10-15.svil", svil: "{}" } });
    const approvals: number[] = [];
    flow.subscribe((s) => { if (s.step === "approve") approvals.push(s.approvalsAsked); });
    const state = await flow.run();
    return { board, host, state, store, flow, approvals };
}

function expectOneChordAtMost(s: FlowState) {
    expect(s.approvalsAsked).toBeLessThanOrEqual(1);
}

describe("the install flow", () => {
    it("P4-08 / P4-25 a pair update asks for the chord exactly once and ends on the new release", async () => {
        const { board, host, state } = await run();
        expect(state.phase).toBe("result");
        expect(state.approvalsAsked).toBe(1);
        expect(board.chordRequests).toBe(1);
        expect(board.halves[L].cfg.fwVersion).toBe(4000);
        expect(board.halves[R].cfg.fwVersion).toBe(4000);
        expect(state.result).toMatchObject({ tags: { 0: "x4", 1: "x4" }, layout: "restored" });
        expect(host.restores).toBe(1);
        expect(host.events[host.events.length - 1]).toBe("0x2A");
        expect(state.sent2A).toBe(true);
        expect(board.storageFlags & 4).toBe(0);
        // The other half went first; the half with USB armed pre-approved.
        const arms = board.requests.filter((r) => r.op === Op.ARM);
        expect(arms.map((a) => a.hand)).toEqual([L, R]);
    });

    it("P4-23 a no-chord developer build never asks for the chord", async () => {
        const { board, state } = await run({ setup: { noChord: true }, release: dev });
        expect(state.phase).toBe("result");
        expect(state.noChord).toBe(true);
        expect(state.approvalsAsked).toBe(0);
        expect(board.chordRequests).toBe(0);
    });

    it("P4-14 / P4-25 a lapsed held approval stops on F9 and never asks for a second chord", async () => {
        const { board, state } = await run({ setup: { faults: [{ kind: "held-lapse" }] } });
        expect(state.phase).toBe("failed");
        expect(state.failure).toMatchObject({ id: "F9", tags: { 0: "x4", 1: "v3" } });
        expect(state.approvalsAsked).toBe(1);
        expect(board.chordRequests).toBe(1);
        expect(board.halves[R].cfg.fwVersion).toBe(3000);
    });

    it("survives client ID renewals throughout (REBIND after each, including between the sessions)", async () => {
        const { board, state } = await run({ setup: { faults: [{ kind: "renew-every", ms: 4000 }] } });
        expect(state.phase).toBe("result");
        expect(board.requests.filter((r) => r.op === Op.REBIND && r.status === 0).length).toBeGreaterThanOrEqual(2);
        expect(state.approvalsAsked).toBe(1);
    });

    it("updates the half with USB alone, with its own single chord", async () => {
        const { board, state } = await run({ onlyHand: R });
        expect(state.phase).toBe("failed"); // the halves now differ: F9 says so, with Finish update
        expect(state.failure?.id).toBe("F9");
        expect(state.approvalsAsked).toBe(1);
        expect(board.halves[R].cfg.fwVersion).toBe(4000);
        expect(board.halves[L].cfg.fwVersion).toBe(3000);
    });

    it("finishes a stopped update: the other half alone brings the halves together", async () => {
        const { board, state } = await run({ onlyHand: L, setup: { otherRunning: { tag: "v3", fwVersion: 3000 }, running: x32 }, release: x32 });
        expect(board.halves[L].cfg.fwVersion).toBe(4000);
        expect(state.phase).toBe("result");
        expect(state.approvalsAsked).toBe(1);
        expect(state.result?.tags).toEqual({ 0: "x4", 1: "x4" });
        expect(board.chordRequests).toBe(1);
    });

    it("F3 another app holds the updater", async () => {
        const { plan: p } = await plan({ setup: { faults: [{ kind: "other-client" }] } });
        expect((p as PreFailure).id).toBe("F3");
    });

    it("F4 the chord isn't made in time: nothing changed", async () => {
        const { board, state } = await run({ setup: { chordAfterMs: "never" } });
        expect(state.failure?.id).toBe("F4");
        expect(board.halves[L].cfg.fwVersion).toBe(3000);
        expect(board.halves[R].cfg.fwVersion).toBe(3000);
        expect(board.state).toBe(0); // ABORT cleared the latched error
    });

    it("F5 unplugged while sending the other half's file: nothing changed", async () => {
        const { board, state } = await run({ setup: { faults: [{ kind: "unplug", at: "other-send" }] } });
        expect(state.failure).toMatchObject({ id: "F5", tags: { 0: "v3", 1: "v3" } });
        expect(board.halves[L].cfg.fwVersion).toBe(3000);
    });

    it("F5 a verify failure (bad hash) before any install", async () => {
        const { state } = await run({ setup: { faults: [{ kind: "bad-hash", hand: L }] } });
        expect(state.failure?.id).toBe("F5");
    });

    it("F5 the relay fails part way", async () => {
        const { board, state } = await run({ setup: { faults: [{ kind: "relay-fail" }] } });
        expect(state.failure?.id).toBe("F5");
        expect(board.halves[L].cfg.fwVersion).toBe(3000);
    });

    it("F9 unplugged after the other half installed", async () => {
        const { state } = await run({ setup: { faults: [{ kind: "unplug", at: "self-send" }] } });
        expect(state.failure).toMatchObject({ id: "F9", tags: { 0: "x4", 1: "v3" } });
        expectOneChordAtMost(state);
    });

    it("P4-32 the other half doesn't come back after its install: stop before the half with USB (F9)", async () => {
        const { board, state } = await run({ setup: { faults: [{ kind: "other-no-return" }] } });
        expect(state.failure).toMatchObject({ id: "F9", tags: { 0: "x4", 1: "v3" } });
        expect(state.failure?.detail).toMatch(/left half didn't answer after its install, so Keybard stopped before the right half/);
        // The half with USB was never armed and still runs its old release.
        expect(state.committed).toEqual([L]);
        expect(board.requests.filter((r) => r.op === Op.ARM).map((a) => a.hand)).toEqual([L]);
        expect(board.halves[R].cfg.fwVersion).toBe(3000);
        expectOneChordAtMost(state);
    });

    it("F11 a one-half update of the other half that doesn't come back", async () => {
        const { state } = await run({ onlyHand: L, setup: { faults: [{ kind: "other-no-return" }] } });
        expect(state.failure).toMatchObject({ id: "F11", hand: L });
    });

    it("F14 the keyboard doesn't come back after the USB half installs", async () => {
        const { state } = await run({ setup: { faults: [{ kind: "no-return" }] } });
        expect(state.failure).toMatchObject({ id: "F14", hand: R });
    });

    it("F16 putting the layout back fails; 0x2A is not sent", async () => {
        const { host, state } = await run({ setup: { host: { restoreFails: true } } });
        expect(state.failure?.id).toBe("F16");
        expect(host.clears).toBe(0);
        expect(state.sent2A).toBe(false);
    });

    it("F17 settings writes failing stops before the sheet", async () => {
        const { plan: p } = await plan({ setup: { half: { writesFailing: true } } });
        expect((p as PreFailure).id).toBe("F17");
    });

    it("F18 a board without the 16 MiB flash installs by hand", async () => {
        const { plan: p } = await plan({ setup: { half: { flash16MiB: false } } });
        expect((p as PreFailure).id).toBe("F18");
    });

    it("a latched error from an earlier session is cleared with ABORT, with no row", async () => {
        const { state, board } = await run({ setup: { faults: [{ kind: "latched-error" }] } });
        expect(state.phase).toBe("result");
        expect(board.requests[0].op).not.toBe(Op.MANIFEST);
    });
});

describe("the sheet's checks", () => {
    it("F2 refuses a carried file that misses its pin", async () => {
        const { board } = fakeSetup({ clock, running: v3 });
        const bad = pin(x32);
        bad.file.sha256 = "0".repeat(64);
        const p = await planInstall(new UpdaterClient(board), { kind: "release", release: bad, files: x32.files }, { clock, releases: [bad] }) as Plan;
        expect(p.refusal?.id).toBe("integrity");
        expect(p.refusal?.label).toBe("The firmware file failed its check.");
    });

    it("warns about an unknown file, a developer build and an older release, and reads the right title", async () => {
        const { board } = fakeSetup({ clock, running: x32 });
        const older = await planInstall(new UpdaterClient(board), { kind: "file", files: [v3.files[L]] }, { clock, releases: [pin(v3), pin(x32)] }) as Plan;
        expect(older.title).toBe("Install v3");
        expect(older.warnings.map((w) => w.id)).toContain("older");
        const devPlan = await planInstall(new UpdaterClient(fakeSetup({ clock, running: v3 }).board), { kind: "file", files: [dev.files[L]] }, { clock, releases: [pin(v3), pin(x32)] }) as Plan;
        expect(devPlan.title).toBe("Install custom firmware");
        expect(devPlan.warnings.map((w) => w.id)).toEqual(expect.arrayContaining(["unknown-file", "developer"]));
        expect(devPlan.refusal).toBeNull();
    });

    it("titles a reinstall and an update", async () => {
        const { plan: re } = await plan({ release: v3 });
        expect((re as Plan).title).toBe("Reinstall v3");
        const { plan: up } = await plan();
        expect((up as Plan).title).toBe("Update to x4");
        expect((up as Plan).target).toBe("both");
    });

    it("offers the half with USB only when the other half doesn't answer", async () => {
        const { plan: p } = await plan({ setup: { faults: [{ kind: "other-silent" }] } });
        expect((p as Plan).target).toBe(R);
        expect((p as Plan).otherSilent).toBe(true);
        expect((p as Plan).warnings.map((w) => w.label)).toContain("The left half isn't answering.");
    });

    it("refuses a developer file on a release board (the firmware would)", async () => {
        const diag = await fixtureOneImage("x4", 4000, { flags: 0x2 });
        const { board } = fakeSetup({ clock, running: v3, release: true });
        const p = await planInstall(new UpdaterClient(board), { kind: "file", files: [diag.files[L]] }, { clock }) as Plan;
        expect(p.refusal?.label).toMatch(/won't accept this file/);
    });

    it("D45 refuses a kept-settings build (build-info 0x80) on a release board before sending it", async () => {
        const keep = await Promise.all([L, R].map(async (hand) => loadSvup(await buildSvup({ hand, fwVersion: 4000, tag: "x4", buildFlags: 0x80 }))));
        expect(keep[0].keepSettings).toBe(true);
        const { board } = fakeSetup({ clock, running: v3, release: true });
        const p = await planInstall(new UpdaterClient(board), { kind: "file", files: keep }, { clock }) as Plan;
        expect(p.refusal?.detail).toMatch(/developer file/i);
    });

    it("accepts an other half on updater protocol 3 or 4, never 2", async () => {
        for (const [proto, refused] of [[2, true], [3, false], [4, false]] as const) {
            const { board } = fakeSetup({ clock, running: v3 });
            board.halves[L].cfg.protocol = proto;
            const p = await planInstall(new UpdaterClient(board), { kind: "release", release: pin(x32), files: x32.files }, { clock, releases: [pin(x32)] }) as Plan;
            expect(p.refusal?.id === `refused-${L}`).toBe(refused);
        }
    });

    it("a damaged chosen file says to get the file again, not to reload", async () => {
        // A byte of the image changed inside the pair UF2: the record still parses, the SHA-512 doesn't match.
        const bytes = x32.files[L].bytes.slice();
        bytes[32 + 0x80] ^= 0xff;
        const damaged = await loadFirmwareFile(bytes);
        const { board } = fakeSetup({ clock, running: v3 });
        const p = await planInstall(new UpdaterClient(board), { kind: "file", files: [damaged] }, { clock }) as Plan;
        expect(p.refusal).toMatchObject({ id: "file-damaged", label: "This firmware file is damaged." });
        expect(p.refusal?.detail).toMatch(/Download it again/);
        expect(p.refusal?.detail).not.toMatch(/Reload/);
    });

    it("warns, never refuses, when a file's updater protocol differs from the board's", async () => {
        const p3 = await Promise.all([L, R].map(async (hand) => loadSvup(await buildSvup({ hand, fwVersion: 4000, tag: "x4", updaterProto: 3 }))));
        const { board } = fakeSetup({ clock, running: v3 });
        const p = await planInstall(new UpdaterClient(board), { kind: "file", files: p3 }, { clock }) as Plan;
        expect(p.refusal).toBeNull();
        const usbWarn = p.warnings.find((w) => w.id === `updater-protocol-${R}`);
        expect(usbWarn?.label).toBe("This file has an older updater.");
        expect(usbWarn?.detail).toMatch(/installs by hand/);
        const p5 = await Promise.all([L, R].map(async (hand) => loadSvup(await buildSvup({ hand, fwVersion: 4000, tag: "x4", updaterProto: 5 }))));
        const q = await planInstall(new UpdaterClient(fakeSetup({ clock, running: v3 }).board), { kind: "file", files: p5 }, { clock }) as Plan;
        expect(q.warnings.map((w) => w.label)).toContain("This file has a newer updater than this Keybard knows.");
        const same = await planInstall(new UpdaterClient(fakeSetup({ clock, running: v3 }).board), { kind: "file", files: [x32.files[L]] }, { clock }) as Plan;
        expect(same.warnings.some((w) => w.id.startsWith("updater-protocol"))).toBe(false);
    });

    it("refuses a no-chord build on a release board even without DIAGNOSTIC", async () => {
        const { board } = fakeSetup({ clock, running: v3, release: true });
        const p = await planInstall(new UpdaterClient(board), { kind: "file", files: [dev.files[L]] }, { clock }) as Plan;
        expect(p.refusal?.label).toMatch(/won't accept this file/);
    });
});

describe("afterwards", () => {
    it("start from defaults on an identical build sends SETTINGS_RESET, then 0x2A last", async () => {
        const { board, host, state } = await run({ release: v3, afterwards: "defaults" });
        expect(state.phase).toBe("result");
        expect(state.settingsResetSent).toBe(true);
        await clock.sleep(5000);
        board.connected();
        expect(board.settings).toEqual({ 0: "defaults", 1: "defaults" });
        expect(host.restores).toBe(0);
        expect(host.events[host.events.length - 1]).toBe("0x2A");
        expect(board.requests.some((r) => r.op === Op.SETTINGS_RESET)).toBe(true);
    });

    it("a refused SETTINGS_RESET on the defaults path says why, as Settings not reset (not as a layout restore)", async () => {
        for (const [status, done, why] of [
            [Status.FLASH_ERR, 0x01, /left half couldn't save the reset; the right half took it/],
            [Status.INVALID, 0, /refused the request/],
            [Status.UNAVAILABLE, 0, /other half didn't answer/],
            [Status.BUSY, 0, /busy/],
        ] as const) {
            const { board, host, plan: p } = await plan({ release: v3 });
            if ("id" in p) throw new Error(`plan failed: ${p.id}`);
            const request = board.request.bind(board);
            board.request = async (op, hand, args) => (op === Op.SETTINGS_RESET ? { status, rsp: makeRsp(status, [done]) } : request(op, hand, args));
            const state = await UpdateFlow.create(host, memoryFlowStore(), { plan: p, afterwards: "defaults", backup: null }).run();
            expect(state.failure?.id).toBe("F21");
            expect(state.failure?.detail).toMatch(why);
            expect(host.clears).toBe(0);
        }
        expect(settingsResetProblem(Status.FLASH_ERR, 0x02, R, "reset its settings")).toBe("the right half couldn't save the reset; the left half took it");
        expect(settingsResetProblem(Status.FLASH_ERR, 0, R, "reset its settings")).toBe("the right half and the left half couldn't save the reset");
    });

    it("start from defaults after a different build sends no reset (bit 2 already set)", async () => {
        const { board, state } = await run({ afterwards: "defaults" });
        expect(state.settingsResetSent).toBe(false);
        expect(board.requests.some((r) => r.op === Op.SETTINGS_RESET)).toBe(false);
        expect(state.result?.layout).toBe("defaults");
    });

    it("restore my layout writes the backup even when the firmware kept the settings", async () => {
        const { host, state } = await run({ release: v3, afterwards: "restore" });
        expect(host.restores).toBe(1);
        expect(state.result?.layout).toBe("restored");
    });

    it("with no backup, Keep my layout becomes the default layout", async () => {
        const { state } = await run({ backup: false, afterwards: "restore" });
        expect(state.afterwards).toBe("defaults");
    });

    it("P4-31 wipe to a blank board: no backup needed, SETTINGS_RESET mode 1 after the install, keymap checked, 0x2A last", async () => {
        const { board, host, state } = await run({ afterwards: "blank", backup: false });
        expect(state.phase).toBe("result");
        expect(state.afterwards).toBe("blank");
        expect(state.backup).toBeNull();
        expect(state.result?.layout).toBe("blank");
        expect(state.settingsResetSent).toBe(true);
        expect(host.restores).toBe(0);
        await clock.sleep(5000);
        board.connected();
        expect(board.settings).toEqual({ 0: "blank", 1: "blank" });
        // Sent even though the new build had reset the settings already (bit 2 set).
        expect(board.requests.filter((r) => r.op === Op.SETTINGS_RESET)).toHaveLength(1);
        expect(host.events.slice(-2)).toEqual(["keymap", "0x2A"]);
    });

    it("P4-31 wipe to a blank board on a reinstall of the same build", async () => {
        const { board, state } = await run({ release: v3, afterwards: "blank" });
        expect(state.result?.layout).toBe("blank");
        await clock.sleep(5000);
        board.connected();
        expect(board.settings).toEqual({ 0: "blank", 1: "blank" });
    });

    it("P4-31 wipe to a blank board with an other half that can't wipe: F20, nothing wiped, no 0x2A", async () => {
        const { board, host, plan: p } = await plan({ release: v3 });
        if ("id" in p) throw new Error(`plan failed: ${p.id}`);
        board.halves[L].cfg.blankWipe = false; // the other half on a build from before D44
        const state = await UpdateFlow.create(host, memoryFlowStore(), { plan: p, afterwards: "blank", backup: null }).run();
        expect(state.failure).toMatchObject({ id: "F20" });
        expect(state.failure?.detail).toMatch(/wasn't wiped/);
        expect(board.settings).toEqual({ 0: "user", 1: "user" }); // a reinstall of the same build kept them
        expect(host.clears).toBe(0);
    });

    it("P4-31 wipe to a blank board on a half with USB from before D44: it resets to defaults, so F20 from the keymap check, no 0x2A", async () => {
        const { board, host, state } = await run({ release: v3, afterwards: "blank", setup: { half: { blankWipe: false } } });
        expect(state.failure).toMatchObject({ id: "F20" });
        expect(state.failure?.detail).toMatch(/keys still set/);
        await clock.sleep(5000);
        board.connected();
        expect(board.settings).toEqual({ 0: "defaults", 1: "defaults" });
        expect(host.events).toContain("keymap");
        expect(host.clears).toBe(0);
    });
});

describe("a reload mid-update", () => {
    it("resumes after the restart from the saved state and puts the layout back without asking", async () => {
        const { board, host, plan: p } = await plan();
        const store = memoryFlowStore();
        // The tab goes away while the keyboard restarts: waitForDevice never returns in this tab.
        const dying = Object.assign(Object.create(Object.getPrototypeOf(host)), host, { waitForDevice: () => new Promise(() => undefined) }) as FakeHost;
        const flow = UpdateFlow.create(dying, store, { plan: p as Plan, afterwards: "restore", backup: { fileName: "b.svil", svil: "{}" } });
        void flow.run();
        // Let the flow run (it advances virtual time itself) until it waits for the keyboard.
        for (let i = 0; i < 20000 && !store.snapshot?.includes('"step":"reconnect"'); i++) await new Promise((r) => setTimeout(r, 0));
        expect(JSON.parse(store.snapshot!)).toMatchObject({ step: "reconnect" });
        const resumed = await UpdateFlow.restore(host, store);
        expect(resumed).not.toBeNull();
        const state = await resumed!.run();
        expect(state.phase).toBe("result");
        expect(state.approvalsAsked).toBe(1);
        expect(host.restores).toBe(1);
        expect(board.halves[R].cfg.fwVersion).toBe(4000);
    });

    it("never resets settings in place of a restore when the tab lost the backup", async () => {
        const { board, host, plan: p } = await plan();
        const store = memoryFlowStore();
        const dying = Object.assign(Object.create(Object.getPrototypeOf(host)), host, { waitForDevice: () => new Promise(() => undefined) }) as FakeHost;
        const flow = UpdateFlow.create(dying, store, { plan: p as Plan, afterwards: "restore", backup: { fileName: "b.svil", svil: "{}" } });
        void flow.run();
        for (let i = 0; i < 20000 && !store.snapshot?.includes('"step":"reconnect"'); i++) await new Promise((r) => setTimeout(r, 0));
        // Storage was full: the reloaded tab has the state but not the backup.
        const lossy = { ...store, load: () => { const x = store.load(); return x && { ...x, backupSvil: null }; } };
        const state = await (await UpdateFlow.restore(host, lossy))!.run();
        expect(state.failure?.id).toBe("F16");
        expect(state.settingsResetSent).toBe(false);
        expect(board.requests.some((r) => r.op === Op.SETTINGS_RESET)).toBe(false);
        expect(host.events).not.toContain("0x2A");
    });

    it("reports F6 when the tab went away mid-transfer", async () => {
        const { host, plan: p } = await plan();
        const store = memoryFlowStore();
        const flow = UpdateFlow.create(host, store, { plan: p as Plan, afterwards: "restore", backup: null });
        // Saved as if the tab died while sending the other half's file.
        store.save({ ...flow.state, step: "other-send" });
        const state = await (await UpdateFlow.restore(host, store))!.run();
        expect(state.failure?.id).toBe("F6");
    });
});
