// Dev-only harness for the firmware flow, before Settings hosts it (M3).
//   ?fake=1 (default)  the mock board: &fault=held-lapse|not-confirmed|unplug-other-send|...
//                      &nochord=1  &running=v3|x4  &usb=left|right  &speed=4
//   ?real=1            the keyboard over WebHID (Connect), with the app's backup and restore
//   ?gallery=1         every screen at once, for review screenshots
//   &theme=dark        dark mode
//   &sides=<scenario>  one-image firmware: the release is one image, and the board has SIDE
//                      (scenarios in services/updater/fake-sides-scenarios.ts)

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { BackupProvider } from "@/contexts/BackupContext";
import { ChangesProvider } from "@/contexts/ChangesContext";
import { KeyboardProvider, useKeyboard } from "@/contexts/KeyboardContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import type { FirmwareReleasePin } from "@/constants/firmware-releases";
import type { Fault } from "@/services/updater/fake-board";
import { FakeHost, fakeSetup, fixtureOneImage, type FixtureRelease } from "@/services/updater/fake-host";
import { sidesScenario } from "@/services/updater/fake-sides-scenarios";
import type { SideWrite } from "@/services/side-decision";
import { applySideWrites } from "../side-actions";
import { HAND_LEFT, HAND_RIGHT, type Hand } from "@/services/updater/protocol";
import type { SvupFile } from "@/services/updater/svup";
import type { Clock } from "@/services/updater/transport";
import { usbInstance } from "@/services/usb.service";
import { WebHidUpdaterTransport } from "@/services/updater/webhid-transport";
import { readBoardSummary, type BoardSummary } from "../board-summary";
import { loadCarriedRelease } from "../carried";
import type { FailureAction } from "../failures";
import { FirmwareSection, type FirmwarePick } from "../FirmwareSection";
import { ManualInstall } from "../ManualInstall";
import { UpdateDialog } from "../UpdateDialog";
import { useAppFirmwareHost } from "../useAppFirmwareHost";
import { useFirmwareUpdate, type FirmwareUiHost, type UpdateBackup } from "../useFirmwareUpdate";
import { Gallery } from "./Gallery";

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/** Real time, sped up: the mock board's two minutes in thirty seconds at speed 4. */
export class ScaledClock implements Clock {
    private t0 = Date.now();
    private p0 = performance.now();
    constructor(private speed = 4) {}
    now() { return this.t0 + (performance.now() - this.p0) * this.speed; }
    sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms / this.speed)); }
}

export function pinOf(r: FixtureRelease): FirmwareReleasePin {
    return {
        tag: r.tag, kind: r.tag.startsWith("x") ? "x" : "v", fwVersion: r.fwVersion, updaterProtocol: 4,
        file: { uf2: `svalboard_sval_${r.tag}.uf2`, sha256: r.files[HAND_LEFT].sha256, size: r.files[HAND_LEFT].bytes.length },
        notesUrl: "https://github.com/svalboard/qmk/releases",
    };
}

function parseFaults(): Fault[] {
    const f = params.get("fault");
    if (!f) return [];
    if (f.startsWith("unplug-")) return [{ kind: "unplug", at: f.slice(7) as "other-send" }];
    if (f === "bad-hash") return [{ kind: "bad-hash", hand: HAND_LEFT }];
    return [{ kind: f } as Fault];
}

class HarnessFakeHost extends FakeHost implements FirmwareUiHost {
    async makeBackup({ fromTag }: { fromTag: string }): Promise<UpdateBackup> {
        await this.clock.sleep(400);
        return { fileName: `Kip-${fromTag}-2026-10-15.svil`, svil: "{}" };
    }
    async prepareRows() { return []; }
    boardName() { return "Kip"; }
    chordLegends(hand: Hand): [string, string] { return hand === HAND_RIGHT ? ["M", ","] : ["V", "C"]; }
}

function Page({ children, title }: { children: ReactNode; title: string }) {
    return (
        <div className="min-h-screen bg-kb-gray text-kb-ink">
            <div className="mx-auto flex max-w-xl flex-col gap-4 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
                {children}
            </div>
        </div>
    );
}

function useDialogWiring(host: FirmwareUiHost | null, releases: FirmwareReleasePin[], files: (pin: FirmwareReleasePin) => Promise<Record<Hand, SvupFile>>) {
    const fw = useFirmwareUpdate(host, { releases });
    const [manual, setManual] = useState<FirmwareReleasePin | null | undefined>(undefined);
    const install = useCallback(async (pick: FirmwarePick, onlyHand?: Hand) => {
        if (pick.kind === "files") return fw.openSheet({ kind: "file", files: pick.files }, onlyHand);
        return fw.openSheet({ kind: "release", release: pick.release, files: await files(pick.release) }, onlyHand);
    }, [fw, files]);
    const onFailureAction = (a: FailureAction) => {
        if (a === "retry") fw.retry();
        else if (a === "finish") fw.finish();
        else if (a === "reload") location.reload();
        else if (a === "manual" || a === "download") { fw.close(); setManual(releases[0] ?? null); }
        else fw.close();
    };
    const dialog = host && (
        <UpdateDialog
            ui={fw.ui}
            now={() => host.clock.now()}
            chordLegends={(h) => host.chordLegends(h)}
            cancellable={!!fw.flow?.cancellable}
            onAfterwards={fw.setAfterwards}
            onStart={fw.start}
            onCancel={() => (fw.ui.kind === "flow" ? fw.flow?.cancel() : fw.close())}
            onClose={fw.close}
            onFailureAction={onFailureAction}
            onFixSides={(w) => void fw.fixSides(w)}
            onAnswerSide={fw.answerSide}
        />
    );
    return { fw, install, dialog, manual, setManual };
}

