// Reads of an unsettled board, in virtual time against the mock board with the mule's
// timing: a conclusion that something failed, or that sends the person down another path,
// comes only from a settled board.
import { beforeEach, describe, expect, it } from "vitest";

import type { FirmwareReleasePin } from "@/constants/firmware-releases";
import { readBoardSummary } from "@/features/firmware/board-summary";
import { failureCopy } from "@/features/firmware/failures";
import { planInstall } from "@/services/updater/checks";
import { UpdaterClient } from "@/services/updater/client";
import { DEFAULT_TIMING, slowTiming, type FakeTiming, type Fault } from "@/services/updater/fake-board";
import { fakeSetup, fixtureOneImage, FlakyInfoTransport, type FixtureRelease } from "@/services/updater/fake-host";
import { memoryFlowStore, UpdateFlow } from "@/services/updater/flow";
import { HAND_LEFT, HAND_RIGHT, Op } from "@/services/updater/protocol";
import { DisconnectedError, VirtualClock, type UpdaterTransport } from "@/services/updater/transport";

let clock: VirtualClock;
let x10: FixtureRelease;
let x11: FixtureRelease;

beforeEach(async () => {
    clock = new VirtualClock();
    x10 ??= await fixtureOneImage("x4test10", 10);
    x11 ??= await fixtureOneImage("x4test11", 11);
});

const pin = (r: FixtureRelease): FirmwareReleasePin => ({
    tag: r.tag, kind: "x", fwVersion: r.fwVersion, updaterProtocol: 4,
    file: { uf2: `svalboard_sval_${r.tag}.uf2`, sha256: r.files[HAND_LEFT].sha256, size: r.files[HAND_LEFT].bytes.length },
    notesUrl: "",
});

/** The owner's update on the mule: x4test10 to the pair UF2 x4test11, from a file, one chord. */
async function update(timing: Partial<FakeTiming> = {}, faults: Fault[] = [], o: { running?: FixtureRelease; file?: FixtureRelease; source?: "file" | "release"; onlyHand?: 0 | 1; otherRunning?: FixtureRelease; afterwards?: "restore" | "defaults"; sides?: boolean } = {}) {
    const { board, host } = fakeSetup({
        clock, running: o.running ?? x10, timing: { ...DEFAULT_TIMING, ...timing }, faults,
        otherRunning: o.otherRunning ? { tag: o.otherRunning.tag, fwVersion: o.otherRunning.fwVersion } : undefined,
        sides: o.sides ? { supported: true } : undefined,
    });
    const file = o.file ?? x11;
    const source = o.source === "release" ? { kind: "release" as const, release: pin(file), files: file.files } : { kind: "file" as const, files: [file.files[HAND_LEFT]] };
    const p = await planInstall(new UpdaterClient(board), source, { clock, releases: [pin(x11), pin(x10)], onlyHand: o.onlyHand, sides: host.sides });
    if ("id" in p) throw new Error(`plan failed: ${p.id}`);
    const flow = UpdateFlow.create(host, memoryFlowStore(), { plan: p, afterwards: o.afterwards ?? "restore", backup: { fileName: "Kip-layout.svil", svil: "{}" } });
    const state = await flow.run();
    return { board, host, state };
}

