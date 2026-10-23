// Pieces every firmware screen shares: the one title (the dialog's accessible name when
// the screen is in a dialog), the subtitle, the small section label, a problem box.

import { createContext, useContext, type ReactNode } from "react";

import { DialogTitle } from "@/components/ui/dialog";
import { handName, type Hand } from "@/services/updater/protocol";

/** True inside a firmware dialog: the screen's title is its DialogTitle. */
export const InFirmwareDialog = createContext(false);

export const halfName = (h: Hand) => (h === 0 ? "Left half" : "Right half");
export const theHalf = (h: Hand) => `the ${handName(h)} half`;

/** The screen's one title. In a dialog it names the dialog; elsewhere (tests, the gallery) a plain heading. */
export function FwTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
    const inDialog = useContext(InFirmwareDialog);
    const className = "pr-8 text-lg font-semibold text-kb-ink text-balance";
    return (
        <header className="flex flex-col gap-1">
            {inDialog ? <DialogTitle className={className}>{children}</DialogTitle> : <h2 className={className}>{children}</h2>}
            {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
        </header>
    );
}

export function SectionLabel({ children }: { children: ReactNode }) {
    return <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/** A check that warns or fails: what's wrong in a sentence, then what to do. */
export function Problem({ title, children, id }: { title: ReactNode; children?: ReactNode; id?: string }) {
    return (
        <div className="rounded-md bg-kb-warn-bg px-3 py-2.5 text-sm text-kb-ink" data-problem={id}>
            <p className="font-semibold text-kb-warn-ink">{title}</p>
            {children && <div className="mt-0.5">{children}</div>}
        </div>
    );
}

export function Spinner() {
    return <span aria-hidden className="h-5 w-5 shrink-0 animate-spin rounded-full border-[3px] border-kb-gray-medium border-t-kb-primary motion-reduce:animate-none" />;
}
