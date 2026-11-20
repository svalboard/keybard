"""Site rules: app rules for a website. Normalizing and matching sites, reading the host name
from an address bar, the sites read back from the board's rule labels, the address-bar reads
off the Host's thread (with their fallbacks), and the Host's choice of app ID."""
import os
import threading
import time
import types
import unittest

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from keybard_host import address_bar
from keybard_host.address_bar import KEEP, NoAddressBar, TimedReader, host_of_address
from keybard_host.foreground import app_id
from keybard_host.site_rules import (PENDING, SiteWatcher, choose_id, host_matches, match_site, normalize_site,
                                     site_id, site_key, site_rules)
from keybard_host.device.protocol import SvalReader, UnsupportedCommand
from test_app_rules import AppDevice

ONSHAPE = site_id('onshape.com')


class NormalizeTests(unittest.TestCase):
    def test_vectors_shared_with_keybard(self):
        # The same numbers are in Keybard's tests/services/app-rules.test.ts.
        self.assertEqual(site_key('onshape.com'), 'site:onshape.com')
        self.assertEqual(ONSHAPE, 0xB2AF5B45)
        self.assertEqual(ONSHAPE, app_id('site:onshape.com'))
        self.assertEqual(site_id('cad.onshape.com'), 0x7E364D67)

    def test_what_people_type_comes_down_to_the_site(self):
        for typed in ('onshape.com', 'Onshape.COM', ' onshape.com\t', 'https://www.onshape.com/documents?x=1',
                      'http://onshape.com:8080', '*.onshape.com', 'site:onshape.com', 'SITE: onshape.com',
                      'onshape.com.', 'user@onshape.com', 'onshape.com#top', 'www.onshape.com'):
            self.assertEqual(normalize_site(typed), 'onshape.com', typed)

    def test_www_alone_and_subdomains_stay(self):
        self.assertEqual(normalize_site('www.com'), 'www.com')
        self.assertEqual(normalize_site('cad.onshape.com'), 'cad.onshape.com')
        self.assertEqual(normalize_site('localhost:5173'), 'localhost')

    def test_idn_is_plain_text(self):
        # Punycode and Unicode are different sites; non-ASCII letters aren't lowered (as app keys).
        self.assertEqual(normalize_site('xn--bcher-kva.de'), 'xn--bcher-kva.de')
        self.assertEqual(normalize_site('bücher.de'), 'bücher.de')
        self.assertNotEqual(site_id('bücher.de'), site_id('xn--bcher-kva.de'))

    def test_nothing_left_is_no_site(self):
        for typed in ('', '   ', 'site:', 'https://', '*.'):
            self.assertEqual(normalize_site(typed), '', typed)
            self.assertEqual(site_id(typed), 0)


class AddressTests(unittest.TestCase):
    def test_host_of_what_browsers_show(self):
        for text, host in (('cad.onshape.com/documents/abc/w/def', 'cad.onshape.com'),   # Chrome hides https://
                           ('https://cad.onshape.com/documents', 'cad.onshape.com'),
                           ('http://Example.COM:8080/x?y#z', 'example.com'),
                           ('https://user:pw@example.com/', 'example.com'),
                           ('example.com', 'example.com'),
                           ('example.com.', 'example.com'),
                           ('localhost:5173/keybard/', 'localhost'),
                           ('xn--bcher-kva.de/x', 'xn--bcher-kva.de'),
                           ('bücher.de', 'bücher.de')):
            self.assertEqual(host_of_address(text), host, text)

    def test_no_host_for_search_text_browser_pages_and_files(self):
        for text in ('', None, 'how to onshape', 'chrome://settings', 'edge://flags', 'about:blank',
                     'file:///C:/x.html', 'view-source:https://example.com', 'onshape', '[::1]:8080/x'):
            self.assertIsNone(host_of_address(text), text)


