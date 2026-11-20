"""App rules: the app ID, which app is in front, telling the board (APP_FOREGROUND, 0x40),
and /api/host/apps."""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from keybard_host import foreground
from keybard_host.foreground import app_id, app_key, apps_snapshot, running_apps
from keybard_host.device.app_sender import AppSender, RESEND
from keybard_host.device.protocol import AppRules, SvalReader, UnsupportedCommand, APP_RULES_FLAG5, READ_COMMANDS
from keybard_host.server import make_server
from keybard_host.state import HostState
import test_poll_schedule as poll
from test_protocol import FakeDevice as ProtocolDevice


class AppIdTests(unittest.TestCase):
    def test_protocol_vectors(self):
        self.assertEqual(app_id('notepad.exe'), 0xB884A32C)
        self.assertEqual(app_id('Notepad.EXE'), 0xB884A32C)
        self.assertEqual(app_id('chrome.exe'), 0xFC0C788D)
        self.assertEqual(app_id('com.apple.Safari'), 0xECE537F6)
        self.assertEqual(app_id('firefox'), 0xF4D4D03A)

    def test_empty_is_no_app(self):
        for key in ('', ' \t ', None):
            self.assertEqual(app_id(key), 0)

    def test_trims_spaces_and_tabs_and_lowers_ascii_only(self):
        self.assertEqual(app_id(' \tNotepad.exe\t '), app_id('notepad.exe'))
        self.assertEqual(app_key('ÉDITEUR.exe'), 'Éditeur.exe')       # É is not ASCII: kept
        self.assertNotEqual(app_id('éditeur.exe'), app_id('Éditeur.exe'))
        self.assertEqual(app_key('a\nb'), 'a\nb')                      # only spaces and tabs are trimmed

    def test_zero_is_sent_as_one(self):
        with mock.patch.object(foreground, 'FNV_OFFSET', 0), mock.patch.object(foreground, 'FNV_PRIME', 0):
            self.assertEqual(app_id('x'), 1)


class AppSenderTests(unittest.TestCase):
    def test_nothing_before_the_app_is_known(self):
        self.assertFalse(AppSender().due(None, 0))

    def test_on_change_at_once_and_again_every_resend(self):
        s = AppSender()
        self.assertTrue(s.due(5, 0)); s.sent(5, 0)
        self.assertFalse(s.due(5, RESEND - .01))
        self.assertTrue(s.due(5, RESEND))
        self.assertTrue(s.due(6, 1))                    # another app: at once

    def test_a_refused_app_waits_for_the_resend(self):
        s = AppSender(); s.sent(5, 0, accepted=False)
        self.assertIsNone(s.sent_id)
        self.assertFalse(s.due(5, 1)); self.assertTrue(s.due(5, RESEND))


class AppDevice(ProtocolDevice):
    """The protocol fake with app rules: GET_INFO's fifth feature byte, and 0x40 answered."""

    def __init__(self, flags5=APP_RULES_FLAG5, status=0):
        super().__init__()
        self.flags5, self.app_status, self.app_requests = flags5, status, []
        # STATUS: the layers keys use now and the default layer state, as a rule leaves them.
        self.app_layers, self.app_default = 0, 1

    def write(self, packet):
        request = bytes(packet[1:])
        if request[5:7] == bytes((0xDF, 0x40)) and request[1:5] != bytes(4):
            self.app_requests.append(request[7:])
            self.writes.append(packet)
            op = request[7]
            if op == 0:
                data = bytearray(31); data[0], data[1] = op, self.app_status if self.size - 7 >= 31 else 3
                data[18:22] = self.app_default.to_bytes(4, "little"); data[26:30] = self.app_layers.to_bytes(4, "little")
                data = bytes(data[:self.size - 7]) if self.size - 7 < 31 else bytes(data)
            else:
                data = bytes((op, self.app_status, 0xFF, 0)) if op == 1 else bytes((op, self.app_status))
            self.queue.append(request[:7] + data.ljust(self.size - 7, b'\0'))
            return len(packet)
        count = super().write(packet)
        if request[5:7] == bytes((0xDF, 0)) and request[1:5] != bytes(4):
            reply = bytearray(self.queue[-1]); reply[7 + 20] = self.flags5; self.queue[-1] = bytes(reply)
        return count


