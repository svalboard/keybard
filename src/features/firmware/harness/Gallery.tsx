// Every firmware screen at once, from fixed states, for review screenshots.

import type { ReactNode } from "react";

import { ResetNoticeView } from "@/components/StorageResetDialog";
import { Dialog } from "@/components/ui/dialog";
import type { FirmwareReleasePin } from "@/constants/firmware-releases";
import type { BoardState, CheckRow, Plan } from "@/services/updater/checks";
import type { FlowState, RowState, Step } from "@/services/updater/flow";
import type { Info0, StatusReply } from "@/services/updater/protocol";
import type { SvupFile } from "@/services/updater/svup";
import type { BoardSummary } from "../board-summary";
import { FailureView } from "../failures";
import { FirmwareSection } from "../FirmwareSection";
import { ManualInstall } from "../ManualInstall";
import { ConfirmView, ProgressView } from "../ProgressDialog";
import { HalvesDifferView } from "../HalvesDifferBanner";
import { ResultView } from "../UpdateDialog";
import { UpdateSheet } from "../UpdateSheet";
import type { UpdateUi } from "../useFirmwareUpdate";

const NOW = 1_760_000_100_000;
const legends = (h: number): [string, string] => (h === 1 ? ["M", ","] : ["V", "C"]);

const pin = (tag: string, fw: number): FirmwareReleasePin => ({
    tag, kind: tag.startsWith("x") ? "x" : "v", fwVersion: fw, updaterProtocol: 4,
    file: { uf2: `svalboard_sval_${tag}.uf2`, sha256: "", size: 0 },
    notesUrl: "https://github.com/svalboard/qmk/releases",
});
const RELEASES = [pin("x4", 9), pin("v3", 8)];

const half = (hand: 0 | 1, tag: string, fw: number, usb: boolean) => ({ hand, usb, tag, fwVersion: fw, answered: true });
const BOARD: BoardSummary = { updater: true, legacyLabel: null, usbHand: 1, halves: [half(0, "v3", 8, false), half(1, "v3", 8, true)], differ: false, noChord: false, fwVersion: 8, tag: "v3" };
const UP_TO_DATE: BoardSummary = { ...BOARD, halves: [half(0, "x4", 9, false), half(1, "x4", 9, true)], fwVersion: 9, tag: "x4" };
const DIFFER: BoardSummary = { ...BOARD, halves: [half(0, "build 9", 9, false), half(1, "v3", 8, true)], differ: true };
const LEGACY: BoardSummary = { updater: false, legacyLabel: "Svalboard QMK vLaunch2 or later", usbHand: 1, halves: [], differ: false, noChord: false, fwVersion: 0, tag: "" };

const info0 = (o: Partial<Info0>): Info0 => ({
    status: 0, state: 0, answered: true, protocol: 4, slotBase: 0, slotSize: 0, maxImage: 0x160000, jedec: "ef4018", pointingId: 5, hand: 1,
    fwVersion: 8, storageFormat: 2, securityEpoch: 0, flags: 1, flash16MiB: true, writesFailing: false, releaseBuild: true, testHooks: false,
    otherDiffers: false, noChord: false, lastError: 0, chunkMax: 50, manifestMax: 52, reportBytes: 64, ...o,
});
const status = { presence: 1 } as StatusReply;
const boardState = (noChord = false): BoardState => ({ usb: info0({ noChord }), usbTag: "v3", other: info0({ hand: 0 }), status, noChord });
const file = { manifest: { tag: "x4" } } as unknown as SvupFile;
const plan = (o: Partial<Plan> = {}): Plan => ({
    board: boardState(), target: "both", files: { 0: file, 1: file }, kind: "update", toTag: "x4", fromTag: "v3", title: "Update to x4",
    checks: [],
    warnings: [], refusal: null, otherSilent: false, pinned: true, sidesBefore: { usb: "right", other: "left" }, oneImage: true, sidesFromSide: true, ...o,
});
const sheet = (p: Plan, backup: "ok" | "failed" | "pending" = "ok"): Extract<UpdateUi, { kind: "sheet" }> => ({
    kind: "sheet", source: { kind: "file", files: [] }, plan: p, preFailure: null, error: null, afterwards: backup === "failed" ? "defaults" : "restore",
    backup: backup === "ok" ? { state: "ok", fileName: "Kip-layout-2026-10-15-0626.svil", backup: { fileName: "Kip-layout-2026-10-15-0626.svil", svil: "" } } : backup === "failed" ? { state: "failed", error: "" } : { state: "pending" },
});

