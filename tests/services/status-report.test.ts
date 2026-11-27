// Status report (Sval 0x3F): the page parsers, the read of the whole report,
// the rows and the copied text, and the simulated board's answers
// (keyboards/svalboard/status_report.c).
import { describe, expect, it } from "vitest";
import { blankBoard } from "@/dev/fake-board/board";
import { FakeSvalFirmware, FLAG5_STATUS_REPORT } from "@/dev/fake-board/firmware";
import { CMD_SVIL_STATUS_REPORT, hasStatusReport, parseStatusBuild, parseStatusState, readBoardStatus, statusGroups, statusText, type BoardStatus } from "@/services/status-report";

const L = 64;
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function bootstrap(fw: FakeSvalFirmware, seed: number): number {
    for (;;) {
        const req = new Uint8Array(L);
        req[0] = 0xdd;
        for (let i = 0; i < 20; i++) req[5 + i] = (i * 37 + seed) & 0xff;
        const id = le32(fw.receive(req)!, 25);
        if (id !== 0) return id;
    }
}

function wrapped(id: number, payload: number[]): Uint8Array {
    const req = new Uint8Array(L);
    req[0] = 0xdd;
    req[1] = id & 0xff; req[2] = (id >>> 8) & 0xff; req[3] = (id >>> 16) & 0xff; req[4] = (id >>> 24) & 0xff;
    req[5] = 0xdf;
    req.set(payload, 6);
    return req;
}

/** Page 0 as the firmware packs it (status_report.c), after the wrapper. */
function statePage(fill: (p: Uint8Array) => void): Uint8Array {
    const r = new Uint8Array(58);
    r[0] = CMD_SVIL_STATUS_REPORT;
    const p = r.subarray(1);
    p[0] = 0; p[1] = 1;
    fill(p);
    return r;
}

const put16 = (p: Uint8Array, o: number, v: number) => { p[o] = v & 0xff; p[o + 1] = v >> 8; };

// The values the trackball test pair answered with (x4.6.7 + this branch, 2026-11-25).
const HARDWARE = Uint8Array.from([0x3f, ...[0x00, 0x01, 0x75, 0x02, 0x02, 0x20, 0x03, 0x20, 0x03, 0xf4, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x5a, 0x00, 0x5a, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x0a, 0x00, 0x00, 0x23, 0x02, 0x00, 0x00, 0x30, 0x7d], ...new Array(17).fill(0)]);

describe("STATUS_REPORT pages", () => {
    it("reads every field of page 0 at its offset", () => {
        const s = parseStatusState(HARDWARE)!;
        expect(s.left).toEqual({ scroll: true, cpi: 800, autoMouse: true });
        expect(s.right).toEqual({ scroll: false, cpi: 800, autoMouse: true });
        expect(s.axisLock).toBe(true);
        expect(s.naturalScroll).toBe(false);
        expect(s.autoMouse).toBe(true);
        expect(s.macMode).toBe(false);
        expect(s.hostOs).toBe(2);
        expect(s.autoMouseTimeoutMs).toBe(500);
        expect(s.boostMult).toBe(1);
        expect([s.prewaitUs, s.postwaitUs]).toEqual([90, 90]);
        expect(s.opticalDebounce).toBe(true);
        expect(s.hwRevB).toBe(false);
        expect(s.frameUs).toBe(2656);
        expect(s.ledUs).toBe(547);
        expect([s.deepMhz, s.clockMhz]).toEqual([48, 125]);
    });

    it("reads the flags, no timeout and a 32-bit frame", () => {
        const s = parseStatusState(statePage((p) => {
            p[2] = 0x80 | 0x08; p[3] = 0x01 | 0x04 | 0x08 | 0x10; p[4] = 3;
            p[11] = 1; p[13] = 2; p[14] = 0x05; p[15] = 5;
            put16(p, 30, 0x86a3); put16(p, 32, 0x0001);
            p[36] = 2; p[37] = 0x1f;
        }))!;
        expect(s.macMode && s.naturalScroll && s.hwRevB && s.storageReset && s.writeFailed).toBe(true);
        expect(s.autoMouseTimeoutMs).toBeNull();
        expect(s.boostHeld).toEqual([1, 0, 2]);
        expect(s.boostToggled).toEqual([true, false, true]);
        expect(s.frameUs).toBe(100003);
        expect(s.stage).toBe(2);
    });

    it("is null for older firmware, an unknown page and a short reply", () => {
        expect(parseStatusState(Uint8Array.from([0xff, ...new Array(57).fill(0)]))).toBeNull();
        expect(parseStatusState(statePage((p) => { p[1] = 0; }))).toBeNull();
        expect(parseStatusState(HARDWARE.slice(0, 40))).toBeNull();
        expect(parseStatusState(null)).toBeNull();
        expect(parseStatusBuild(Uint8Array.from([0xff, 1, 1, 3, 0, 3, 97, 98, 99]))).toBeNull();
    });

    it("is advertised by GET_INFO byte 22 bit 1, not bit 0 (app rules)", () => {
        expect(hasStatusReport(0x02)).toBe(true);
        expect(hasStatusReport(0x03)).toBe(true);
        expect(hasStatusReport(0x01)).toBe(false);
        expect(hasStatusReport(undefined)).toBe(false);
    });
});

