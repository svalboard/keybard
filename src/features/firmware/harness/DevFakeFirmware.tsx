// Development and the test site only (?fwfake=1): Settings > Firmware against the mock board.
// Every release is one pair UF2 for both halves (x4 on), loaded as Keybard loads a real one.
//   &running=v3|x4|v2|<tag>    what both halves run (another tag: version 8)
//   &proto=3                   a board on updater protocol 3, which installs by hand
//   &nochord=1  &fault=...  &speed=4  &differ=1  &usb=left
//   &chord=never|<ms>          when the person presses the two keys (default 3000 ms)
//   &badfile=1                 the carried x4 file misses its pin: the install is refused
//   &sides=<scenario>          one-image sides (services/updater/fake-sides-scenarios.ts)
// Install by hand: Connect stands for plugging the keyboard back in after the copy.
//   &byhand=both|left|right|none  the halves on the new firmware at the first Connect: both
//                                 (the default: the other half followed by itself), only the
//                                 half the file was copied onto, or none (every later Connect
//                                 installs the rest)
//   &silent=1                     a half still on its old firmware doesn't answer
// Zero-click review links:
//   &open=update|<tag>  open the dialog for the newest release (or that tag) once the board is read
//   &pick=x4|x3.1.3     choose a file in Install a firmware file…, as the file chooser would: the
//                       carried x4 pair UF2, or a per-side x3.1.3 file (refused)
//   &go=1               then press Update (or Connect keyboard) once it's enabled
//   &resetnotice=1      the reset notice, for what the mock board runs
// The board's answers (Firmware card, Check again):
//   &infofail=1|read|always  INFO goes unanswered: the first request (Keybard's retry reads the
//                            board), every one until the person presses Check again (the card
//                            says Keybard couldn't read the firmware first), or every one
// Timing: the mule's by default (fake-board.ts DEFAULT_TIMING).
//   &timing=slow          every wait twice the mule's (the worst case)
//   &slowcommit=<ms>      after its COMMIT, the half with USB keeps running its old firmware
//                         this long before it writes the image (the mule's false "nothing was
//                         changed": Keybard read the old version before the restart)

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { firmwareLine, RESET_DIALOG_CLASS, ResetNoticeView } from "@/components/StorageResetDialog";
import { backupWhen } from "@/services/backup/describe";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { FirmwareReleasePin } from "@/constants/firmware-releases";
import { DEFAULT_TIMING, imageIdOf, slowTiming, type Fault, type FakeTiming } from "@/services/updater/fake-board";
import { FakeHost, fakeSetup, FlakyInfoTransport, fixtureOneImage, fixturePerSideUf2, type FixtureRelease } from "@/services/updater/fake-host";
import type { UpdaterTransport } from "@/services/updater/transport";
import { sidesScenario } from "@/services/updater/fake-sides-scenarios";
import { HAND_LEFT, HAND_RIGHT, otherHand, type Hand } from "@/services/updater/protocol";
import { readBoardSummary, type BoardSummary } from "../board-summary";
import { FirmwareUpdateProvider, useFirmwareUpdates } from "../FirmwareUpdateProvider";
import type { FirmwareUiHost, UpdateBackup } from "../useFirmwareUpdate";
import { pinOf, ScaledClock } from "./HarnessApp";

class DevFakeHost extends FakeHost implements FirmwareUiHost {
    async makeBackup(): Promise<UpdateBackup> {
        await this.clock.sleep(400);
        return { fileName: "Kip-layout-2026-10-15-0626.svil", svil: "{}" };
    }
    async prepareRows() { return []; }
    boardName() { return "Kip"; }
    chordLegends(hand: Hand): [string, string] { return hand === HAND_RIGHT ? ["M", ","] : ["V", "C"]; }
}

interface Ready {
    host: DevFakeHost;
    /** What the Firmware card reads through (&infofail). */
    cardTransport: UpdaterTransport;
    releases: FirmwareReleasePin[];
    byTag: Record<string, FixtureRelease>;
    newest: FixtureRelease;
}

