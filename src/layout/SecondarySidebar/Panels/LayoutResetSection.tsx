import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useVial } from '@/contexts/VialContext';
import { useChanges } from '@/contexts/ChangesContext';
import { fileService } from '@/services/file.service';
import { resetLayout, type LayoutResetMode } from '@/services/layout-reset.service';

export default function LayoutResetSection() {
    const { keyboard, isConnected, loadKeyboard } = useVial();
    const { getPendingCount } = useChanges();
    const [mode, setMode] = useState<LayoutResetMode | null>(null);
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const locked = useRef(false);
    const [message, setMessage] = useState('');
    const pending = getPendingCount() > 0;
    const word = mode === 'factory' ? 'RESET' : 'CLEAR';
    const unavailable = !keyboard || !isConnected || pending;

    const open = (value: LayoutResetMode) => {
        setConfirmation('');
        setMessage('');
        setMode(value);
    };
    const apply = async () => {
        if (!mode || !keyboard || unavailable || confirmation !== word || locked.current) return;
        locked.current = true;
        setBusy(true);
        setMessage('');
        try {
            await resetLayout(mode, keyboard);
            await loadKeyboard();
            setMode(null);
            setMessage(mode === 'factory' ? 'Factory layout restored.' : 'All layers are now transparent.');
        } catch (error) {
            // Reads refresh any partial writes; never report a failed operation as successful.
            try { await loadKeyboard(); } catch { /* Keep the original failure visible. */ }
            setConfirmation('');
            setMessage(`The reset could not be completed. Some keys may have changed. ${error instanceof Error ? error.message : 'Reconnect and try again.'}`);
        } finally {
            locked.current = false;
            setBusy(false);
        }
    };
    const backup = async () => {
        if (!keyboard || locked.current) return;
        locked.current = true;
        setBusy(true);
        try { await fileService.downloadSvil(keyboard, true); }
        catch { setMessage('The backup could not be exported. Try again before resetting.'); }
        finally { locked.current = false; setBusy(false); }
    };

    return <section className="flex flex-col gap-2 p-3 border rounded-md">
        <strong>Reset layout</strong>
        <p className="text-xs text-muted-foreground">Replace key assignments across every layer.</p>
        {pending && <p className="text-xs">Apply or revert pending edits before resetting.</p>}
        {!isConnected && <p className="text-xs">Connect your keyboard to reset its layout.</p>}
        <Button variant="outline" disabled={unavailable || busy} onClick={() => open('factory')}>Restore factory layout…</Button>
        <Button variant="outline" disabled={unavailable || busy} onClick={() => open('transparent')}>Make all layers transparent…</Button>
        {!mode && message && <p role="status">{message}</p>}
        <Dialog open={mode !== null} onOpenChange={value => { if (!value && !locked.current) setMode(null); }}>
            <DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
                <DialogHeader>
                    <DialogTitle>{mode === 'factory' ? 'Restore factory layout?' : 'Make all layers transparent?'}</DialogTitle>
                    <DialogDescription>
                        {mode === 'factory'
                            ? 'Replace every layer with the default key assignments built into your installed firmware.'
                            : 'Set every key on every layer, including the base layer, to transparent. Ordinary typing will stop until you assign keys again in Keybard.'}
                        {' '}Macros, combos, tap dances, other behaviors, pointing settings, and board identity are kept. This applies immediately, even with Live Updating off. Export a backup if you want to restore your current layout later.
                    </DialogDescription>
                </DialogHeader>
                <Button variant="outline" disabled={busy || !keyboard} onClick={backup}>Export backup</Button>
                <label htmlFor="layout-reset-confirmation">Type {word} to confirm</label>
                <Input id="layout-reset-confirmation" value={confirmation} disabled={busy} autoComplete="off" onChange={event => setConfirmation(event.target.value)} />
                {message && <p role="alert">{message}</p>}
                <DialogFooter>
                    <Button variant="secondary" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
                    <Button variant="destructive" disabled={busy || unavailable || confirmation !== word} onClick={apply}>
                        {busy ? 'Working…' : 'Confirm reset'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </section>;
}
