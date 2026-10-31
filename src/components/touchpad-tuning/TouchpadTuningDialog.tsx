import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TouchpadTuning } from "./TouchpadTuning";
import { closeTouchpadTuning, useTouchpadTuningOpen } from "./tuning-open";

/**
 * Touchpad tuning as a dialog, opened from Pointing Devices ("Tune
 * touchpad…"). The same view as the Settings card. Mounted once per page.
 */
export default function TouchpadTuningDialog() {
    const open = useTouchpadTuningOpen();
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) closeTouchpadTuning(); }}>
            {/* A diagnostic panel with a fixed size, set by the viewport and never by what the
                pads report: most of the screen on a desktop, all of it on a phone. The body
                scrolls inside it when the window is small, and only the touch lists grow
                (inside their own fixed-height boxes). */}
            <DialogContent
                className="flex h-dvh max-h-none w-screen max-w-none flex-col gap-3 overflow-hidden rounded-none p-4 sm:h-[min(60rem,calc(100dvh-4rem))] sm:w-[min(80rem,calc(100vw-4rem))] sm:max-w-none sm:rounded-lg sm:p-6"
                data-touchpad-tuning-dialog
            >
                <DialogHeader className="shrink-0">
                    <DialogTitle>Touchpad tuning</DialogTitle>
                    <DialogDescription>Each touch on a pad shows here, with why it clicked or didn't.</DialogDescription>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-touchpad-tuning-body>
                    {open && <TouchpadTuning place="dialog" />}
                </div>
            </DialogContent>
        </Dialog>
    );
}