function flow(step: Step, rows: Array<Partial<RowState> & { hand: 0 | 1 }>, o: Partial<FlowState> = {}): FlowState {
    return {
        version: 1, id: "g", phase: "running", target: "both", usbHand: 1, title: "Update to x4", toTag: "x4", fromTag: "v3", files: {},
        afterwards: "restore", backup: { fileName: "Kip-layout-2026-10-15-0626.svil" }, noChord: false, step, stepAt: NOW - 8, approveAt: NOW - 6000,
        rows: rows.map((r) => ({ usb: r.hand === 1, stage: "waiting", progress: 0, fromTag: "v3", toTag: "x4", ...r })), committed: [], halvesDone: [],
        approvalsAsked: 1, settingsResetSent: false, sent2A: false, startedAt: NOW - 60000, finishedAt: null, result: null, failure: null, measurements: {}, ...o,
    };
}

const STAGES: Array<[string, FlowState]> = [
    ["Sending the left half's firmware", flow("other-send", [{ hand: 0, stage: "sending", progress: 0.42 }, { hand: 1 }])],
    ["Copying over the split cable", flow("relay", [{ hand: 0, stage: "copying", progress: 0.63 }, { hand: 1 }])],
    ["Left half installs", flow("other-install", [{ hand: 0, stage: "installing", progress: null }, { hand: 1 }], { committed: [0] })],
    ["Between the halves (red is expected)", flow("other-restart", [{ hand: 0, stage: "done", progress: 1 }, { hand: 1 }], { committed: [0] })],
    ["U3 Sending the right half's firmware", flow("self-send", [{ hand: 0, stage: "done", progress: 1 }, { hand: 1, stage: "sending", progress: 0.3 }], { committed: [0] })],
    ["Right half installs", flow("self-install", [{ hand: 0, stage: "done", progress: 1 }, { hand: 1, stage: "installing", progress: null }], { committed: [0, 1] })],
    ["U4 Restart and reconnect", flow("reconnect", [{ hand: 0, stage: "done", progress: 1 }, { hand: 1, stage: "reconnecting", progress: null }], { committed: [0, 1], stepAt: NOW - 9 })],
    ["U5 Putting the layout back", flow("restore", [{ hand: 0, stage: "done", progress: 1 }, { hand: 1, stage: "restoring", progress: null }], { committed: [0, 1] })],
];

const RESULT = flow("done", [{ hand: 0, stage: "done", progress: 1 }, { hand: 1, stage: "done", progress: 1 }], {
    phase: "result", committed: [0, 1], result: { tags: { 0: "x4", 1: "x4" }, layout: "restored", trimmed: ["Combos: 6 of 8 (this firmware has 6)"] },
});

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    return (
        <section data-screen={id} className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{id} · {title}</p>
            <div className="rounded-lg border border-kb-gray-border bg-kb-surface p-5 shadow-sm">{children}</div>
        </section>
    );
}

const noop = () => undefined;
const warnings: CheckRow[] = [
    { id: "unknown-file", label: "Keybard can't check where this file came from.", state: "warn", detail: "Install it only if you trust where you got it." },
    { id: "pointing-0", label: "This file has no trackball driver.", state: "warn", detail: "Pointing stops working on the left half." },
    { id: "older", label: "v3 is older than x4.", state: "warn", detail: "Parts of your layout added since v3 won't come back." },
];
const CONFIRM = flow("approve", [{ hand: 0, stage: "approve", progress: null }, { hand: 1, stage: "approve", progress: null }]);
const CHECK_ONE = { halves: { 0: { state: "old" as const, tag: "x3.1.3" }, 1: { state: "new" as const } } };