class ProtocolTests(unittest.TestCase):
    def test_set_and_clear_packets(self):
        device = AppDevice(); reader = SvalReader(device); reader.info()
        self.assertTrue(reader.app_rules())
        self.assertEqual(reader.app_foreground(0xB884A32C), (0, 0xFF, 0))
        self.assertEqual(reader.app_clear(), 0)
        self.assertEqual(device.app_requests[0][:6], bytes((1, 0x2C, 0xA3, 0x84, 0xB8, 0)))
        self.assertEqual(device.app_requests[1][:1], b'\x02')
        self.assertEqual(device.app_requests[1][1:], bytes(len(device.app_requests[1]) - 1))

    def test_nothing_sent_without_the_feature_bit(self):
        device = AppDevice(flags5=0); reader = SvalReader(device); reader.info()
        writes = len(device.writes)
        self.assertFalse(reader.app_rules())
        with self.assertRaises(UnsupportedCommand): reader.app_foreground(1)
        with self.assertRaises(UnsupportedCommand): reader.app_clear()
        self.assertEqual(len(device.writes), writes)

    def test_other_bits_of_the_fifth_byte_are_not_app_rules(self):
        device = AppDevice(flags5=0xFE); reader = SvalReader(device); reader.info()
        self.assertFalse(reader.app_rules())

    def test_bad_values_never_reach_the_board(self):
        device = AppDevice(); reader = SvalReader(device); reader.info()
        for args in ((-1,), (1 << 32,), ('1',), (1, 61), (1, -1)):
            with self.assertRaises(ValueError): reader.app_foreground(*args)
        self.assertEqual(device.app_requests, [])

    def test_shown_layers_follow_the_rule(self):
        # A rule's layers show (STATUS); 0x16 still gives the modifiers, and is never written.
        device = AppDevice(); device.size = 64; device.feature_flags = 0x40; device.mask = 1; device.default_mask = 1
        device.app_layers, device.app_default = (1 << 4) | (1 << 2), 1 << 1
        reader = SvalReader(device); reader.info()
        snapshot = reader.layer_snapshot()
        self.assertEqual((snapshot.active, snapshot.default), ((1 << 4) | (1 << 2), 1 << 1))
        self.assertEqual(reader.layer_state(), (1 << 4) | (1 << 2))
        self.assertEqual([r[0] for r in device.app_requests], [0, 0])

    def test_shown_layers_fall_back_to_0x16(self):
        # Without the bit nothing is sent; a 32-byte report is too short for STATUS (status 3).
        for flags5, size in ((0, 64), (APP_RULES_FLAG5, 32)):
            device = AppDevice(flags5=flags5); device.size = size; device.feature_flags = 0x40; device.mask = 1 << 3; device.default_mask = 1
            device.app_layers = 1 << 9
            reader = SvalReader(device); reader.info()
            snapshot = reader.layer_snapshot()
            self.assertEqual((snapshot.active, snapshot.default), (1 << 3, 1), (flags5, size))
            if not flags5: self.assertEqual(device.app_requests, [])

    def test_the_read_allowlist_still_has_no_setter(self):
        self.assertNotIn(0x40, READ_COMMANDS[0xDF]); self.assertNotIn(0x41, READ_COMMANDS[0xDF])


class AppReader(poll.FakeReader):
    """The read-loop fake with app rules."""
    rules, status = True, 0

    def app_rules(self): return self.rules

    def app_foreground(self, app_id, lifetime=0):
        self.took(('set', app_id), poll.FakeReader.RTT); return self.status, 0xFF, 0

    def app_clear(self):
        self.log.append(('clear', poll.CLOCK.t)); return 0

    board_rules, board_on = [], True

    def app_rules_read(self):
        self.took('rules', poll.FakeReader.RTT); return AppRules(self.board_on, list(self.board_rules))


