// M: Install by hand. Plain instructions: the layout choice, the one file, the steps.
// From x4 on a release is one file for both halves, and the steps copy it onto both, one
// half at a time, the other half first so the cable ends in the usual half. A half on
// Vial or on firmware before the updater can't link to the new firmware, so it never
// gets it over the split cable: copying onto both halves is right whatever they ran.
// A second copy onto a half that already has it is harmless (it keeps its settings).
// Keybard can't see a half while it is a drive, so nothing here is ticked off. The one
// check is on Connect: Keybard reads what each half runs, and either puts the layout back
// and says it's done, names the half that still needs the file, or (one-image firmware)
// asks which half is which first.

import { Button } from "@/components/ui/button";
import { carriedFileUrl, type FirmwareReleasePin } from "@/constants/firmware-releases";
import { SVALBOARD_FIRMWARE_URL } from "@/constants/firmware";
import { PARANOID } from "@/lib/paranoid";
import type { Afterwards } from "@/services/updater/flow";
import { manualHalves, manualPending, type ManualCheck, type ManualHalfState, type ManualResult } from "@/services/updater/manual";
import { handName, otherHand, type Hand } from "@/services/updater/protocol";
import type { SideWrite } from "@/services/side-decision";
import { LayoutChoice } from "./LayoutChoice";
import { FwTitle, Problem, SectionLabel, Spinner } from "./parts";
import { SideFix } from "./SideFix";
import { ImportSettingsNotes } from "@/components/ImportSettingsNotes";
import { firmwareName } from "@/constants/firmware-releases";

/** The backup as the instructions show it. */
export type ManualBackupView = { state: "pending" } | { state: "ok"; fileName: string } | { state: "failed"; error?: string };

/** After the check: putting the layout back, done, or the layout not put back. */
export interface ManualOutcome {
    phase: "steps" | "restoring" | "done" | "failed";
    result: ManualResult | null;
    error: string | null;
}

export interface ManualInstallProps {
    release: FirmwareReleasePin | null;
    /** Recovery of one half (F10, F11): only its file and steps. */
    only?: Hand;
    /** The half the person usually plugs in. Null or absent: the board didn't say, so the steps name no half. */
    usualHand?: Hand | null;
    /** The first move onto firmware Keybard updates: say it's needed once. */
    once?: boolean;
    /** Null: no keyboard was connected, so there's no layout to keep. */
    backup: ManualBackupView | null;
    afterwards: Afterwards;
    onAfterwards: (a: Afterwards) => void;
    /** What Keybard read from each half on the last Connect. */
    check?: ManualCheck | null;
    outcome?: ManualOutcome;
    onConnect: () => void;
    onClose: () => void;
    onOpenBackups?: () => void;
    /** One-image firmware: the answer to which half is which (then Keybard reads the keyboard again). */
    onSides?: (writes: SideWrite[]) => void;
    sidesBusy?: boolean;
    sidesNote?: string | null;
}

function Files({ release }: { release: FirmwareReleasePin | null }) {
    if (!release) {
        return PARANOID
            ? <p className="text-sm">Download the firmware file from <code className="select-all break-all font-mono text-xs">{SVALBOARD_FIRMWARE_URL}</code></p>
            : <a className="text-sm font-medium text-kb-primary underline" href={SVALBOARD_FIRMWARE_URL} target="_blank" rel="noreferrer">Download the firmware file from the Svalboard firmware releases ↗</a>;
    }
    const name = release.file.uf2;
    return (
        <a href={carriedFileUrl(release, name)} download={name} data-file="both"
            className="flex min-w-0 flex-col gap-0.5 rounded-md border border-kb-gray-border px-3 py-2.5 text-kb-ink hover:border-kb-primary">
            <span className="text-sm font-semibold">{firmwareName(release.tag)} for both halves</span>
            <span className="break-all font-mono text-xs text-muted-foreground">{name}</span>
        </a>
    );
}

const RESET = "Press its RESET button twice, about a quarter of a second apart. Too fast and nothing happens. A drive named RPI-RP2 opens.";

