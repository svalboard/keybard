"""When a board's reader reads the layer state and the switch matrix (device/schedule.py),
and the read loop that follows it (device/worker.py)."""
import os
import threading
import time
import unittest
from unittest import mock

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from keybard_host.device.protocol import LayerSnapshot
from keybard_host.device.schedule import FAST, HELD_IDLE, IDLE, SETTLE, PollScheduler

try:
    from keybard_host.device import worker as worker_module
    QT = True
except ImportError:
    QT = False

IDLE_LAYER = LayerSnapshot(1, 1, None)
NONE = frozenset()


def run(sched, seconds, start=0.0, layer=lambda t: IDLE_LAYER, keys=lambda t: NONE):
    """Drive the scheduler as the worker does, each read taking no time; return the read times."""
    t, reads = max(start, sched.next_at), []
    while t < start + seconds:
        reads.append(t)
        sched.done(layer(t), keys(t) if sched.reads_matrix(t) else None, t)
        t = sched.next_at
    return reads


def gaps(reads):
    return [round(b - a, 6) for a, b in zip(reads, reads[1:])]


class SchedulerTests(unittest.TestCase):
    def test_shown_held_keys_read_fast_then_back_off_one_frame(self):
        s = PollScheduler(0.0)
        s.set_plan(True, False, 0.0)
        reads = run(s, 3.0)
        self.assertEqual(gaps(reads)[0], FAST)
        settled = [g for r, g in zip(reads, gaps(reads)) if r > SETTLE + .05]
        self.assertTrue(settled)
        self.assertEqual(max(settled), HELD_IDLE)                          # never slower than a frame
        self.assertTrue(s.wants_matrix)

    def test_idle_and_unshown_backs_off_to_four_reads_a_second(self):
        s = PollScheduler(0.0)
        s.set_plan(False, False, 0.0)
        self.assertFalse(s.wants_matrix)
        reads = run(s, 60.0)
        self.assertLessEqual(max(gaps(reads)), IDLE)
        late = [r for r in reads if r > 10]
        self.assertAlmostEqual(len(late) / 50, 1 / IDLE, delta=.2)         # about 4/s once settled
        self.assertLess(len(reads), 60 * 6)                                # was 125/s (0x16 every 8 ms)

    def test_any_change_returns_to_the_fast_rate_at_once(self):
        s = PollScheduler(0.0)
        s.set_plan(False, False, 0.0)
        run(s, 5.0)
        self.assertEqual(s.interval, IDLE)
        # A layer change at 5 s: seen within IDLE, then read fast for SETTLE.
        layer = lambda t: IDLE_LAYER if t < 5.0 else LayerSnapshot(2, 1, None)
        reads = run(s, 2.0, start=5.0, layer=layer)
        self.assertLessEqual(reads[0] - 5.0, IDLE)
        self.assertEqual(gaps(reads)[0], FAST)
        fast = [g for r, g in zip(reads, gaps(reads)) if r < reads[0] + SETTLE - .01]
        self.assertTrue(fast and all(g == FAST for g in fast))

    def test_held_keys_keep_the_fast_rate_while_held(self):
        s = PollScheduler(0.0)
        s.set_plan(True, False, 0.0)
        held = lambda t: frozenset({(0, 1)}) if 2.0 <= t < 4.0 else NONE
        reads = run(s, 5.0, keys=held)
        during = [g for r, g in zip(reads, gaps(reads)) if 2.02 <= r < 3.98]
        self.assertTrue(during and all(g == FAST for g in during))
        first = next(r for r in reads if r >= 2.0)
        self.assertLessEqual(first - 2.0, HELD_IDLE)                       # a press after a quiet spell
        after = [g for r, g in zip(reads, gaps(reads)) if 4.0 <= r < 4.0 + SETTLE - .01]
        self.assertTrue(after and all(g == FAST for g in after))           # letting go is a change too

    def test_watch_samples_the_matrix_slowly_and_speeds_up_on_a_key(self):
        s = PollScheduler(0.0)
        s.set_plan(False, True, 0.0)
        self.assertTrue(s.wants_matrix)
        run(s, 5.0)
        self.assertEqual(s.interval, IDLE)
        held = lambda t: frozenset({(6, 0)}) if t >= 5.0 else NONE
        reads = run(s, 1.0, start=5.0, keys=held)
        self.assertLessEqual(reads[0] - 5.0, IDLE)
        self.assertEqual(gaps(reads)[0], FAST)

    def test_a_shown_layer_reads_fast_without_the_matrix(self):
        # Highlight held keys off, overlay on screen: layer changes as fast as with it on.
        s = PollScheduler(0.0)
        s.set_plan(False, False, 0.0, layer=True)
        self.assertFalse(s.reads_matrix(0.0))
        layer = lambda t: IDLE_LAYER if t < 5.0 else LayerSnapshot(2, 1, None)
        reads = run(s, 6.0, layer=layer)
        self.assertLessEqual(max(gaps(reads)), HELD_IDLE)
        self.assertLessEqual(next(r for r in reads if r >= 5.0) - 5.0, HELD_IDLE)

    def test_watching_a_shown_layer_samples_the_matrix_slowly(self):
        # Several boards, Highlight held keys off: the layer fast, held keys only sampled.
        s = PollScheduler(0.0)
        s.set_plan(False, True, 0.0, layer=True)
        held = lambda t: frozenset({(1, 1)}) if 8.0 <= t < 9.0 else NONE
        samples, t = [], 0.0
        while t < 10.0:
            keys = held(t) if s.reads_matrix(t) else None
            if keys is not None: samples.append(t)
            s.done(IDLE_LAYER, keys, t); t = s.next_at
        quiet = [x for x in samples if 2 <= x < 7.9]
        self.assertAlmostEqual(len(quiet) / 5.9, 1 / IDLE, delta=.5)       # about 4/s, not 60/s
        during = [b - a for a, b in zip(samples, samples[1:]) if 8.3 <= a < 8.9]
        self.assertTrue(during and max(during) <= HELD_IDLE)               # every read while held

    def test_showing_held_keys_reads_at_once_and_fast(self):
        s = PollScheduler(0.0)
        s.set_plan(False, False, 0.0)
        run(s, 5.0)
        self.assertGreater(s.next_at, 5.0)
        s.set_plan(True, False, 5.0)
        self.assertTrue(s.due(5.0))
        self.assertEqual(s.interval, FAST)

    def test_showing_the_layer_reads_at_once_and_fast(self):
        s = PollScheduler(0.0)
        s.set_plan(False, False, 0.0)
        run(s, 5.0)
        s.set_plan(False, False, 5.0, layer=True)
        self.assertTrue(s.due(5.0))
        self.assertEqual(s.ceiling, HELD_IDLE)

    def test_hiding_held_keys_keeps_the_current_slow_read_and_forgets_the_matrix(self):
        s = PollScheduler(0.0)
        s.set_plan(True, False, 0.0)
        run(s, 2.0, keys=lambda t: frozenset({(0, 0)}))
        s.set_plan(False, False, 2.0)
        self.assertFalse(s.wants_matrix)
        self.assertIsNone(s.last[1])
        self.assertLessEqual(s.next_at, 2.0 + IDLE)
        # Showing again: the first matrix read compares with nothing, so it isn't a "change".
        s.set_plan(True, False, 3.0)
        self.assertFalse(s.done(IDLE_LAYER, frozenset(), 3.0))

    def test_read_now_reads_without_changing_the_rate(self):
        s = PollScheduler(0.0)
        s.set_plan(False, False, 0.0)
        run(s, 5.0)
        s.read_now(5.0)
        self.assertTrue(s.due(5.0))
        self.assertEqual(s.interval, IDLE)

    def test_the_same_plan_again_changes_nothing(self):
        s = PollScheduler(0.0)
        s.set_plan(False, False, 0.0)
        run(s, 5.0)
        before = (s.interval, s.next_at, s.last_change)
        s.set_plan(False, False, 5.0)
        self.assertEqual((s.interval, s.next_at, s.last_change), before)


