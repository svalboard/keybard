import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import TypingBehaviorPanel from '../../src/layout/SecondarySidebar/Panels/TypingBehaviorPanel';
import MouseMovementSection from '../../src/layout/SecondarySidebar/Panels/MouseMovementSection';
import DeveloperTuningSection from '../../src/layout/SecondarySidebar/Panels/DeveloperTuningSection';

// Combo (2), Leader (28) and mouse keys (9, 11) are reported alongside the typing settings.
const state = vi.hoisted(() => ({
    keyboard: { settings: { 2: 50, 3: 0, 7: 200, 8: 0, 9: 10, 11: 8, 21: 0, 28: 300 } } as Record<string, unknown>,
}));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard: state.keyboard, setKeyboard: vi.fn() }) }));
vi.mock('@/contexts/ChangesContext', () => ({ useChanges: () => ({ queue: vi.fn() }) }));
vi.mock('@/services/qmk.service', () => ({ qmkService: {} }));
vi.mock('@/services/keyboard.service', () => ({ keyboardService: {} }));
vi.mock('../../src/layout/SecondarySidebar/Panels/DynamicMenuPanel', () => ({
    default: ({ menuIndex, section }: { menuIndex: number; section: string }) => <p>menu {menuIndex} {section}</p>,
}));

describe('Typing behavior', () => {
    it('opens Tap-Hold and lists the typing groups only', () => {
        render(<TypingBehaviorPanel />);
        expect(screen.getByRole('button', { name: 'Tap-Hold' })).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('spinbutton', { name: 'Tapping Term' })).toHaveValue(200);
        for (const name of ['Auto Shift', 'Magic']) {
            expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
        }
        // Combo and leader timing live in their own panels, mouse keys in Mouse Keys.
        for (const name of ['Combo', 'Leader Key', 'Mouse keys']) {
            expect(screen.queryByRole('button', { name })).toBeNull();
        }
        expect(screen.queryByRole('spinbutton', { name: /Leader timeout/ })).toBeNull();
        expect(screen.queryByRole('spinbutton', { name: 'Step size' })).toBeNull();
    });

    it('says what to do when the board reports no QMK settings', () => {
        const saved = state.keyboard;
        state.keyboard = { settings: {} };
        render(<TypingBehaviorPanel />);
        expect(screen.getByText(/Connect a keyboard to change how its keys behave/)).toBeInTheDocument();
        state.keyboard = saved;
    });
});

describe('Mouse Keys > Movement', () => {
    it('shows the mouse key values flat, under a Movement heading', () => {
        render(<MouseMovementSection />);
        expect(screen.getByRole('heading', { name: 'Movement' })).toBeInTheDocument();
        expect(screen.getByRole('spinbutton', { name: 'Delay between pressing a movement key and cursor movement' })).toHaveValue(10);
        // The step size is built into the firmware, so it isn't shown even when the board reports it.
        expect(screen.queryByRole('spinbutton', { name: 'Step size' })).toBeNull();
        expect(screen.getByText('Range: 0 - 2550')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Mouse keys' })).toBeNull();
        expect(screen.queryByRole('spinbutton', { name: 'Tapping Term' })).toBeNull();
    });

    it('renders nothing when the board reports no mouse key values', () => {
        const saved = state.keyboard;
        state.keyboard = { settings: { 7: 200 } };
        const { container } = render(<MouseMovementSection />);
        expect(container).toBeEmptyDOMElement();
        state.keyboard = saved;
    });
});

describe('Scan Lab > Tuning', () => {
    it('renders the developer section of the pointing menu', () => {
        const saved = state.keyboard;
        state.keyboard = { menus: [
            { label: 'Lighting', content: [] },
            { label: 'Pointing Device', content: [{ label: 'Scan period', type: 'range', content: ['id_scan_period_us', 0, 1] }] },
        ] };
        render(<DeveloperTuningSection />);
        expect(screen.getByRole('heading', { name: 'Tuning' })).toBeInTheDocument();
        expect(screen.getByText('menu 1 developer')).toBeInTheDocument();
        state.keyboard = saved;
    });

    it('renders nothing without developer values', () => {
        const saved = state.keyboard;
        state.keyboard = { menus: [{ label: 'Pointing Device', content: [{ label: 'DPI', type: 'range', content: ['id_dpi', 0, 1] }] }] };
        const { container } = render(<DeveloperTuningSection />);
        expect(container).toBeEmptyDOMElement();
        state.keyboard = saved;
    });
});