class MatchTests(unittest.TestCase):
    SITES = [('onshape.com', ONSHAPE), ('cad.onshape.com', site_id('cad.onshape.com'))]

    def test_the_site_and_hosts_under_it(self):
        self.assertTrue(host_matches('onshape.com', 'onshape.com'))
        self.assertTrue(host_matches('www.onshape.com', 'onshape.com'))
        self.assertTrue(host_matches('a.b.onshape.com', 'onshape.com'))
        self.assertFalse(host_matches('notonshape.com', 'onshape.com'))
        self.assertFalse(host_matches('onshape.com.evil.net', 'onshape.com'))
        self.assertFalse(host_matches('onshape.co', 'onshape.com'))
        self.assertFalse(host_matches('', 'onshape.com'))

    def test_the_most_specific_site_wins(self):
        self.assertEqual(match_site('cad.onshape.com', self.SITES), site_id('cad.onshape.com'))
        self.assertEqual(match_site('www.onshape.com', self.SITES), ONSHAPE)
        self.assertIsNone(match_site('example.com', self.SITES))

    def test_the_program_otherwise(self):
        self.assertEqual(choose_id('chrome.exe', 'cad.onshape.com', [('onshape.com', ONSHAPE)]), ONSHAPE)
        self.assertEqual(choose_id('chrome.exe', 'example.com', [('onshape.com', ONSHAPE)]), app_id('chrome.exe'))
        self.assertEqual(choose_id('chrome.exe', None, [('onshape.com', ONSHAPE)]), app_id('chrome.exe'))
        self.assertEqual(choose_id('chrome.exe', 'onshape.com', []), app_id('chrome.exe'))
        self.assertEqual(choose_id(None, None, []), 0)


class LabelTests(unittest.TestCase):
    def test_sites_come_back_from_the_labels(self):
        rules = [(app_id('notepad.exe'), 'Notepad'), (ONSHAPE, 'onshape.com'), (site_id('github.com'), 'github.com')]
        self.assertEqual(site_rules(rules), [('onshape.com', ONSHAPE), ('github.com', site_id('github.com'))])

    def test_a_label_that_only_looks_like_a_site_is_not_one(self):
        # A program rule labeled "onshape.com" keeps its program's ID: not a site rule.
        self.assertEqual(site_rules([(app_id('chrome.exe'), 'onshape.com'), (0, ''), (ONSHAPE, '')]), [])

    def test_a_site_longer_than_the_label_is_kept_whole_by_its_id(self):
        # practice.svalboard.com is 22 bytes: the label is its end after LONG_MARK, display only.
        practice = site_id('practice.svalboard.com')
        self.assertEqual(site_rules([(practice, '…lboard.com')]), [('…lboard.com', practice)])
        label = 'docs.onshape.com'.encode()[:13].decode()  # cut without the mark: not a site rule
        self.assertEqual(site_rules([(site_id('docs.onshape.com'), label)]), [])
        self.assertEqual(site_rules([(practice, '…')]), [])


class FlagTests(unittest.TestCase):
    PRACTICE = site_id('practice.svalboard.com')

    def test_a_rule_that_is_off_never_matches(self):
        self.assertEqual(site_rules([(ONSHAPE, 'onshape.com', 3), (site_id('github.com'), 'github.com', 2)]),
                         [('github.com', site_id('github.com'))])
        self.assertEqual(site_rules([(self.PRACTICE, 'practice.svalboard.com', 1)]), [])

    def test_the_whole_site_is_the_text(self):
        sites = site_rules([(self.PRACTICE, 'practice.svalboard.com', 2)])
        self.assertEqual(sites, [('practice.svalboard.com', self.PRACTICE)])
        self.assertEqual(match_site('a.practice.svalboard.com', sites), self.PRACTICE)

    def test_an_upgraded_label_still_matches_by_its_id(self):
        # Format 1 kept only the end of a long site; the board upgrades it with the website flag.
        sites = site_rules([(self.PRACTICE, '…lboard.com', 2)])
        self.assertEqual(sites, [('…lboard.com', self.PRACTICE)])
        self.assertEqual(match_site('practice.svalboard.com', sites), self.PRACTICE)
        self.assertIsNone(match_site('svalboard.com', sites))

    def test_a_program_rule_whose_text_looks_like_a_site_is_not_one(self):
        self.assertEqual(site_rules([(app_id('chrome.exe'), 'onshape.com', 0)]), [])