export function Gallery() {
    // ?gallery=1&screen=B1, or #B1 (and #B1,dark) where a shell eats the ampersand.
    const only = new URLSearchParams(location.search).get("screen") ?? (location.hash.slice(1).split(",")[0] || null);
    const show = (id: string) => !only || only === id;
    return (
        <div className="min-h-screen bg-kb-gray text-kb-ink">
            <div className="mx-auto flex max-w-xl flex-col gap-8 p-4" style={location.hash.includes("phone") ? { maxWidth: 390, padding: 16 } : undefined}>
                {show("D2") && <Card id="D2" title="Firmware page, update available"><FirmwareSection board={BOARD} releases={RELEASES} onInstall={noop} onManual={noop} paranoid={false} /></Card>}
                {show("D2a") && <Card id="D2a" title="Up to date"><FirmwareSection board={UP_TO_DATE} releases={RELEASES} onInstall={noop} onManual={noop} paranoid={false} /></Card>}
                {show("D2b") && <Card id="D2b" title="No usable updater"><FirmwareSection board={LEGACY} releases={RELEASES} onInstall={noop} onManual={noop} paranoid={false} /></Card>}
                {show("D2c") && <Card id="D2c" title="Halves differ"><FirmwareSection board={DIFFER} releases={RELEASES} onInstall={noop} onManual={noop} paranoid={false} /></Card>}
                {show("D2e") && <Card id="D2e" title="No keyboard"><FirmwareSection board={null} releases={RELEASES} onInstall={noop} onManual={noop} paranoid={false} /></Card>}
                {show("B1") && <Card id="B1" title="Start"><UpdateSheet ui={sheet(plan())} onAfterwards={noop} onStart={noop} onCancel={noop} /></Card>}
                {show("B1w") && <Card id="B1w" title="With warnings"><UpdateSheet ui={sheet(plan({ title: "Install custom firmware", kind: "custom", warnings }))} onAfterwards={noop} onStart={noop} onCancel={noop} /></Card>}
                {show("B1b") && <Card id="B1b" title="Backup failed"><UpdateSheet ui={sheet(plan(), "failed")} onAfterwards={noop} onStart={noop} onCancel={noop} onSaveManually={noop} /></Card>}
                {show("F2") && <Card id="F2" title="Integrity refusal"><UpdateSheet ui={sheet(plan({ refusal: { id: "integrity", label: "The firmware file failed its check.", state: "refuse", detail: "Keybard won't install it. Reload Keybard and try again." } }))} onAfterwards={noop} onStart={noop} onCancel={noop} /></Card>}
                {show("C") && <Card id="C" title="Confirm on your keyboard"><ConfirmView state={CONFIRM} legends={legends(1)} now={NOW} /></Card>}
                {STAGES.map(([title, s], i) => show(`P${i}`) && <Card key={i} id={`P${i}`} title={title}><ProgressView state={s} now={NOW} /></Card>)}
                {show("A1") && <Card id="A1" title="Done"><ResultView state={RESULT} onDone={noop} /></Card>}
                {show("A4") && <Card id="A4" title="Layout reset outside an update"><div className="flex flex-col gap-4"><DialogShell><ResetNoticeView firmware firmwareNow="x4 on both halves" backupLine="Backup saved before the update, today 10:42 AM" onDefaults={noop} onOtherBackups={noop} onPutBack={noop} /></DialogShell></div></Card>}
                {show("F9") && <Card id="F9" title="Halves differ"><FailureView failure={{ id: "F9", tags: { 0: "x4", 1: "v3" } }} onAction={noop} /></Card>}
                {show("F9b") && <Card id="F9" title="Banner on connect"><HalvesDifferView board={DIFFER} onFinish={noop} /></Card>}
                {show("F5") && <Card id="F5" title="Update stopped"><FailureView failure={{ id: "F5", tags: { 0: "v3", 1: "v3" } }} fromTag="v3" onAction={noop} /></Card>}
                {show("M") && <Card id="M" title="Install by hand"><ManualInstall release={RELEASES[0]} once backup={{ state: "ok", fileName: "Kip-layout-2026-10-15-0626.svil" }} afterwards="restore" onAfterwards={noop} onConnect={noop} onClose={noop} /></Card>}
                {show("M1") && <Card id="M1" title="One half not done"><ManualInstall release={RELEASES[0]} once backup={{ state: "ok", fileName: "Kip-layout-2026-10-15-0626.svil" }} afterwards="restore" onAfterwards={noop} check={CHECK_ONE} onConnect={noop} onClose={noop} /></Card>}
                {show("M2") && <Card id="M2" title="Done"><ManualInstall release={RELEASES[0]} once backup={{ state: "ok", fileName: "Kip-layout-2026-10-15-0626.svil" }} afterwards="restore" onAfterwards={noop} outcome={{ phase: "done", result: { layout: "restored", trimmed: [] }, error: null }} onConnect={noop} onClose={noop} /></Card>}
            </div>
        </div>
    );
}

/** Radix DialogTitle and DialogDescription need a Dialog root around them. */
function DialogShell({ children }: { children: ReactNode }) {
    return <Dialog open={false}>{children}</Dialog>;
}