CLOCK = None


class FakeClock:
    """The read loop's clock and sleep: time moves only when the loop sleeps or a read takes time."""

    def __init__(self, worker, until, events=()):
        self.t, self.worker, self.until = 100.0, worker, until
        self.events = sorted(events, key=lambda e: e[0])   # (time, callable), run when reached
        worker.clock = lambda: self.t
        worker.wait_for_wake = self.wait

    def advance(self, seconds):
        self.t += seconds
        while self.events and self.events[0][0] <= self.t:
            self.events.pop(0)[1]()

    def wait(self, timeout):
        if self.worker.wake_event.is_set():
            return True                                   # woken: the real Event returns at once
        step = timeout if not self.events else min(timeout, max(0, self.events[0][0] - self.t))
        self.advance(step)
        if self.t >= self.until:
            self.worker.stop()
        return self.worker.wake_event.is_set()


class FakeReader:
    """Enough of SvalReader for the read loop: logs each read at the fake time. A round trip
    takes RTT and a profile read PROFILE (Keybard's refresh estimate)."""
    RTT, PROFILE = .003, .6
    instances = []

    def __init__(self, device, cancelled=lambda: False):
        self.feature_flags = self.feature_flags2 = 0
        self.log = []
        FakeReader.instances.append(self)

    def took(self, kind, seconds):
        self.log.append((kind, CLOCK.t)); CLOCK.advance(seconds)

    def info(self): return 3, 1
    def checkpoint(self): pass
    def pointing_watching(self): return False
    def app_rules(self): return False
    def pointing_motion(self): return None

    def read_profile(self, uid, progress=None, reuse_definition=False):
        self.took('profile', self.PROFILE); return 'profile'

    def layer_snapshot(self):
        self.took('layer', self.RTT); return IDLE_LAYER

    def pressed_keys(self):
        self.took('matrix', self.RTT); return NONE