class LongSiteTests(unittest.TestCase):
    """A rule for practice.svalboard.com matches it and the hosts under it, never the rest of svalboard.com."""
    PRACTICE = site_id('practice.svalboard.com')
    SITES = [('onshape.com', ONSHAPE), ('…lboard.com', PRACTICE)]

    def test_the_whole_site_and_hosts_under_it(self):
        self.assertEqual(match_site('practice.svalboard.com', self.SITES), self.PRACTICE)
        self.assertEqual(match_site('www.practice.svalboard.com', self.SITES), self.PRACTICE)
        self.assertEqual(match_site('a.practice.svalboard.com', self.SITES), self.PRACTICE)

    def test_never_its_neighbors(self):
        for host in ('svalboard.com', 'next.keybard.svalboard.com', 'docs.svalboard.com', 'lboard.com',
                     'notpractice.svalboard.com', 'practice.svalboard.com.evil.net'):
            self.assertIsNone(match_site(host, self.SITES), host)
            self.assertEqual(choose_id('brave.exe', host, self.SITES), app_id('brave.exe'), host)

    def test_the_most_specific_rule_wins_whatever_the_order(self):
        broad = site_id('svalboard.com')
        for sites in ([('svalboard.com', broad), ('…lboard.com', self.PRACTICE)],
                      [('…lboard.com', self.PRACTICE), ('svalboard.com', broad)]):
            self.assertEqual(match_site('practice.svalboard.com', sites), self.PRACTICE)
            self.assertEqual(match_site('docs.svalboard.com', sites), broad)

    def test_a_site_that_fits_matches_as_before(self):
        self.assertEqual(match_site('cad.onshape.com', self.SITES), ONSHAPE)
        self.assertEqual(match_site('localhost', [('localhost', site_id('localhost'))]), site_id('localhost'))


# ---------------------------------------------------------------- the reads, off the Host's thread

class ManualReader:
    """A TimedReader double: requests wait until the test answers them."""
    def __init__(self, done): self.done, self.jobs, self.busy, self.forgotten = done, [], False, []
    def request(self, token, window, browser):
        if self.busy: return False
        self.jobs.append((token, window, browser)); self.busy = True; return True
    def answer(self, host):
        token, _, _ = self.jobs[-1]; self.busy = False; self.done(token, host)
    def forget(self, window): self.forgotten.append(window)
    def close(self): pass