@unittest.skipUnless(poll.QT, 'Requires the native Qt runtime')
class SenderLoopTests(unittest.TestCase):
    """The real DeviceWorker.run loop on a fake clock."""
    A, B = app_id('notepad.exe'), app_id('chrome.exe')

    def setUp(self):
        poll.FakeReader.instances = []
        AppReader.rules, AppReader.status = True, 0
        patcher = poll.patched(AppReader); patcher.start(); self.addCleanup(patcher.stop)
        self.worker = poll.worker_module.DeviceWorker(dict(serial_number='sval:TEST', path=b'p'))
        self.worker.set_press_tracking(False)

    def run_loop(self, seconds, events=()):
        poll.CLOCK = poll.FakeClock(self.worker, 100.0 + seconds, [(100.0 + t, f) for t, f in events])
        self.worker.run()
        return poll.FakeReader.instances[0].log

    def sets(self, log):
        return [(kind[1], round(t - 100.0, 2)) for kind, t in log if isinstance(kind, tuple)]

    def test_sends_at_once_on_change_and_again_every_five_seconds(self):
        self.worker.set_foreground(self.A)
        log = self.run_loop(16.0, [(7.0, lambda: self.worker.set_foreground(self.B))])
        sets = self.sets(log)
        self.assertEqual([a for a, _ in sets], [self.A, self.A, self.B, self.B])   # B at 7 and 12 s
        times = [t for _, t in sets]
        self.assertLess(times[0], 1.0)                              # right after the profile read
        self.assertAlmostEqual(times[1] - times[0], RESEND, delta=.02)
        self.assertLess(times[2] - 7.0, .01)                        # the change goes at once
        self.assertAlmostEqual(times[3] - times[2], RESEND, delta=.02)
        self.assertEqual(log[-1][0], 'clear')                       # and CLEAR when it stops

    def test_nothing_when_the_board_lacks_the_bit(self):
        AppReader.rules = False
        self.worker.set_foreground(self.A)
        log = self.run_loop(12.0)
        self.assertEqual(self.sets(log), [])
        self.assertNotIn('clear', [k for k, _ in log])
        self.assertFalse(self.worker.app_rules)

    def test_nothing_until_the_app_in_front_is_known(self):
        log = self.run_loop(6.0)
        self.assertEqual(self.sets(log), [])
        self.assertNotIn('clear', [k for k, _ in log])              # nothing said, nothing to take back

    def test_no_app_in_front_is_sent_as_zero(self):
        self.worker.set_foreground(0)
        self.assertEqual(self.sets(self.run_loop(2.0))[0][0], 0)

    def test_the_half_without_usb_is_not_asked_again(self):
        AppReader.status = 2
        self.worker.set_foreground(self.A)
        log = self.run_loop(12.0)
        self.assertEqual(len(self.sets(log)), 1)
        self.assertFalse(self.worker.app_rules)

    def test_site_rules_are_read_at_connect_and_every_five_seconds(self):
        onshape = app_id('site:onshape.com')
        AppReader.board_rules = [(app_id('notepad.exe'), 'notepad.exe', 0), (onshape, 'onshape.com', 2)]
        self.addCleanup(setattr, AppReader, 'board_rules', [])
        seen = []
        self.worker.set_foreground(self.A)
        log = self.run_loop(11.0, [(3.0, lambda: seen.append(list(self.worker.sites)))])
        self.assertEqual(seen, [[('onshape.com', onshape)]])
        self.assertEqual(len([k for k, _ in log if k == 'rules']), 3)  # at 0, 5 and 10 s
        self.assertEqual(self.worker.sites, [])                         # forgotten once disconnected

    def test_app_layers_off_sends_nothing_and_on_again_sends_at_once(self):
        self.addCleanup(setattr, AppReader, 'board_on', True)
        AppReader.board_on = False
        self.worker.set_foreground(self.A)

        def on(): AppReader.board_on = True
        log = self.run_loop(14.0, [(7.0, on)])
        sets = self.sets(log)
        rules = [round(t - 100.0, 2) for k, t in log if k == 'rules']
        self.assertTrue(sets and all(t >= 10.0 for _, t in sets), sets)  # nothing while off
        self.assertLess(sets[0][1] - rules[2], .05)                      # the read at 10 s sees it on: sent at once
        self.assertEqual(len(rules), 3)

    def test_off_with_nothing_sent_does_not_spin(self):
        self.addCleanup(setattr, AppReader, 'board_on', True)
        AppReader.board_on = False
        self.worker.set_foreground(self.A)
        log = self.run_loop(11.0)
        self.assertEqual(self.sets(log), [])
        self.assertLess(len(log), 200, log[:20])

    def test_clear_is_sent_even_though_the_worker_is_stopping(self):
        self.worker.set_foreground(self.A)
        cancelled = []

        class Stopping(AppReader):
            def app_clear(reader):
                cancelled.append(reader.cancelled()); return super().app_clear()
        with mock.patch.object(poll.worker_module, 'SvalReader', Stopping):
            self.run_loop(3.0)
        self.assertEqual(cancelled, [False])


class FakeSource:
    def __init__(self, front, apps): self.front, self.apps = front, apps
    def foreground(self): return self.front
    def running(self): return self.apps


