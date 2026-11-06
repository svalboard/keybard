import { handName, HAND_LEFT, HAND_RIGHT, type Hand } from "@/services/updater/protocol";

/**
 * The confirmation keys, by position only: the firmware reads Index South and Middle South
 * on the half with USB (svalboard/qmk keyboards/svalboard/config.h, SVAL_UPDATE_CHORD_ROW_A/B
 * and SVAL_UPDATE_CHORD_COL: each half's own local rows 1 and 2, column 0). Never their legends:
 * the layout on the board can put anything on those keys, and a blank board has none.
 */
export const CHORD_KEY_NAMES = ["index south", "middle south"] as const;

/** "the south keys of your index and middle fingers": the chord in a sentence. */
export const CHORD_KEYS_PHRASE = "the south keys of your index and middle fingers";

/** The half to press on, in words: its name, or "the half with the USB cable" when it isn't known. */
export const chordHalfPhrase = (hand: Hand | null) => (hand === null ? "the half with the USB cable" : `the ${handName(hand)} half`);

/** Which halves carry the lit keys: the half with USB, or both when it isn't known. */
export const litHalves = (hand: Hand | null): Hand[] => (hand === null ? [HAND_LEFT, HAND_RIGHT] : [hand]);

/**
 * Both halves, laid out like the keyboard (left half on the left), with the two keys to press
 * lit on the half with USB (both halves when that isn't known). The lit keys carry no letters.
 */
export function ChordDiagram({ hand }: { hand: Hand | null }) {
    const lit = litHalves(hand);
    const key = "rounded-sm border border-kb-gray-border";
    return (
        <div className="flex items-end justify-center gap-6 py-1" role="img" data-testid="chord-diagram" data-usb={hand === null ? "unknown" : handName(hand)}
            aria-label={`${hand === null ? "On the half with the USB cable" : `${handName(hand)} half`}: ${CHORD_KEY_NAMES[0]} and ${CHORD_KEY_NAMES[1]} lit`}>
            {([HAND_LEFT, HAND_RIGHT] as const).map((side) => {
                const active = lit.includes(side);
                // Clusters from the thumb side outward: index, middle, ring, pinky. The thumb side is inward.
                const order = side === HAND_RIGHT ? [0, 1, 2, 3] : [3, 2, 1, 0];
                return (
                    <div key={side} className={`flex flex-col items-center gap-1 ${active ? "" : "opacity-40"}`} data-half={handName(side)} data-active={active}>
                        <div className="flex items-end gap-1.5">
                            {order.map((finger) => {
                                const on = active && (finger === 0 || finger === 1);
                                return (
                                    <div key={finger} className="grid grid-cols-3 grid-rows-3 gap-0.5" style={{ width: 40, height: 40 }} data-finger={["index", "middle", "ring", "pinky"][finger]}>
                                        <span />
                                        <span className={key} />
                                        <span />
                                        <span className={key} />
                                        <span className={key} />
                                        <span className={key} />
                                        <span />
                                        <span className={on ? "rounded-sm bg-kb-confirm" : key} data-chord-key={on ? CHORD_KEY_NAMES[finger] : undefined} />
                                        <span />
                                    </div>
                                );
                            })}
                        </div>
                        <span className={`text-xs ${active ? "font-semibold" : "text-muted-foreground"}`}>
                            {side === HAND_LEFT ? "Left" : "Right"}{hand === side ? " · USB" : ""}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