describe("readBoardStatus", () => {
    it("reads the build text in chunks, then the state", async () => {
        const build = "svalboard/either:sval @ 0.30.3-120-gabcdef0123456789abcdef0123456789abcdef0123";
        const asked: [number, number][] = [];
        const s = await readBoardStatus(async (page, arg) => {
            asked.push([page, arg]);
            if (page === 0) return HARDWARE;
            const bytes = new TextEncoder().encode(build);
            const n = Math.min(bytes.length - arg, 53);
            return Uint8Array.from([0x3f, 1, 1, bytes.length, arg, Math.max(n, 0), ...bytes.subarray(arg, arg + Math.max(n, 0))]);
        });
        expect(s!.build).toBe(build);
        expect(asked).toEqual([[1, 0], [1, 53], [0, 0]]);
    });

    it("is null when the board doesn't answer", async () => {
        expect(await readBoardStatus(async () => null)).toBeNull();
        expect(await readBoardStatus(async (page) => (page === 1 ? Uint8Array.from([0x3f, 1, 1, 0, 0, 0]) : null))).toBeNull();
    });
});

describe("the rows and the copied text", () => {
    const status = (over: Partial<BoardStatus> = {}): BoardStatus => ({ build: "svalboard/either:sval @ x4.6.7", ...parseStatusState(HARDWARE)!, ...over });

    it("groups the report plainly, one short value per row", () => {
        const groups = statusGroups(status());
        expect(groups.map((g) => g.title)).toEqual(["Firmware", "Pointing", "Auto Mouse", "Computer", "Scanning", "Power"]);
        const row = (label: string) => groups.flatMap((g) => g.rows).find((r) => r.label === label)?.value;
        expect(row("Build")).toBe("svalboard/either:sval @ x4.6.7");
        expect(row("Left CPI")).toBe("800");
        expect(row("Left Scroll Mode")).toBe("On");
        expect(row("Right Scroll Mode")).toBe("Off");
        expect(row("Detected OS")).toBe("Windows");
        // Short enough for one line in a narrow panel.
        for (const g of groups) for (const r of g.rows) if (r.label !== "Build") expect(r.value.length, r.label).toBeLessThanOrEqual(24);
        expect(row("Timeout")).toBe("500 ms");
        expect(row("Turned on by")).toBe("Both pointers");
        expect(row("Scan period")).toBe("Unpaced");
        expect(row("Light idle")).toBe("Never");
        expect(row("Measured frame")).toBe("2656 µs");
        expect(row("Power saving")).toBe("None");
        expect(row("State now")).toBe("Active");
        expect(row("Clock now")).toBe("125 MHz");
        expect(row("Settings")).toBeUndefined();
        expect(row("Boost keys")).toBeUndefined();
    });

    it("says when axis lock isn't used, and shows storage problems and Boost", () => {
        const groups = statusGroups(status({ macMode: true, hostOs: 3, storageReset: true, writeFailed: true, boostMult: 3, boostToggled: [false, true, false], idleFlags: 0x09 }));
        const row = (label: string) => groups.flatMap((g) => g.rows).find((r) => r.label === label)?.value;
        expect(row("Axis scroll lock")).toBe("On, unused on Mac");
        expect(row("Settings")).toBe("Reset: storage unreadable");
        expect(row("Saving")).toBe("Fails until a restart");
        expect(row("Boost")).toBe("3x");
        expect(row("Boost keys")).toBe("3x toggled");
        expect(row("Power saving")).toBe("Pointer rest, Low clock");
    });

    it("copies as plain text: a heading per group, a line per row", () => {
        const text = statusText(status());
        expect(text.split("\n").slice(0, 4)).toEqual(["Svalboard status report", "", "Firmware", "Build: svalboard/either:sval @ x4.6.7"]);
        expect(text).toContain("Pointing\nLeft CPI: 800\nLeft Scroll Mode: On\n");
        expect(text).not.toMatch(/[<>*_`]/); // no markup to garble in Discord
    });
});

describe("the simulated board's status report", () => {
    const send = (fw: FakeSvalFirmware, id: number) => async (page: number, arg: number) => fw.receive(wrapped(id, [CMD_SVIL_STATUS_REPORT, page, arg]))!.slice(6);

    it("advertises GET_INFO byte 22 bit 1, and older firmware answers 0xFF", () => {
        const fw = new FakeSvalFirmware(blankBoard());
        const id = bootstrap(fw, 5);
        expect(fw.receive(wrapped(id, [0x00]))![5 + 22] & FLAG5_STATUS_REPORT).toBe(FLAG5_STATUS_REPORT);
        const old = new FakeSvalFirmware(blankBoard(), { statusReport: false });
        const id2 = bootstrap(old, 5);
        expect(old.receive(wrapped(id2, [0x00]))![5 + 22]).toBe(0);
        expect(old.receive(wrapped(id2, [CMD_SVIL_STATUS_REPORT, 0, 0]))![6]).toBe(0xff);
    });

    it("answers what its settings hold now", async () => {
        const fw = new FakeSvalFirmware(blankBoard());
        const id = bootstrap(fw, 7);
        const before = await readBoardStatus(send(fw, id));
        expect(before!.build).toBe(FakeSvalFirmware.STATUS_BUILD);
        fw.state.custom[1 * 2] = 1; // id_left_scroll
        fw.hostOs = 3;
        const after = await readBoardStatus(send(fw, id));
        expect(after!.left.scroll).toBe(true);
        expect(after!.macMode).toBe(true);
        expect(OS(after!.hostOs)).toBe("macOS");
    });
});

const OS = (n: number) => ({ 2: "Windows", 3: "macOS" } as Record<number, string>)[n];