class Clock:
    def __init__(self): self.t = 100.0
    def __call__(self): return self.t


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.notified = Clock(), []
        self.watcher = SiteWatcher(lambda done: ManualReader(done), notify=lambda: self.notified.append(1), clock=self.clock)
        self.reader = self.watcher.reader

    def test_programs_that_are_not_browsers_are_never_read(self):
        self.assertIsNone(self.watcher.host_for(1, 'notepad.exe', 'x'))
        self.assertIsNone(self.watcher.host_for(None, 'chrome.exe', None))  # no window: macOS, Linux
        self.assertEqual(self.reader.jobs, [])

    def test_pending_then_the_host(self):
        self.assertIs(self.watcher.host_for(1, 'chrome.exe', 'Doc | Part Studio'), PENDING)
        self.assertEqual(self.reader.jobs[0][1:], (1, 'chrome.exe'))
        self.reader.answer('cad.onshape.com')
        self.assertEqual(self.notified, [1])
        self.assertEqual(self.watcher.host_for(1, 'chrome.exe', 'Doc | Part Studio'), 'cad.onshape.com')
        self.assertEqual(len(self.reader.jobs), 1)  # cached: no new read

    def test_a_slow_read_falls_back_to_the_program_then_counts_when_it_comes(self):
        self.watcher.host_for(1, 'chrome.exe', 'A')
        self.clock.t += .2
        self.assertIsNone(self.watcher.host_for(1, 'chrome.exe', 'A'))
        self.reader.answer('cad.onshape.com')
        self.assertEqual(self.watcher.host_for(1, 'chrome.exe', 'A'), 'cad.onshape.com')

    def test_a_failed_read_is_the_program(self):
        self.watcher.host_for(1, 'chrome.exe', 'A'); self.reader.answer(None)
        self.assertIsNone(self.watcher.host_for(1, 'chrome.exe', 'A'))

    def test_a_reader_still_stuck_on_another_read_is_the_program(self):
        self.reader.busy = True
        self.assertIsNone(self.watcher.host_for(1, 'chrome.exe', 'A'))

    def test_another_tab_reads_again(self):
        self.watcher.host_for(1, 'chrome.exe', 'Onshape'); self.reader.answer('cad.onshape.com')
        self.assertIs(self.watcher.host_for(1, 'chrome.exe', 'Inbox - Gmail'), PENDING)
        self.reader.answer('mail.google.com')
        self.assertEqual(self.watcher.host_for(1, 'chrome.exe', 'Inbox - Gmail'), 'mail.google.com')

    def test_a_tab_switch_during_a_read_reads_again(self):
        self.watcher.host_for(1, 'chrome.exe', 'Onshape')
        self.watcher.host_for(1, 'chrome.exe', 'Gmail')       # the read for "Onshape" still running
        self.reader.answer('cad.onshape.com')                 # an answer for the old tab: not used
        self.assertIs(self.watcher.host_for(1, 'chrome.exe', 'Gmail'), PENDING)
        self.assertEqual(len(self.reader.jobs), 2)

    def test_read_again_every_five_seconds(self):
        self.watcher.host_for(1, 'chrome.exe', 'A'); self.reader.answer('a.com')
        self.clock.t += 4.9; self.watcher.host_for(1, 'chrome.exe', 'A')
        self.assertEqual(len(self.reader.jobs), 1)
        self.clock.t += .2
        self.assertEqual(self.watcher.host_for(1, 'chrome.exe', 'A'), 'a.com')  # the last host meanwhile
        self.assertEqual(len(self.reader.jobs), 2)

    def test_typing_in_the_address_bar_keeps_the_last_host(self):
        self.watcher.host_for(1, 'chrome.exe', 'A'); self.reader.answer('cad.onshape.com')
        self.clock.t += 6; self.watcher.host_for(1, 'chrome.exe', 'A'); self.reader.answer(KEEP)
        self.assertEqual(self.watcher.host_for(1, 'chrome.exe', 'A'), 'cad.onshape.com')

    def test_a_new_tab_with_the_address_bar_focused_is_the_program_not_the_last_site(self):
        # Leaving practice.svalboard.com for a new tab (Ctrl+T): the new tab's address bar has the
        # keyboard, so the read is KEEP. The practice tab's host must not carry over to it.
        self.watcher.host_for(1, 'brave.exe', 'Practice'); self.reader.answer('practice.svalboard.com')
        self.assertIs(self.watcher.host_for(1, 'brave.exe', 'New Tab'), PENDING)
        self.reader.answer(KEEP)
        self.assertIsNone(self.watcher.host_for(1, 'brave.exe', 'New Tab'))
        self.clock.t += 6; self.watcher.host_for(1, 'brave.exe', 'New Tab'); self.reader.answer(KEEP)
        self.assertIsNone(self.watcher.host_for(1, 'brave.exe', 'New Tab'))  # still typing: still none

    def test_back_to_a_tab_typing_in_its_address_bar_is_unknown_until_read(self):
        self.watcher.host_for(1, 'chrome.exe', 'Onshape'); self.reader.answer('cad.onshape.com')
        self.watcher.host_for(1, 'chrome.exe', 'Gmail'); self.reader.answer('mail.google.com')
        self.watcher.host_for(1, 'chrome.exe', 'Onshape'); self.reader.answer(KEEP)
        self.assertIsNone(self.watcher.host_for(1, 'chrome.exe', 'Onshape'))  # never Gmail's host

    def test_windows_are_kept_apart(self):
        self.watcher.host_for(1, 'chrome.exe', 'A'); self.reader.answer('a.com')
        self.watcher.host_for(2, 'msedge.exe', 'A'); self.reader.answer('b.com')
        self.assertEqual(self.watcher.host_for(1, 'chrome.exe', 'A'), 'a.com')
        self.assertEqual(self.watcher.host_for(2, 'msedge.exe', 'A'), 'b.com')

    def test_titles_are_kept_only_as_a_hash(self):
        self.watcher.host_for(1, 'chrome.exe', 'Secret document title')
        self.assertNotIn('Secret', repr(self.watcher.windows))