describe("after the half with USB takes COMMIT", () => {
    it("the mule's timing: the update ends on the new release", async () => {
        const { board, state } = await update();
        expect(state.phase).toBe("result");
        expect(board.halves[HAND_LEFT].cfg.fwVersion).toBe(11);
        expect(board.halves[HAND_RIGHT].cfg.fwVersion).toBe(11);
    });

    it("twice the mule's timing (the worst case): still ends on the new release", async () => {
        const { state } = await update(slowTiming());
        expect(state.phase).toBe("result");
    });

    it("old firmware still answering 8 s after COMMIT is not a failed install: Keybard waits for the restart (the mule's false F5)", async () => {
        const { board, state } = await update({ usbCommitStartMs: 8000 });
        expect(state.failure ?? null).toBeNull();
        expect(state.phase).toBe("result");
        expect(board.usbReboots).toBeGreaterThanOrEqual(1);
        // The half answered INFO with its old version after COMMIT; that read wasn't taken as the result.
        expect(state.result?.tags[HAND_RIGHT]).toBe("x4test11");
    });

    it("a half that refuses to write (ERROR, old firmware) is F5, nothing was changed, in one sentence", async () => {
        const { state } = await update({}, [{ kind: "commit-refused" }]);
        expect(state.failure?.id).toBe("F5");
        expect(state.failure?.detail).toBeUndefined();
        const body = failureCopy(state.failure!, { fromTag: "x4test10" }).body as { props: { children: unknown[] } };
        expect(JSON.stringify(body)).toContain("Nothing was changed: your keyboard still runs x4test10.");
        expect(JSON.stringify(body)).not.toContain("old firmware");
    });

    it("a half that never says it restarted or what it runs: F23, never \"nothing was changed\"", async () => {
        const { state } = await update({ usbCommitStartMs: 10 * 60_000 });
        expect(state.failure?.id).toBe("F23");
        expect(failureCopy(state.failure!).title).toBe("Keybard couldn't confirm the update");
        expect(String(failureCopy(state.failure!).body)).not.toMatch(/Nothing was changed/);
    });
});

describe("a reinstall of the version the board runs (the mule: x4test12 over x4test12)", () => {
    const installedTwice = (state: Awaited<ReturnType<typeof update>>["state"], board: Awaited<ReturnType<typeof update>>["board"]) => {
        expect(state.failure ?? null).toBeNull();
        expect(state.phase).toBe("result");
        expect(state.result?.tags).toMatchObject({ [HAND_LEFT]: "x4test11", [HAND_RIGHT]: "x4test11" });
        expect(board.usbReboots).toBeGreaterThanOrEqual(1);
    };

    it("from a file: installed, like any install (the owner's exact case)", async () => {
        const { board, state } = await update({}, [], { running: x11, file: x11 });
        installedTwice(state, board);
    });

    it("from a file, the COMMIT reply lost: still installed, never \"nothing was changed\"", async () => {
        const { board, state } = await update({}, [{ kind: "commit-reply-lost" }], { running: x11, file: x11 });
        installedTwice(state, board);
    });

    it("its old firmware still answering the same version after COMMIT: waits for the restart", async () => {
        const { board, state } = await update({ usbCommitStartMs: 8000 }, [], { running: x11, file: x11 });
        installedTwice(state, board);
    });

    it("twice the mule's timing", async () => {
        const { board, state } = await update(slowTiming(), [], { running: x11, file: x11 });
        installedTwice(state, board);
    });

    it("Reinstall from Other versions (a carried release)", async () => {
        const { board, state } = await update({}, [], { running: x11, file: x11, source: "release" });
        installedTwice(state, board);
    });

    it("with the default layout: the same build resets nothing, so Keybard resets it", async () => {
        const { board, state } = await update({}, [], { running: x11, file: x11, afterwards: "defaults" });
        installedTwice(state, board);
        expect(state.result?.layout).toBe("defaults");
    });

    it("one-image sides known before and after: nothing asked", async () => {
        const { board, state } = await update({}, [], { running: x11, file: x11, sides: true });
        installedTwice(state, board);
    });

    it("Finish update (halves differ): the half with USB already on the version, the other half gets it", async () => {
        const { board, state } = await update({}, [], { running: x11, otherRunning: x10, file: x11, onlyHand: HAND_LEFT });
        expect(state.failure ?? null).toBeNull();
        expect(board.halves[HAND_LEFT].cfg.fwVersion).toBe(11);
    });

    it("one half only, the half with USB, same version: installed", async () => {
        const { state } = await update({}, [], { running: x11, file: x11, onlyHand: HAND_RIGHT });
        expect(state.failure ?? null).toBeNull();
        expect(state.phase).toBe("result");
    });

    it("the version name's late reply taken as the version number, just after the restart: installed (the mule's x4test12 reinstall)", async () => {
        const { board, state } = await update({}, [{ kind: "info-crossed" }], { running: x11, file: x11 });
        expect(state.phase).toBe("result");
        expect(board.halves[HAND_RIGHT].cfg.fwVersion).toBe(11);
    });

    it("the same crossed replies on an update to a newer version: installed", async () => {
        const { state } = await update({}, [{ kind: "info-crossed" }]);
        expect(state.phase).toBe("result");
    });

    it("a refusal when it came to write is still F5, the same version or not", async () => {
        const { state } = await update({}, [{ kind: "commit-refused" }], { running: x11, file: x11 });
        expect(state.failure?.id).toBe("F5");
    });
});

