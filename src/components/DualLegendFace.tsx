import { DIAGONAL_INSET_PX, DUAL_LEGEND_LINE_HEIGHT, type LegendPlan } from "@/lib/shiftedLegends";

/**
 * Shared by the editor's keys (Key.tsx) and the Keybard Overlay's keys. The legends of a digit, punctuation or AltGr key, like a printed keycap: the shifted
 * symbol upper right, the base legend lower left and the AltGr character lower right,
 * pulled in from the corners, one color and one size. The face is the room between the
 * key's bands; planLegends (shiftedLegends.ts) sizes every legend to the room, so every
 * glyph stays whole. Spans draw as written (no CSS capitals, which would turn the micro
 * sign into a Greek capital mu): a letter's base legend is capitalized here.
 */
export function DualLegendFace({ plan, variant }: { plan: LegendPlan; variant: "default" | "medium" | "small" }) {
    const { legend, fontPx, insetY } = plan;
    const text: React.CSSProperties = { fontSize: fontPx, lineHeight: DUAL_LEGEND_LINE_HEIGHT, whiteSpace: "nowrap", textTransform: "none" };
    const x = DIAGONAL_INSET_PX[variant].x;
    // A letter is capitalized like the key's other labels only when it has no shifted legend: the
    // shifted legend of é, è, ç, à is their digit, and their base stays as the layout prints it.
    const base = !legend.shifted && /\p{L}/u.test(legend.base) && legend.base !== "ß" ? legend.base.toLocaleUpperCase() : legend.base;
    return (
        <div data-dual-legend="" className="relative w-full flex-1 min-h-0 font-semibold">
            {legend.shifted && <span data-legend="shifted" className="absolute" style={{ ...text, top: insetY, ...(plan.grid ? { left: x } : { right: x }) }}>{legend.shifted}</span>}
            {!legend.letter && <span data-legend="base" className="absolute" style={{ ...text, bottom: insetY, left: x }}>{base}</span>}
            {legend.altgr && <span data-legend="altgr" className="absolute" style={{ ...text, bottom: insetY, right: x }}>{legend.altgr}</span>}
        </div>
    );
}