class TimedReaderTests(unittest.TestCase):
    def run_reader(self, host_fn, timeout=2.0):
        results, finished = [], threading.Event()

        class Reader(NoAddressBar):
            def host(self, window, browser): return host_fn(window, browser)

        timed = TimedReader(make=Reader, done=lambda token, host: (results.append((token, host)), finished.set()))
        self.addCleanup(timed.close)
        self.assertTrue(timed.request(7, 1, 'chrome.exe'))
        self.assertTrue(finished.wait(timeout))
        return timed, results

    def test_answers_on_its_own_thread(self):
        _, results = self.run_reader(lambda w, b: 'cad.onshape.com')
        self.assertEqual(results, [(7, 'cad.onshape.com')])

    def test_an_error_is_no_host_never_an_exception(self):
        def fail(w, b): raise OSError('UI Automation failed')
        _, results = self.run_reader(fail)
        self.assertEqual(results, [(7, None)])

    def test_a_hung_read_blocks_only_itself(self):
        release = threading.Event()
        timed = TimedReader(make=lambda: types.SimpleNamespace(host=lambda w, b: release.wait(5) and 'x', forget=lambda w: None, close=lambda: None),
                            done=lambda *_: None)
        self.addCleanup(timed.close); self.addCleanup(release.set)
        start = time.monotonic()
        self.assertTrue(timed.request(1, 1, 'chrome.exe'))
        self.assertLess(time.monotonic() - start, .05)      # the caller never waits
        time.sleep(.2)
        self.assertTrue(timed.stuck(.15))
        self.assertFalse(timed.request(2, 1, 'chrome.exe'))  # no pile-up behind it

    def test_a_reader_that_cannot_start_is_no_address_bar(self):
        def broken(): raise OSError('no COM')
        results, finished = [], threading.Event()
        timed = TimedReader(make=broken, done=lambda t, h: (results.append(h), finished.set()))
        self.addCleanup(timed.close)
        timed.request(1, 1, 'chrome.exe')
        self.assertTrue(finished.wait(2)); self.assertEqual(results, [None])

    def test_linux_reads_nothing(self):
        self.assertIsInstance(address_bar.make_address_bar('linux'), NoAddressBar)


# ---------------------------------------------------------------- reading the rules from the board

def record_v2(rules, off=False):
    """A format 2 record: rules are (app ID, text, flags)."""
    record = bytearray((2, len(rules), 1 if off else 0, 0))
    for rule_id, text, flags in rules:
        data = text.encode()
        record += rule_id.to_bytes(4, 'little') + bytes((0xFF, 0xFF, 0, 0, 0, 0, flags, len(data))) + data
    return bytes(record) if rules or off else bytes(4)


def record_v1(rules):
    record = bytearray(4 + 24 * len(rules)); record[0], record[1] = (1, len(rules)) if rules else (0, 0)
    for i, (rule_id, label) in enumerate(rules):
        o = 4 + 24 * i
        record[o:o + 4] = rule_id.to_bytes(4, 'little'); record[o + 4] = record[o + 5] = 0xFF
        record[o + 11:o + 11 + len(label.encode())] = label.encode()
    return bytes(record)


class RulesDevice(AppDevice):
    """AppDevice that also answers APP_RULES INFO and READ from a record (format 2 unless v1)."""

    def __init__(self, rules=(), off=False, v1=False, **kw):
        super().__init__(**kw)
        self.v1 = v1
        self.record = record_v1(rules) if v1 else record_v2(rules, off)
        self.rules_ops = []

    def write(self, packet):
        request = bytes(packet[1:])
        if request[5:7] == bytes((0xDF, 0x41)) and request[1:5] != bytes(4):
            op = request[7]; self.rules_ops.append(op); self.writes.append(packet)
            if op == 0:
                count = self.record[1]
                if self.v1:
                    data = bytes((0, 0, 1, 64, 24, count)) + (1540).to_bytes(2, 'little') + bytes((48, 16))
                else:
                    data = (bytes((0, 0, 2, 64, 12, count)) + (1792).to_bytes(2, 'little') + bytes((48, 16))
                            + len(self.record).to_bytes(2, 'little') + bytes((64, self.record[2])))
            else:
                offset, length = int.from_bytes(request[8:10], 'little'), request[10]
                data = bytes((1, 0)) + request[8:11] + self.record[offset:offset + length].ljust(length, b'\0')
            self.queue.append(request[:7] + data.ljust(self.size - 7, b'\0'))
            return len(packet)
        return super().write(packet)