const params = () => new URLSearchParams(location.search);

function handsOf(value: string | null): Hand[] {
    if (value === "none") return [];
    if (value === "left") return [HAND_LEFT];
    if (value === "right") return [HAND_RIGHT];
    return [HAND_LEFT, HAND_RIGHT];
}

/** &pick: hand a file to the card's file chooser, through the same input a person uses. */
function AutoPick({ ready }: { ready: Ready }) {
    const updates = useFirmwareUpdates();
    const picked = useRef(false);
    const pick = params().get("pick");
    useEffect(() => {
        if (!pick || picked.current || !updates?.board) return;
        picked.current = true;
        void (async () => {
            const bytes = pick === ready.newest.tag ? ready.newest.files[HAND_LEFT].bytes : await fixturePerSideUf2(pick, 8, ready.host.board.usbHand);
            const name = pick === ready.newest.tag ? `svalboard_sval_${pick}.uf2` : `svalboard_${ready.host.board.usbHand === HAND_LEFT ? "left" : "right"}_sval_${pick}.uf2`;
            for (let i = 0; i < 50; i++) {
                const input = document.querySelector<HTMLInputElement>("[data-testid=firmware-file-input]");
                if (input) {
                    const dt = new DataTransfer();
                    dt.items.add(new File([bytes as BlobPart], name));
                    input.files = dt.files;
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                    return;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
        })();
    }, [pick, updates, ready]);
    return null;
}

/** &open and &go: land in a dialog state with no clicks. */
function AutoOpen() {
    const updates = useFirmwareUpdates();
    const opened = useRef(false);
    const p = params();
    const open = p.get("open");
    useEffect(() => {
        if (!open || opened.current || !updates?.board) return;
        const release = (open === "update" ? updates.releases[0] : updates.releases.find((r) => r.tag === open)) ?? null;
        if (!release) return;
        opened.current = true;
        if (updates.board.unread) return;
        if (updates.board.updater) updates.install({ kind: "release", release });
        else updates.openManual(release);
    }, [open, updates]);
    useEffect(() => {
        if ((!open && !p.has("pick")) || !p.has("go")) return;
        let pressed = false;
        const id = setInterval(() => {
            if (pressed) return;
            const update = document.querySelector<HTMLButtonElement>("[data-testid=update-sheet] [data-primary]:not(:disabled)");
            const manual = document.querySelector("[data-testid=manual-install]");
            const connect = manual?.textContent?.includes("Saved to Downloads") ? manual.querySelector<HTMLButtonElement>("[data-connect]") : null;
            const button = update ?? connect;
            if (button) { pressed = true; button.click(); clearInterval(id); }
        }, 200);
        return () => clearInterval(id);
        // Once per page load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
}

/** &resetnotice=1: the reset notice as a connected board shows it, with a backup saved this morning. */
function ResetNoticeDemo() {
    const updates = useFirmwareUpdates();
    const [open, setOpen] = useState(() => params().has("resetnotice"));
    if (!open || !updates?.board) return null;
    const close = () => setOpen(false);
    const at = new Date();
    at.setHours(6, 26, 0, 0);
    return (
        <Dialog open onOpenChange={(next) => !next && close()}>
            <DialogContent className={RESET_DIALOG_CLASS}>
                <ResetNoticeView firmware firmwareNow={firmwareLine(updates.board, null)} backupLine={`Backup saved before the update, ${backupWhen(at.getTime())}`} onDefaults={close} onOtherBackups={close} onPutBack={close} />
            </DialogContent>
        </Dialog>
    );
}

export default function DevFakeFirmware({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState<Ready | null>(null);
    useEffect(() => {
        const p = params();
        void (async () => {
            const size = 0x1e000;
            const v2 = await fixtureOneImage("v2", 7, { imageLen: size });
            const v3 = await fixtureOneImage("v3", 8, { imageLen: size });
            const x4 = await fixtureOneImage("x4", 9, { imageLen: size, noChord: p.has("nochord") });
            // Another tag names a board that runs it (e.g. &proto=3&running=x3.1.3), at version 8.
            const asked = p.get("running");
            const running = asked === "x4" ? x4 : asked === "v2" ? v2 : asked && asked !== "v3" ? { tag: asked, fwVersion: 8 } : v3;
            const sides = sidesScenario(p.get("sides"));
            const clock = new ScaledClock(Number(p.get("speed") ?? 4));
            const f = p.get("fault");
            const faults: Fault[] = !f ? [] : f.startsWith("unplug-") ? [{ kind: "unplug", at: f.slice(7) as "other-send" }] : [{ kind: f } as Fault];
            const chord = p.get("chord");
            const timing: Partial<FakeTiming> = p.get("timing") === "slow" ? slowTiming() : { ...DEFAULT_TIMING };
            if (p.get("slowcommit")) timing.usbCommitStartMs = Number(p.get("slowcommit")) || 8000;
            const { board, sides: fakeSides } = fakeSetup({
                timing,
                sides, clock, running, noChord: p.has("nochord"), faults, usbHand: p.get("usb") === "left" ? HAND_LEFT : HAND_RIGHT,
                chordAfterMs: chord === "never" ? "never" : chord ? Number(chord) : 3000,
                otherRunning: p.has("differ") ? { tag: v2.tag, fwVersion: v2.fwVersion } : undefined,
                half: p.get("proto") === "3" ? { protocol: 3 } : undefined,
            });
            const host = new DevFakeHost(board, clock);
            host.sides = fakeSides?.host;
            const fail = p.get("infofail");
            const cardTransport = fail ? new FlakyInfoTransport(board, clock, fail === "always" || fail === "read" ? fail : Number(fail) || 1) : board;
            if (cardTransport instanceof FlakyInfoTransport && fail === "read") {
                // Check again, pressed by the person: the board answers from then on.
                document.addEventListener("click", (e) => {
                    if ((e.target as Element | null)?.closest?.("[data-testid=firmware-unread-recheck],[data-testid=firmware-recheck]")) cardTransport.answer();
                }, true);
            }
            setReady({ host, cardTransport, releases: [pinOf(x4), pinOf(v3)], byTag: { v2, v3, [x4.tag]: x4 }, newest: x4 });
        })();
    }, []);
    const readBoard = useCallback(async (): Promise<BoardSummary | null> => (ready ? readBoardSummary(ready.cardTransport, null, ready.host.sides, { clock: ready.host.clock }) : null), [ready]);
    // &badfile=1: hand back another release's files, which miss the pins.
    const files = useCallback(async (pin: FirmwareReleasePin) => (params().has("badfile") ? ready!.byTag.v2.files : ready!.byTag[pin.tag].files), [ready]);
    // The mock board is always plugged in; Connect stands for plugging it back in after an install by hand.
    const [plugs, setPlugs] = useState(0);
    const connect = useCallback(() => {
        if (!ready) return;
        const board = ready.host.board;
        const p = params();
        const installs: Hand[] = plugs === 0 ? handsOf(p.get("byhand")) : [HAND_LEFT, HAND_RIGHT];
        for (const h of installs) {
            board.flashByHand(h, { fwVersion: ready.newest.fwVersion, tag: ready.newest.tag, protocol: 4, imageId: imageIdOf(ready.newest.files[h].manifestBytes) });
            board.setAnswering(h, true);
        }
        // A half still on old firmware doesn't answer over the split cable (&silent=1).
        const other = otherHand(board.usbHand);
        if (p.has("silent") && !installs.includes(other)) board.setAnswering(other, false);
        setPlugs((n) => n + 1);
    }, [ready, plugs]);
    const connection = useMemo(() => ({ key: `fake:${plugs}`, connect }), [plugs, connect]);
    if (!ready) return <>{children}</>;
    return (
        <FirmwareUpdateProvider host={ready.host} readBoard={readBoard} releases={ready.releases} files={files} connection={connection}>
            <AutoOpen />
            <AutoPick ready={ready} />
            <ResetNoticeDemo />
            {children}
        </FirmwareUpdateProvider>
    );
}
