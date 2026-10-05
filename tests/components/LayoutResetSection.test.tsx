import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LayoutResetSection from '../../src/layout/SecondarySidebar/Panels/LayoutResetSection';
const mock = vi.hoisted(() => ({ reset: vi.fn(), load: vi.fn(), backup: vi.fn(), pending: 0, connected: true }));
vi.mock('@/contexts/VialContext', () => ({ useVial: () => ({ keyboard: { layers: 2 }, isConnected: mock.connected, loadKeyboard: mock.load }) }));
vi.mock('@/contexts/ChangesContext', () => ({ useChanges: () => ({ getPendingCount: () => mock.pending }) }));
vi.mock('@/services/layout-reset.service', () => ({ resetLayout: mock.reset }));
vi.mock('@/services/file.service', () => ({ fileService: { downloadSvil: mock.backup } }));
beforeEach(() => { vi.resetAllMocks(); mock.pending = 0; mock.connected = true; });
it('requires exact typed confirmation and cancellation writes nothing', () => {
    render(<LayoutResetSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore factory layout…' }));
    expect(screen.getByRole('button', { name: 'Confirm reset' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type RESET to confirm'), { target: { value: 'reset' } });
    expect(screen.getByRole('button', { name: 'Confirm reset' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mock.reset).not.toHaveBeenCalled();
});
it('executes the selected reset once and refreshes the board', async () => {
    render(<LayoutResetSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Make all layers transparent…' }));
    fireEvent.change(screen.getByLabelText('Type CLEAR to confirm'), { target: { value: 'CLEAR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    await screen.findByText('All layers are now transparent.');
    expect(mock.reset).toHaveBeenCalledExactlyOnceWith('transparent', { layers: 2 });
    expect(mock.load).toHaveBeenCalledOnce();
});
it('blocks resets while there are queued edits', () => {
    mock.pending = 1;
    render(<LayoutResetSection />);
    expect(screen.getByRole('button', { name: 'Restore factory layout…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Make all layers transparent…' })).toBeDisabled();
});
it('blocks resets without a connected board', () => {
    mock.connected = false;
    render(<LayoutResetSection />);
    expect(screen.getByRole('button', { name: 'Restore factory layout…' })).toBeDisabled();
});
it('keeps failure visible, reloads partial state, and requires confirmation again', async () => {
    mock.reset.mockRejectedValueOnce(new Error('disconnected'));
    render(<LayoutResetSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore factory layout…' }));
    fireEvent.change(screen.getByLabelText('Type RESET to confirm'), { target: { value: 'RESET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some keys may have changed');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm reset' })).toBeDisabled());
    expect(mock.load).toHaveBeenCalledOnce();
});
it('exports a complete backup without changing the keyboard', async () => {
    render(<LayoutResetSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore factory layout…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(mock.backup).toHaveBeenCalledExactlyOnceWith({ layers: 2 }, true));
    expect(mock.reset).not.toHaveBeenCalled();
});
it('prevents duplicate resets and dismissal while writing', async () => {
    let finish!: () => void;
    mock.reset.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<LayoutResetSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore factory layout…' }));
    fireEvent.change(screen.getByLabelText('Type RESET to confirm'), { target: { value: 'RESET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Working…' }));
    expect(mock.reset).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish();
    await screen.findByText('Factory layout restored.');
});