class FakeDevice:
    def open_path(self, path): pass
    def close(self): pass


def patched(reader):
    hid = mock.Mock(); hid.device = FakeDevice
    return mock.patch.multiple(worker_module, SvalReader=reader, hid_backend=lambda: hid,
                               candidates=lambda hid: [dict(serial_number='sval:TEST', path=b'p')])


@unittest.skipUnless(QT, 'Requires the native Qt runtime')
class ReadLoopTests(unittest.TestCase):
    """The real DeviceWorker.run loop on a fake clock: the same result however loaded the machine."""

    def setUp(self):
        FakeReader.instances = []
        patcher = patched(FakeReader); patcher.start(); self.addCleanup(patcher.stop)
        self.worker = worker_module.DeviceWorker(dict(serial_number='sval:TEST', path=b'p'))

    def run_loop(self, seconds, events=()):
        global CLOCK
        CLOCK = FakeClock(self.worker, 100.0 + seconds, [(100.0 + t, f) for t, f in events])
        self.worker.run()                     # returns once the clock passes the end and stops it
        return FakeReader.instances[0].log

    def reads(self, log, kind, start, end):
        return [t for k, t in log if k == kind and 100.0 + start <= t < 100.0 + end]

    def test_unshown_board_reads_its_layer_slowly_and_never_the_matrix(self):
        self.worker.set_press_tracking(False)
        log = self.run_loop(10.0)
        self.assertEqual(self.reads(log, 'matrix', 0, 10), [])
        self.assertAlmostEqual(len(self.reads(log, 'layer', 5, 10)) / 5, 1 / IDLE, delta=.3)

    def test_a_new_plan_applies_at_once(self):
        self.worker.set_press_tracking(False)
        log = self.run_loop(6.0, [(3.0, lambda: self.worker.set_press_tracking(True))])
        self.assertEqual(self.reads(log, 'matrix', 0, 3), [])
        self.assertLess(self.reads(log, 'matrix', 3, 6)[0] - 103.0, .01)   # not after the 250 ms sleep
        self.assertGreater(len(self.reads(log, 'matrix', 4, 6)) / 2, 50)   # then about 60/s

    def test_a_shown_layer_with_highlight_off_is_read_fast_without_the_matrix(self):
        self.worker.set_press_tracking(False, layer=True)
        log = self.run_loop(5.0)
        self.assertEqual(self.reads(log, 'matrix', 0, 5), [])
        layers = self.reads(log, 'layer', 2, 5)
        self.assertLessEqual(max(b - a for a, b in zip(layers, layers[1:])), HELD_IDLE + .001)

    def test_a_slow_refresh_keeps_layer_reads_inside_the_overlays_staleness_check(self):
        # Host.tick blanks a board after 0.6 s without a layer state; a refresh read takes ~0.6 s.
        self.worker.set_press_tracking(False)
        log = self.run_loop(8.0, [(5.0, self.worker.refresh)])
        refresh = next(t for k, t in log if k == 'profile' and t > 104)
        before = max(t for k, t in log if k == 'layer' and t <= refresh)
        after = min(t for k, t in log if k == 'layer' and t > refresh)
        self.assertLess(refresh - before, .01)                             # read just before the profile
        self.assertLessEqual(after - refresh, FakeReader.PROFILE + .01)    # and again right after it
        layers = [t for k, t in log if k == 'layer']
        self.assertLessEqual(max(b - a for a, b in zip(layers, layers[1:])),
                             FakeReader.PROFILE + FakeReader.RTT + .001)   # no wider gap anywhere

    def test_a_failed_layer_read_before_a_refresh_reconnects_rather_than_deferring(self):
        statuses = []
        self.worker.status.connect(statuses.append)
        self.worker.set_press_tracking(False)
        fail = []

        def refresh_and_fail():
            fail.append(True); self.worker.refresh()

        original = FakeReader.layer_snapshot

        def layer_snapshot(reader):
            if fail and reader is FakeReader.instances[0]:
                fail.clear()
                raise worker_module.ProtocolError('Svalboard response timed out')
            return original(reader)
        with mock.patch.object(FakeReader, 'layer_snapshot', layer_snapshot):
            self.run_loop(8.0, [(5.0, refresh_and_fail)])
        self.assertFalse(any(s.startswith('Layout refresh deferred') for s in statuses))
        self.assertTrue(any(s.startswith('Disconnected') for s in statuses))
        self.assertEqual(len(FakeReader.instances), 2)                     # connected again

    def test_stop_ends_the_loop_at_once_even_while_idle(self):
        self.worker.set_press_tracking(False)
        stopped_at = []

        def stop():
            self.worker.stop(); stopped_at.append(CLOCK.t)
        log = self.run_loop(30.0, [(5.0, stop)])
        self.assertEqual(stopped_at, [105.0])
        self.assertTrue(all(t <= 105.0 for _, t in log))
        self.assertLess(CLOCK.t - 105.0, .01)                              # didn't sleep out the interval


class CountingReader(FakeReader):
    reads = 0

    def took(self, kind, seconds):
        CountingReader.reads += 1


@unittest.skipUnless(QT, 'Requires the native Qt runtime')
class RealClockTests(unittest.TestCase):
    """One smoke test on the real clock and Event, with loose bounds for loaded CI runners."""

    def test_runs_reads_and_stops(self):
        CountingReader.reads = 0
        with patched(CountingReader):
            worker = worker_module.DeviceWorker(dict(serial_number='sval:TEST', path=b'p'))
            worker.set_press_tracking(True)
            thread = threading.Thread(target=worker.run, daemon=True)
            thread.start()
            time.sleep(.5)
            worker.stop()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertGreater(CountingReader.reads, 5)


if __name__ == '__main__':
    unittest.main()