PRACTICE = site_id('practice.svalboard.com')


class ProtocolTests(unittest.TestCase):
    RULES = [(app_id('notepad.exe'), 'notepad.exe', 0), (ONSHAPE, 'onshape.com', 2), (site_id('github.com'), 'github.com', 2)]

    def test_reads_the_rules_in_chunks_that_fit_the_report(self):
        for size in (32, 64):
            device = RulesDevice(self.RULES); device.size = size
            reader = SvalReader(device); reader.info()
            self.assertEqual(reader.app_rules_read(), (True, self.RULES), size)
            self.assertEqual(set(device.rules_ops), {0, 1}, size)   # INFO and READ only: never a write
            self.assertEqual(site_rules(reader.app_rules_read().rules), [('onshape.com', ONSHAPE), ('github.com', site_id('github.com'))])

    def test_a_long_site_comes_back_whole(self):
        long_site = 'a' * 60 + '.com'
        rules = [(PRACTICE, 'practice.svalboard.com', 2)] * 3 + [(site_id(long_site), long_site, 2)]
        device = RulesDevice(rules); device.size = 32
        reader = SvalReader(device); reader.info()
        self.assertEqual(reader.app_rules_read().rules, rules)
        self.assertEqual(site_rules(reader.app_rules_read().rules)[0], ('practice.svalboard.com', PRACTICE))

    def test_app_layers_off_comes_back_with_the_rules(self):
        device = RulesDevice(self.RULES, off=True); reader = SvalReader(device); reader.info()
        self.assertEqual(reader.app_rules_read(), (False, self.RULES))

    def test_a_board_with_no_rules(self):
        device = RulesDevice(); reader = SvalReader(device); reader.info()
        self.assertEqual(reader.app_rules_read(), (True, []))

    def test_format_1_firmware_reads_as_on(self):
        device = RulesDevice([(ONSHAPE, 'onshape.com'), (PRACTICE, '…lboard.com')], v1=True)
        reader = SvalReader(device); reader.info()
        record = reader.app_rules_read()
        self.assertEqual(record, (True, [(ONSHAPE, 'onshape.com', 0), (PRACTICE, '…lboard.com', 0)]))
        self.assertEqual(site_rules(record.rules), [('onshape.com', ONSHAPE), ('…lboard.com', PRACTICE)])

    def test_nothing_sent_without_the_feature_bit(self):
        device = RulesDevice(self.RULES, flags5=0); reader = SvalReader(device); reader.info()
        with self.assertRaises(UnsupportedCommand): reader.app_rules_read()
        self.assertEqual(device.rules_ops, [])


# ---------------------------------------------------------------- the Host's choice