const DRAG = (release: FirmwareReleasePin | null) => release
    ? "Drag the file onto the drive. The half restarts and the drive closes."
    : "Drag that half's file onto the drive. The half restarts and the drive closes.";

/**
 * The steps on both halves, the first one first (the other half, then the usual one), or on
 * one half that still needs the file. With the usual half unknown, no half is named.
 */
function Steps({ hand, halves, release, handKnown = true }: { hand?: Hand; halves: Hand[]; release: FirmwareReleasePin | null; handKnown?: boolean }) {
    if (hand !== undefined) {
        return (
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm marker:font-semibold marker:text-muted-foreground" data-testid="manual-steps">
                <li>{`Plug the USB cable into the ${handName(hand)} half's U port. Keep the split cable connected.`}</li>
                <li>{RESET}</li>
                <li>{DRAG(release)}</li>
            </ol>
        );
    }
    const [first, second] = halves;
    return (
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm marker:font-semibold marker:text-muted-foreground" data-testid="manual-steps" data-hand-known={handKnown ? undefined : "false"}>
            <li>{handKnown ? `Plug the USB cable into the ${handName(first)} half's U port. Keep the split cable connected.` : "Plug the USB cable into either half's U port. Keep the split cable connected."}</li>
            <li>{RESET}</li>
            <li>{DRAG(release)}</li>
            <li>{`Then ${handKnown ? `the ${handName(second)} half` : "the other half"}: move the USB cable to its U port, press its RESET button twice, and drag the ${release ? "same file" : "file for that half"} onto the drive.`}</li>
            <li>The halves show a rainbow while they work, then both flash green twice, about half a minute later. While a half writes or restarts, its lights may freeze or show other colors until it's running again.</li>
        </ol>
    );
}

const HALF_LABEL = (h: Hand) => (h === 0 ? "Left half" : "Right half");

function Halves({ check, tag }: { check: ManualCheck; tag: string }) {
    if (check.plugged) {
        // The board didn't say which half it is: one row for the plugged-in half, no half named.
        const s = check.plugged;
        return (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm tabular-nums" data-testid="manual-halves">
                <dt>Plugged-in half</dt>
                <dd data-half="plugged" data-state={s.state} className="font-semibold text-kb-warn-ink">{s.state === "old" ? (s.tag ? firmwareName(s.tag) : "its old firmware") : "not checked"}</dd>
            </dl>
        );
    }
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm tabular-nums" data-testid="manual-halves">
            {([0, 1] as Hand[]).filter((h) => check.halves[h]).map((h) => {
                const s = check.halves[h]!;
                return [
                    <dt key={`t${h}`}>{HALF_LABEL(h)}</dt>,
                    <dd key={`d${h}`} data-half={handName(h)} data-state={s.state} className={s.state === "new" ? "font-semibold text-kb-primary" : "font-semibold text-kb-warn-ink"}>
                        {s.state === "new" ? tag : s.state === "old" ? (s.tag ? firmwareName(s.tag) : "its old firmware") : s.state === "silent" ? "didn't answer" : "not checked"}
                    </dd>,
                ];
            })}
        </dl>
    );
}

/** One line on what the last Connect found, for the instructions screen. */
function stillLine(check: ManualCheck, pending: Hand[], tag: string, usual: Hand | null): string {
    if (check.plugged?.state === "old") return `The plugged-in half still runs ${check.plugged.tag ? firmwareName(check.plugged.tag) : "its old firmware"}. Install the file on both halves, then connect again.`;
    const st = (h: Hand) => check.halves[h] as ManualHalfState | undefined;
    if (pending.every((h) => st(h)?.state === "unknown")) return "Keybard couldn't read the keyboard's firmware yet. Connect again to check.";
    if (pending.length === 2 && pending.every((h) => st(h)?.state === "old")) return `Neither half runs ${tag} yet. Install the file, then connect again.`;
    const usbOld = pending.find((h) => st(h)?.state === "old");
    const unknown = pending.find((h) => st(h)?.state === "unknown");
    const say = (h: Hand) => {
        const s = st(h);
        if (s?.state === "old") return `The ${handName(h)} half still runs ${s.tag ? firmwareName(s.tag) : "its old firmware"}.`;
        if (s?.state === "silent") return `The ${handName(h)} half didn't answer.`;
        return "";
    };
    if (usbOld !== undefined && unknown !== undefined) {
        return `${say(usbOld)} Install the file on it, then connect again.`;
    }
    const lines = pending.map(say).filter(Boolean).join(" ");
    const one = pending[0] ?? usual;
    return `${lines} Install the file on ${pending.length > 1 ? "both halves" : one === null ? "the keyboard" : `the ${handName(one)} half`}, then connect again.`;
}