describe("the Firmware card's read", () => {
    it("retries a missed INFO and reads the board (the mule's legacy card)", async () => {
        const { board } = fakeSetup({ clock, running: x10 });
        const s = await readBoardSummary(new FlakyInfoTransport(board, clock, 1), null, undefined, { clock });
        expect(s.updater).toBe(true);
        expect(s.unread).toBeUndefined();
        expect(s.halves.map((h) => h.tag)).toEqual(["x4test10", "x4test10"]);
    });

    it("the version name's reply taken as the version number is read again, not legacy (the mule's Install by hand card)", async () => {
        const { board } = fakeSetup({ clock, running: x10, faults: [{ kind: "info-crossed" }] });
        const s = await readBoardSummary(board, null, undefined, { clock });
        expect(s.updater).toBe(true);
        expect(s.halves.map((h) => h.tag)).toEqual(["x4test10", "x4test10"]);
    });

    it("a board that keeps not answering is unread, not legacy", async () => {
        const { board } = fakeSetup({ clock, running: x10 });
        const t = new FlakyInfoTransport(board, clock, "always");
        const s = await readBoardSummary(t, { svil_proto: 3, keycode_version_reported: 1, feature_flags2: 1 } as never, undefined, { clock });
        expect(s.unread).toBe(true);
        expect(s.updater).toBe(false);
        expect(s.legacyLabel).toBeNull();
    });

    it("firmware that predates the updater (vLaunch and older, from GET_INFO) is legacy without INFO", async () => {
        const { board } = fakeSetup({ clock, running: x10 });
        const t = new FlakyInfoTransport(board, clock, "always");
        const s = await readBoardSummary(t, { svil_proto: 3, keycode_version_reported: 1, feature_flags2: 0 } as never, undefined, { clock });
        expect(s.unread).toBeUndefined();
        expect(s.updater).toBe(false);
        expect(s.legacyLabel).toBe("Svalboard QMK vLaunch");
    });

    it("a board that answers as protocol 3 is legacy at once (no retries)", async () => {
        const { board } = fakeSetup({ clock, running: { tag: "x3.1.3", fwVersion: 2301 }, half: { protocol: 3 } });
        const t0 = clock.now();
        const s = await readBoardSummary(board, null, undefined, { clock });
        expect(s.legacyLabel).toBe("x3.1.3");
        expect(clock.now() - t0).toBeLessThan(500);
    });

    it("a disconnected board isn't retried", async () => {
        let tries = 0;
        const gone: UpdaterTransport = {
            request: async () => { tries++; throw new DisconnectedError(); },
            clientId: () => 1, ensureClient: async () => 1, renewClient: async () => 1,
            onClientRenewed: () => () => undefined, onDisconnect: () => () => undefined, connected: () => false,
        };
        expect((await readBoardSummary(gone, null, undefined, { clock })).unread).toBe(true);
        expect(tries).toBe(1);
    });

    it("just after a boot, waits for the split link before calling the other half silent", async () => {
        const { board } = fakeSetup({ clock, running: x10 });
        board.flashByHand(HAND_RIGHT, { fwVersion: 10, tag: "x4test10", imageId: board.halves[HAND_RIGHT].cfg.imageId });
        const s = await readBoardSummary(board, null, undefined, { clock });
        expect(s.halves.find((h) => h.hand === HAND_LEFT)?.answered).toBe(true);
        expect(s.differ).toBe(false);
    });

    it("INFO on the mock: Op.INFO is what FlakyInfoTransport drops", () => {
        expect(Op.INFO).toBe(0);
    });
});