class LookupTests(unittest.TestCase):
    def test_running_apps_one_per_key(self):
        src = FakeSource(None, [('Code.exe', 'Visual Studio Code'), ('code.exe', 'again'), ('', 'blank'), ('a.exe', 'A')])
        self.assertEqual(running_apps(src), [('Code.exe', 'Visual Studio Code'), ('a.exe', 'A')])

    def test_snapshot_shape(self):
        snap = apps_snapshot(FakeSource(('notepad.exe', 'Notepad'), [('notepad.exe', 'Notepad')]), platform='win32')
        self.assertEqual(snap, dict(platform='windows', foreground=dict(key='notepad.exe', name='Notepad'),
                                    apps=[dict(key='notepad.exe', name='Notepad')]))
        self.assertIsNone(apps_snapshot(FakeSource(None, []), platform='darwin')['foreground'])
        self.assertEqual(apps_snapshot(FakeSource(None, []), platform='linux')['platform'], 'linux')

    def test_a_failing_lookup_is_no_app(self):
        class Broken:
            def foreground(self): raise OSError('gone')
            def running(self): raise OSError('gone')
        self.assertIsNone(foreground.foreground_app(Broken()))
        self.assertEqual(running_apps(Broken()), [])


class MacLookupTests(unittest.TestCase):
    """NSWorkspace through a fake objc_msgSend: objects are names, messages are looked up."""

    def setUp(self):
        apps = [dict(bundle='com.apple.Safari', name='Safari', policy=0),
                dict(bundle='com.apple.dock', name='Dock', policy=2),          # not a regular app
                dict(bundle=None, name='No bundle', policy=0),
                dict(bundle='com.microsoft.VSCode', name='Code', policy=0)]
        objects = {'workspace': None, 'list': None}
        objects.update({f'app{i}': a for i, a in enumerate(apps)})

        def send(receiver, selector, restype=None, *args):
            if receiver == 'NSWorkspace' and selector == 'sharedWorkspace': return 'workspace'
            if receiver == 'workspace' and selector == 'frontmostApplication': return 'app0'
            if receiver == 'workspace' and selector == 'runningApplications': return 'list'
            if receiver == 'list' and selector == 'count': return len(apps)
            if receiver == 'list' and selector == 'objectAtIndex:': return f'app{args[0][1]}'
            app = objects.get(receiver)
            if selector == 'bundleIdentifier': return ('s', app['bundle']) if app['bundle'] else None
            if selector == 'localizedName': return ('s', app['name'])
            if selector == 'activationPolicy': return app['policy']
            if selector == 'UTF8String': return receiver[1].encode()
            raise AssertionError((receiver, selector))

        class Runtime:
            """Plain functions, so _MacOS can set restype and argtypes on them as on ctypes ones."""
            def __init__(self):
                self.pools = []
                def push(): self.pools.append('open'); return 1
                def pop(pool): self.pools.append('closed')
                self.objc_autoreleasePoolPush, self.objc_autoreleasePoolPop = push, pop
                self.objc_getClass = lambda name: name.decode()
        self.runtime = Runtime()
        self.mac = foreground._MacOS(send=send, runtime=self.runtime)

    def test_frontmost_bundle_id(self):
        self.assertEqual(self.mac.foreground(), ('com.apple.Safari', 'Safari'))
        self.assertEqual(self.runtime.pools[-2:], ['open', 'closed'])

    def test_regular_apps_with_a_bundle_id(self):
        self.assertEqual(self.mac.running(), [('com.apple.Safari', 'Safari'), ('com.microsoft.VSCode', 'Code')])