export function ManualInstall({ release, only, usualHand = null, once = false, backup, afterwards, onAfterwards, check = null, outcome, onConnect, onClose, onOpenBackups, onSides, sidesBusy, sidesNote }: ManualInstallProps) {
    const tag = release ? firmwareName(release.tag) : "the newest firmware";
    const halves = manualHalves(only, usualHand);
    const phase = outcome?.phase ?? "steps";
    const onHalf = only !== undefined ? ` on the ${handName(only)} half` : "";
    const fromNowOn = once ? " From now on, updates install from Keybard." : "";

    if (phase === "restoring") {
        return (
            <div className="flex flex-col gap-4" data-testid="manual-install" data-screen="restoring" aria-busy="true">
                <FwTitle sub={`${tag} is installed${onHalf}.`}>Putting your layout back</FwTitle>
                <p className="flex items-center gap-3 text-sm"><Spinner />Writing your layout to the keyboard</p>
            </div>
        );
    }
    if (phase === "done" || phase === "failed") {
        const restored = outcome?.result?.layout === "restored";
        const kept = outcome?.result?.layout === "kept";
        const sub = phase === "failed" ? undefined : `${restored ? "Your layout is back on the keyboard." : kept ? "Your layout is as it was." : "Your keyboard has the default layout."}${fromNowOn}`;
        return (
            <div className="flex flex-col gap-4" data-testid="manual-install" data-screen="done">
                <FwTitle sub={sub}>{`${tag} is installed${onHalf}`}</FwTitle>
                {phase === "failed" && (
                    <div role="alert">
                        <Problem title="Keybard couldn't restore your layout.">
                            {outcome?.error} Restore {backup?.state === "ok" ? <span className="break-all font-mono text-xs">{backup.fileName}</span> : "your backup"} from Backups.
                        </Problem>
                    </div>
                )}
                {outcome?.result && outcome.result.trimmed.length > 0 && (
                    <Problem title="Some of your layout didn't fit this firmware.">
                        {outcome.result.trimmed.map((line) => <p key={line}>{line}</p>)}
                    </Problem>
                )}
                {outcome?.result && <ImportSettingsNotes replaced={outcome.result.replaced} unavailable={outcome.result.unavailable} notKept={outcome.result.notKept} unchecked={outcome.result.unchecked} done />}
                <div className="flex flex-wrap justify-end gap-2">
                    {phase === "failed" && onOpenBackups && <Button variant="outline" onClick={onOpenBackups}>Open Backups</Button>}
                    <Button variant="kb-primary" onClick={onClose}>Done</Button>
                </div>
            </div>
        );
    }

    // One-image firmware: a half without a side, or two on one side. Neither half types until it's answered.
    if (check?.sides) {
        return (
            <div className="flex flex-col gap-4" data-testid="manual-install" data-screen="sides">
                <FwTitle sub={`${tag} is installed. Then Keybard puts your layout back.`}>Set which half is which</FwTitle>
                <SideFix bare sides={check.sides} busy={sidesBusy} note={sidesNote} onApply={(w) => onSides?.(w)} />
            </div>
        );
    }

    const pending = check ? manualPending({ only, usualHand }, check) : halves;
    const one = check && pending.length === 1 && check.halves[pending[0]]?.state !== "unknown" ? pending[0] : undefined;

    if (one !== undefined && check) {
        const s = check.halves[one]!;
        const other = otherHand(one);
        const otherNew = only === undefined && check.halves[other]?.state === "new";
        const title = s.state === "silent" ? `The ${handName(one)} half didn't answer` : `The ${handName(one)} half still runs ${s.state === "old" && s.tag ? firmwareName(s.tag) : "its old firmware"}`;
        const lead = otherNew ? `The ${handName(other)} half has ${tag}. ` : "";
        const sub = s.state === "silent"
            ? `${lead}The ${handName(one)} half may still run its old firmware, which doesn't answer over the split cable. Install the file on it, then connect again.`
            : `${lead}Install the file on the ${handName(one)} half, then connect again.`;
        return (
            <div className="flex flex-col gap-5" data-testid="manual-install" data-screen="one-half" data-half={handName(one)}>
                <FwTitle sub={sub}>{title}</FwTitle>
                <Halves check={check} tag={tag} />
                <section className="flex flex-col gap-3" aria-label={`Install on the ${handName(one)} half`}>
                    <Files release={release} />
                    <Steps hand={one} halves={halves} release={release} />
                </section>
                <footer className="flex flex-col gap-3 border-t border-kb-gray-border pt-4">
                    {usualHand !== null && one !== usualHand && <p className="text-sm text-muted-foreground">Then plug into your usual half.</p>}
                    <div className="flex justify-end"><Button variant="kb-primary" data-connect onClick={onConnect}>Connect again</Button></div>
                </footer>
            </div>
        );
    }

    const sub = only !== undefined ? "It takes a couple of minutes." : once
        ? "Your keyboard needs this once. After that, Keybard installs updates for you. It takes a few minutes."
        : "It takes a few minutes.";
    return (
        <div className="flex flex-col gap-5" data-testid="manual-install" data-screen="instructions">
            <FwTitle sub={sub}>{only !== undefined ? `Install ${tag} on the ${handName(only)} half` : `Install ${tag} by hand`}</FwTitle>
            {check && <p role="status" className="text-sm font-medium text-kb-warn-ink" data-testid="manual-still">{stillLine(check, pending, tag, usualHand)}</p>}

            {backup && (
                <section className="flex flex-col gap-2" aria-label="Your layout">
                    <SectionLabel>Your layout</SectionLabel>
                    {backup.state === "failed" ? (
                        <Problem title="Keybard couldn't save your layout.">{backup.error ? `${backup.error} ` : ""}Afterward the keyboard starts from the default layout.</Problem>
                    ) : (
                        <>
                            <p className="text-sm">
                                {backup.state === "ok" ? <>Saved to Downloads just now, before the install, as <span className="break-all font-mono text-xs">{backup.fileName}</span>. Afterward:</> : "Keybard is saving it to Downloads. Afterward:"}
                            </p>
                            {/* No blank keyboard here: clearing every key needs the updater (SETTINGS_RESET), which this install can't ask. */}
                            <LayoutChoice value={afterwards} onChange={onAfterwards} keepDisabled={backup.state !== "ok"} choices={["restore", "defaults"]} label="After the install" />
                        </>
                    )}
                </section>
            )}

            <section className="flex flex-col gap-2" aria-label="Firmware file">
                <SectionLabel>Firmware file</SectionLabel>
                <Files release={release} />
            </section>

            <section className="flex flex-col gap-2" aria-label={only !== undefined ? `Install on the ${handName(only)} half` : "Install"}>
                <SectionLabel>{only !== undefined ? `Install on the ${handName(only)} half` : "Install"}</SectionLabel>
                <Steps hand={only} halves={halves} release={release} handKnown={usualHand !== null} />
            </section>

            <footer className="flex flex-col gap-3 border-t border-kb-gray-border pt-4">
                <p className="text-sm text-muted-foreground">{only === undefined ? "After the green flashes, connect the keyboard." : usualHand === null ? "When it's done, connect the keyboard." : "When it's done, plug into your usual half."}</p>
                <div className="flex justify-end"><Button variant="kb-primary" data-connect onClick={onConnect}>{check ? "Connect again" : "Connect keyboard"}</Button></div>
            </footer>
        </div>
    );
}
