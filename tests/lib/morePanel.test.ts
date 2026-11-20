import { describe, expect, it } from 'vitest';

import { SETTINGS, SETTINGS_CATEGORIES } from '../../src/contexts/SettingsContext';
import { MORE_EDITOR_PANELS, railPanelFor } from '../../src/lib/morePanel';

describe('the editors under More', () => {
    it('has no Alt-Repeat Settings switch any more', () => {
        expect(SETTINGS.find(s => s.name === 'show-alt-repeat')).toBeUndefined();
        for (const category of SETTINGS_CATEGORIES) expect(category.settings).not.toContain('show-alt-repeat');
    });

    it('holds Overrides, Alt-Repeat and App Layers, in that order', () => {
        expect([...MORE_EDITOR_PANELS]).toEqual(['overrides', 'altrepeat', 'app-layers']);
    });

    it('marks More on the rail for its editors and leaves other panels alone', () => {
        for (const panel of MORE_EDITOR_PANELS) expect(railPanelFor(panel)).toBe('more');
        for (const panel of ['more', 'combos', 'leaders', 'layouts', 'settings']) expect(railPanelFor(panel)).toBe(panel);
        expect(railPanelFor(null)).toBeNull();
        expect(railPanelFor(undefined)).toBeUndefined();
    });
});
