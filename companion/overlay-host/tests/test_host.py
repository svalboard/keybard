import copy
from pathlib import Path
import tempfile
import unittest
from keybard_host.state import HostState, DEFAULTS, validate_config

class StateTests(unittest.TestCase):
    def test_atomic_preferences_conflict_and_reopen(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'prefs.json'
            state = HostState(path)
            cfg = copy.deepcopy(DEFAULTS); cfg['appearance']['fillAlpha'] = 0; cfg['manualDefault'] = 0x80000002
            self.assertEqual(state.configure(cfg, 0), 1)
            with self.assertRaises(RuntimeError): state.configure(DEFAULTS, 0)
            self.assertEqual(HostState(path).config, cfg)
            self.assertEqual(state.snapshot()['config'], cfg)
    def test_allowlist_bounds_and_boolean_types(self):
        for value in ({'command': 'flash'}, {'manualDefault': -1}, {'duration': float('nan')}, {'highlightPressed': 1}, {'capitalAlphas': 'yes'}, {'adaptiveContrast': 1}, {'appearance': {'fill': 'url(http://x)'}}, {'appearance': {'width': 5}}):
            with self.assertRaises(ValueError): validate_config(value)
    def test_held_key_highlight_defaults_on_but_keeps_a_saved_choice(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'prefs.json'
            self.assertIs(HostState(path).config['highlightPressed'], True)
            path.write_text('{"version": 1, "config": {"highlightPressed": false}}')
            self.assertIs(HostState(path).config['highlightPressed'], False)
            self.assertIs(HostState(path).config['capitalAlphas'], False)
            self.assertIs(HostState(path).config['adaptiveContrast'], False)
            path.write_text('{"version": 1, "config": {"capitalAlphas": true, "adaptiveContrast": true}}')
            self.assertIs(HostState(path).config['capitalAlphas'], True)
            self.assertIs(HostState(path).config['adaptiveContrast'], True)
    def test_held_key_highlight_is_turned_on_once_for_older_preferences(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'prefs.json'
            # Saved by a Host before preferences had a version: it wrote false on every connect.
            path.write_text('{"config": {"highlightPressed": false, "scale": 80}, "remembered": {"serial": "S", "uid": "1"}}')
            state = HostState(path)
            self.assertIs(state.config['highlightPressed'], True)
            self.assertEqual(state.config['scale'], 80)
            saved = json.loads(path.read_text())
            self.assertEqual(saved['version'], 1)
            self.assertIs(saved['config']['highlightPressed'], True)
            self.assertEqual(saved['remembered'], {'serial': 'S', 'uid': '1'})
            # Turned off after the upgrade: that choice is kept from now on.
            state.configure(dict(state.config, highlightPressed=False), state.revision)
            self.assertIs(HostState(path).config['highlightPressed'], False)
    def test_no_preferences_file_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'prefs.json'
            HostState(path)
            self.assertFalse(path.exists())
    def test_snapshot_does_not_alias_mutable_host_data(self):
        state = HostState('/nonexistent/keybard-test.json'); s = state.snapshot(); s['config']['appearance']['fill'] = 'bad'
        self.assertEqual(state.config['appearance']['fill'], DEFAULTS['appearance']['fill'])
        state.board = {'keymap': [[4]]}; state.layout_revision = 9
        self.assertIsNone(state.snapshot(9)['board'])
        self.assertEqual(state.snapshot(8)['board']['keymap'], [[4]])

    def test_language_defaults_and_validation(self):
        self.assertEqual(validate_config({})['layoutId'], 'us')
        self.assertEqual(validate_config({'layoutId': 'uk'})['layoutId'], 'uk')
        for value in (None, 1, '', 'x' * 33, '<script>'):
            with self.assertRaises(ValueError): validate_config({'layoutId': value})

    def test_legend_settings_follow_keybard_defaults_and_validation(self):
        # Keybard's Shifted Key Symbols is on and AltGr Symbols off when never set.
        config = validate_config({})
        self.assertIs(config['shiftedLegends'], True)
        self.assertIs(config['altgrLegends'], False)
        config = validate_config({'shiftedLegends': False, 'altgrLegends': True})
        self.assertEqual((config['shiftedLegends'], config['altgrLegends']), (False, True))
        for name in ('shiftedLegends', 'altgrLegends'):
            for value in (None, 1, 'on'):
                with self.assertRaises(ValueError): validate_config({name: value})
