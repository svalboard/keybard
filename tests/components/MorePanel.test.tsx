import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MorePanel from '../../src/layout/SecondarySidebar/Panels/MorePanel';

const state = vi.hoisted(() => ({ keyboard: null as unknown, layoutMode: 'sidebar' }));
const panels = vi.hoisted(() => ({ setActivePanel: vi.fn(), setPanelToGoBack: vi.fn(), setAlternativeHeader: vi.fn(), setItemToEdit: vi.fn() }));
vi.mock('@/contexts/KeyboardContext', () => ({ useKeyboard: () => ({ keyboard: state.keyboard }) }));
vi.mock('@/contexts/LayoutSettingsContext', () => ({ useLayoutSettings: () => ({ layoutMode: state.layoutMode }) }));
vi.mock('@/contexts/PanelsContext', () => ({ usePanels: () => panels }));

afterEach(() => { cleanup(); vi.clearAllMocks(); state.keyboard = null; state.layoutMode = 'sidebar'; });

const titles = () => [...document.querySelectorAll('[data-more-tool]')].map((b) => b.getAttribute('data-more-tool'));

describe('the More panel', () => {
    it('lists Overrides and Alt-Repeat, and App Layers only on firmware with app rules', () => {
        state.keyboard = { feature_flags5: 0 };
        render(<MorePanel />);
        expect(titles()).toEqual(['overrides', 'altrepeat']);
        cleanup();
        state.keyboard = { feature_flags5: 1 };
        render(<MorePanel />);
        expect(titles()).toEqual(['overrides', 'altrepeat', 'app-layers']);
    });

    it.each([['Overrides', 'overrides'], ['Alt-Repeat', 'altrepeat'], ['App Layers', 'app-layers']])('opens %s', (name, panel) => {
        state.keyboard = { feature_flags5: 1 };
        render(<MorePanel />);
        fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
        expect(panels.setActivePanel).toHaveBeenCalledWith(panel);
        expect(panels.setItemToEdit).toHaveBeenCalledWith(null);
    });

    it('lays the list out in a row in the bottom bar', () => {
        state.layoutMode = 'bottombar';
        render(<MorePanel />);
        expect(screen.getByRole('navigation', { name: 'More editors' }).className).toContain('grid-cols-3');
    });
});