class HostChoiceTests(unittest.TestCase):
    """Host.poll_foreground with fake workers, window and address bar."""

    def setUp(self):
        from keybard_host import __main__ as host_main
        self.main = host_main
        self.worker = types.SimpleNamespace(app_rules=True, sites=[('onshape.com', ONSHAPE)], sent=[])
        self.worker.set_foreground = self.worker.sent.append
        self.hosts = {}
        watcher = types.SimpleNamespace(host_for=lambda window, program, title: self.hosts.get(window))
        self.host = types.SimpleNamespace(boards={'a': types.SimpleNamespace(worker=self.worker)}, site_watcher=watcher,
                                          foreground_id=None, log_app_rules=False, logged_app=None)

    def poll(self, window, program, title='t'):
        original = self.main.foreground_window
        self.main.foreground_window = lambda: (window, (program, program), title)
        try: self.main.Host.poll_foreground(self.host)
        finally: self.main.foreground_window = original
        return self.worker.sent[-1] if self.worker.sent else None

    def test_a_matching_tab_sends_the_site_rule(self):
        self.hosts[1] = 'cad.onshape.com'
        self.assertEqual(self.poll(1, 'chrome.exe'), ONSHAPE)

    def test_another_tab_or_a_failed_read_sends_the_program(self):
        self.hosts[1] = 'example.com'
        self.assertEqual(self.poll(1, 'chrome.exe'), app_id('chrome.exe'))
        self.hosts[1] = None
        self.assertEqual(self.poll(1, 'chrome.exe'), app_id('chrome.exe'))

    def test_while_reading_nothing_changes(self):
        self.hosts[1] = PENDING
        self.assertIsNone(self.poll(1, 'chrome.exe'))

    def test_no_site_rules_no_reading(self):
        self.worker.sites = []
        self.host.site_watcher = types.SimpleNamespace(host_for=lambda *a: self.fail('read without site rules'))
        self.assertEqual(self.poll(1, 'chrome.exe'), app_id('chrome.exe'))

    def test_app_layers_off_reads_and_sends_nothing(self):
        self.worker.app_layers_on = False
        self.host.site_watcher = types.SimpleNamespace(host_for=lambda *a: self.fail('read while App Layers is off'))
        original = self.main.foreground_window
        self.main.foreground_window = lambda: self.fail('looked at the window while App Layers is off')
        try: self.main.Host.poll_foreground(self.host)
        finally: self.main.foreground_window = original
        self.assertEqual(self.worker.sent, [])
        self.worker.app_layers_on = True                           # back on: reading and sending resume
        self.host.site_watcher = types.SimpleNamespace(host_for=lambda *a: 'cad.onshape.com')
        self.assertEqual(self.poll(1, 'chrome.exe'), ONSHAPE)

    def test_the_log_names_the_rule_never_the_address(self):
        import io, contextlib
        self.host.log_app_rules = True
        self.hosts[1] = 'cad.onshape.com'
        out = io.StringIO()
        with contextlib.redirect_stdout(out): self.poll(1, 'chrome.exe', 'Secret doc | Part Studio')
        self.assertIn('site rule onshape.com', out.getvalue())
        self.assertNotIn('cad.', out.getvalue()); self.assertNotIn('Secret', out.getvalue())


if __name__ == '__main__':
    unittest.main()


class MacAddressBarTests(unittest.TestCase):
    """macOS website rules through Apple Events, with osascript stubbed (no Mac here)."""

    def done(self, code=0, out='', err=''):
        return types.SimpleNamespace(returncode=code, stdout=out, stderr=err)

    def test_scripts_name_the_browser_by_bundle_id(self):
        self.assertEqual(address_bar.front_tab_script('com.apple.Safari'),
                         'tell application id "com.apple.Safari" to return URL of current tab of front window')
        self.assertIn('active tab of front window', address_bar.front_tab_script('com.google.Chrome'))
        self.assertIsNone(address_bar.front_tab_script('x" & do shell script "y'))
        for browser in ('com.apple.Safari', 'com.google.Chrome', 'com.microsoft.edgemac', 'com.brave.Browser',
                        'company.thebrowser.Browser'):
            self.assertIn(browser.lower(), address_bar.BROWSERS)

    def test_the_host_only_and_a_refusal_is_remembered(self):
        calls = []
        replies = [self.done(out='https://cad.onshape.com/documents/abc?x=1\n'),
                   self.done(1, err='execution error: Not authorized to send Apple events to Google Chrome. (-1743)')]
        bar = address_bar.MacAddressBar(run=lambda c: calls.append(c) or replies.pop(0))
        self.assertEqual(bar.host(42, 'com.apple.Safari'), 'cad.onshape.com')
        self.assertEqual(bar.host(43, 'com.google.Chrome'), None)
        self.assertEqual(bar.host(43, 'com.google.Chrome'), None)
        self.assertEqual(len(calls), 2, 'never asks again after a refusal')
        self.assertEqual(calls[0][:2], ['/usr/bin/osascript', '-e'])

    def test_other_failures_are_the_program_and_ask_again(self):
        bar = address_bar.MacAddressBar(run=lambda c: self.done(1, err='(-1728) no window'))
        self.assertIsNone(bar.host(1, 'com.apple.Safari'))
        self.assertNotIn('com.apple.safari', bar.denied)

        def slow(c): raise address_bar.subprocess.TimeoutExpired(c, 1.5)
        self.assertIsNone(address_bar.MacAddressBar(run=slow).host(1, 'com.apple.Safari'))

    def test_made_on_macos(self):
        self.assertIsInstance(address_bar.make_address_bar('darwin'), address_bar.MacAddressBar)
        self.assertIsInstance(address_bar.make_address_bar('linux'), NoAddressBar)
