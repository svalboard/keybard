import { handName, type Hand } from "@/services/updater/protocol";

/**
 * The half with USB, drawn as its four finger clusters, with the two keys to press lit:
 * Index South and Middle South, labeled with their layer-0 legends.
 */
export function ChordDiagram({ hand, legends }: { hand: Hand; legends: [string, string] }) {
    // Clusters from the thumb side outward: index, middle, ring, pinky.
    const order = hand === 1 ? [0, 1, 2, 3] : [3, 2, 1, 0];
    const key = "rounded-sm border border-kb-gray-border";
    return (
        <div className="flex items-end justify-center gap-2.5 py-1" role="img" aria-label={`${handName(hand)} half: press ${legends[0]} and ${legends[1]}`}>
            {order.map((finger) => {
                const lit = finger === 0 || finger === 1;
                return (
                    <div key={finger} className="grid grid-cols-3 grid-rows-3 gap-0.5" style={{ width: 54, height: 54 }}>
                        <span />
                        <span className={key} />
                        <span />
                        <span className={key} />
                        <span className={key} />
                        <span className={key} />
                        <span />
                        <span className={lit ? "flex items-center justify-center rounded-sm bg-kb-confirm text-[11px] font-semibold text-kb-surface" : key}>
                            {lit ? legends[finger] : null}
                        </span>
                        <span />
                    </div>
                );
            })}
        </div>
    );
}