class LinuxLookupTests(unittest.TestCase):
    SWAY = dict(nodes=[dict(nodes=[
        dict(pid=10, app_id='firefox', focused=False, nodes=[]),
        dict(pid=11, app_id=None, window_properties=dict(**{'class': 'Gimp'}), focused=True, nodes=[]),
    ], floating_nodes=[dict(pid=12, app_id='org.gnome.Calculator', nodes=[])])])

    def test_sway_focused_window_and_list(self):
        sway = foreground._Sway(run=lambda command: json.dumps(self.SWAY))
        self.assertEqual(sway.foreground(), ('Gimp', 'Gimp'))
        self.assertEqual(sorted(k for k, _ in sway.running()), ['Gimp', 'firefox', 'org.gnome.Calculator'])

    def test_hyprland(self):
        replies = {'activewindow': dict(**{'class': 'kitty', 'initialTitle': 'kitty'}),
                   'clients': [dict(**{'class': 'kitty'}), dict(**{'class': 'firefox'}), {}]}
        hypr = foreground._Hyprland(run=lambda command: json.dumps(replies[command[1]]))
        self.assertEqual(hypr.foreground(), ('kitty', 'kitty'))
        self.assertEqual(hypr.running(), [('kitty', 'kitty'), ('firefox', 'firefox')])

    def test_a_missing_tool_or_bad_output_is_nothing(self):
        def fail(command): raise OSError('not found')
        self.assertIsNone(foreground._Hyprland(run=fail).foreground())
        self.assertEqual(foreground._Sway(run=lambda c: 'not json').running(), [])

    def test_kde_through_kdotool(self):
        kde = foreground._Kde(run=lambda command: 'org.kde.dolphin\n')
        self.assertEqual(kde.foreground(), ('org.kde.dolphin', 'org.kde.dolphin'))
        self.assertEqual(kde.running(), [('org.kde.dolphin', 'org.kde.dolphin')])
        def fail(command): raise OSError('not found')
        self.assertIsNone(foreground._Kde(run=fail).foreground())
        self.assertIsNone(foreground._Kde(run=lambda c: '').foreground())

    def test_source_choice(self):
        has = lambda name: f'/usr/bin/{name}'
        self.assertIsInstance(foreground.linux_source(dict(SWAYSOCK='/s', WAYLAND_DISPLAY='wayland-1'), has), foreground._Sway)
        self.assertIsInstance(foreground.linux_source(dict(HYPRLAND_INSTANCE_SIGNATURE='x', WAYLAND_DISPLAY='w'), has), foreground._Hyprland)
        kde = dict(WAYLAND_DISPLAY='wayland-0', DISPLAY=':0', XDG_CURRENT_DESKTOP='KDE')
        self.assertIsInstance(foreground.linux_source(kde, has), foreground._Kde)
        self.assertIsInstance(foreground.linux_source(kde, lambda n: None), foreground._Nothing)
        # GNOME (or KDE without kdotool) on Wayland: never XWayland's stale active window.
        self.assertIsInstance(foreground.linux_source(dict(WAYLAND_DISPLAY='wayland-0', DISPLAY=':0'), has), foreground._Nothing)
        self.assertIsInstance(foreground.linux_source(dict(SWAYSOCK='/s', WAYLAND_DISPLAY='w'), lambda n: None), foreground._Nothing)
        self.assertIsInstance(foreground.linux_source({}, has), foreground._Nothing)
        with mock.patch.object(foreground, '_X11', side_effect=OSError('no libX11')):
            self.assertIsInstance(foreground.linux_source(dict(DISPLAY=':0'), has), foreground._Nothing)


class AppsEndpointTests(unittest.TestCase):
    PROD = 'https://keybard.svalboard.com'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); root = Path(self.temp.name)
        (root / 'index.html').write_text('<html lang="en"><body>Keybard</body></html>')
        self.state = HostState(root / 'prefs.json')
        self.snapshot = dict(platform='windows', foreground=dict(key='notepad.exe', name='Notepad'),
                             apps=[dict(key='notepad.exe', name='Notepad')])
        self.server = make_server(self.state, root, lambda c: None, apps=lambda: self.snapshot)
        self.thread = threading.Thread(target=self.server.serve_forever); self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def get(self, headers):
        return urlopen(Request(self.base + '/api/host/apps', headers=headers))

    def test_local_page_and_hosted_keybard_with_the_token(self):
        with self.get({'X-Keybard-Token': self.state.token}) as r:
            self.assertEqual(json.load(r), self.snapshot)
        with self.get({'X-Keybard-Token': self.state.token, 'Origin': self.PROD}) as r:
            self.assertEqual(r.headers['Access-Control-Allow-Origin'], self.PROD)
            self.assertEqual(json.load(r), self.snapshot)

    def test_refused_without_the_token_or_from_another_origin(self):
        for headers in ({}, {'X-Keybard-Token': 'wrong'}, {'Origin': self.PROD},
                        {'X-Keybard-Token': self.state.token, 'Origin': 'https://evil.example'},
                        {'X-Keybard-Token': self.state.token, 'Origin': 'https://svalboard.github.io'}):
            with self.assertRaises(HTTPError) as error: self.get(headers)
            self.assertEqual(error.exception.code, 403)


@unittest.skipUnless(poll.QT, 'Requires the native Qt runtime')
class InstanceTests(unittest.TestCase):
    def test_a_test_instance_has_its_own_name(self):
        from keybard_host.__main__ import instance_name
        self.assertEqual(instance_name(None), 'Keybard Host')
        self.assertEqual(instance_name('apptest'), 'Keybard Host apptest')
        for bad in ('', '../x', 'a b', 'x' * 33):
            with self.assertRaises(SystemExit): instance_name(bad)


if __name__ == '__main__':
    unittest.main()