function FakeHarness() {
    const [ready, setReady] = useState<{ host: HarnessFakeHost; releases: FirmwareReleasePin[]; byTag: Record<string, FixtureRelease> } | null>(null);
    const [board, setBoard] = useState<BoardSummary | null>(null);
    useEffect(() => {
        void (async () => {
            const size = 0x1e000; // a release image's size
            const v2 = await fixtureOneImage("v2", 7, { imageLen: size });
            const v3 = await fixtureOneImage("v3", 8, { imageLen: size });
            const sides = sidesScenario(params.get("sides"));
            const x4 = await fixtureOneImage("x4", 9, { imageLen: size, noChord: params.has("nochord") });
            const running = params.get("running") === "x4" ? x4 : params.get("running") === "v2" ? v2 : v3;
            const clock = new ScaledClock(Number(params.get("speed") ?? 4));
            const { board: fake, sides: fakeSides } = fakeSetup({
                clock, running, noChord: params.has("nochord"), faults: parseFaults(), usbHand: params.get("usb") === "left" ? HAND_LEFT : HAND_RIGHT,
                chordAfterMs: params.get("chord") === "never" ? "never" : 3000, sides,
            });
            const host = new HarnessFakeHost(fake, clock);
            host.sides = fakeSides?.host;
            const releases = [pinOf(x4), pinOf(v3)];
            setReady({ host, releases, byTag: { v2, v3, x4 } });
        })();
    }, []);
    const files = useCallback(async (pin: FirmwareReleasePin) => ready!.byTag[pin.tag].files, [ready]);
    const { fw, install, dialog, manual, setManual } = useDialogWiring(ready?.host ?? null, ready?.releases ?? [], files);
    const refresh = useCallback(() => { if (ready) void readBoardSummary(ready.host.board, null, ready.host.sides, { clock: ready.host.clock }).then(setBoard).catch(() => setBoard(null)); }, [ready]);
    useEffect(() => { refresh(); }, [refresh, fw.ui.kind]);
    const [side, setSide] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
    const applySides = useCallback((writes: SideWrite[]) => {
        if (!ready) return;
        setSide({ busy: true, note: null });
        void applySideWrites(ready.host, writes).then((note) => { setSide({ busy: false, note }); refresh(); });
    }, [ready, refresh]);
    if (!ready) return <Page title="Firmware harness · mock board">Building fixture files…</Page>;
    return (
        <Page title="Firmware harness · mock board">
            <FirmwareSection board={board} releases={ready.releases} onInstall={install} onManual={(r) => setManual(r)} sides={{ ...side, apply: applySides }} />
            {dialog}
            {manual !== undefined && (
                <div className="rounded-md border border-kb-gray-border bg-kb-surface p-4">
                    <ManualInstall release={manual} backup={null} afterwards="defaults" onAfterwards={() => undefined} onConnect={() => setManual(undefined)} onClose={() => setManual(undefined)} />
                </div>
            )}
        </Page>
    );
}

function RealInner() {
    const kb = useKeyboard();
    const host = useAppFirmwareHost();
    const releases = useMemo<FirmwareReleasePin[]>(() => [], []);
    const files = useCallback((pin: FirmwareReleasePin) => loadCarriedRelease(pin), []);
    const { fw, install, dialog } = useDialogWiring(host, releases, files);
    const [board, setBoard] = useState<BoardSummary | null>(null);
    const [stats, setStats] = useState("");
    useEffect(() => {
        if (!kb.isConnected || !kb.keyboard) { setBoard(null); return; }
        const t = new WebHidUpdaterTransport(usbInstance);
        void readBoardSummary(t, kb.keyboard).then(setBoard).catch(() => setBoard(null));
    }, [kb.isConnected, kb.keyboard, kb.connectionSessionId, fw.ui.kind]);
    useEffect(() => {
        const s = fw.ui.kind === "flow" ? fw.ui.state.measurements : null;
        if (s) setStats(JSON.stringify(s));
    }, [fw.ui]);
    return (
        <Page title="Firmware harness · keyboard over WebHID">
            <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void kb.connect()}>{kb.isConnected ? "Reconnect" : "Connect"}</Button>
                <span className="text-sm text-muted-foreground">{kb.connectionState}{kb.keyboard ? ` · ${kb.keyboard.name ?? ""}` : ""}</span>
            </div>
            <FirmwareSection board={board} releases={releases} onInstall={install} onManual={() => undefined} onConnect={() => void kb.connect()} />
            {stats && <pre className="whitespace-pre-wrap text-xs" data-testid="measurements">{stats}</pre>}
            {dialog}
        </Page>
    );
}

function RealHarness() {
    return (
        <KeyboardProvider>
            <SettingsProvider>
                <ChangesWithKeyboard>
                    <BackupProvider>
                        <RealInner />
                    </BackupProvider>
                </ChangesWithKeyboard>
            </SettingsProvider>
        </KeyboardProvider>
    );
}

function ChangesWithKeyboard({ children }: { children: ReactNode }) {
    const { markAsSaved, getKeyboardSnapshot, isConnected, connectionSessionId, registerTargetChangeGuard, getKeyBlockWriter } = useKeyboard();
    return (
        <ChangesProvider captureSave={() => { const snapshot = getKeyboardSnapshot(); return () => { if (snapshot) markAsSaved(snapshot); }; }} canWrite={isConnected} sessionKey={connectionSessionId} registerTargetChangeGuard={registerTargetChangeGuard} keyBlockWriter={getKeyBlockWriter}>
            {children}
        </ChangesProvider>
    );
}

export function HarnessApp() {
    if (params.has("gallery")) return <Gallery />;
    if (params.has("real")) return <RealHarness />;
    return <FakeHarness />;
}
