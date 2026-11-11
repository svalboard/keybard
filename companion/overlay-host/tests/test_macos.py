"""macOS code paths, exercised with a mocked platform and Objective-C runtime."""
import ctypes
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from keybard_host import macos
from keybard_host.browser import find_chromium

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
try:
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QApplication, QWidget
    from keybard_host.__main__ import prepare_overlay_window
    QT = True
except ImportError:
    QT = False


class PlatformTests(unittest.TestCase):
    def test_only_darwin_is_mac(self):
        self.assertTrue(macos.is_mac('darwin'))
        for platform in ('win32', 'linux', 'cygwin'):
            self.assertFalse(macos.is_mac(platform))
        with patch('keybard_host.macos.sys.platform', 'darwin'):
            self.assertTrue(macos.is_mac())


class NativeCallTests(unittest.TestCase):
    def setUp(self):
        self.send = Mock(return_value=0x1000)
        self.runtime = SimpleNamespace(objc_getClass=Mock(return_value=0x2000))
        patch('keybard_host.macos._send', self.send).start()
        patch('keybard_host.macos._runtime', return_value=self.runtime).start()
        self.addCleanup(patch.stopall)

    def selectors(self):
        return [c.args[1] for c in self.send.call_args_list]

    def test_other_platforms_never_touch_the_objc_runtime(self):
        widget = Mock()
        for platform in ('win32', 'linux'):
            self.assertFalse(macos.hide_dock_icon(platform))
            self.assertFalse(macos.float_window(widget, platform))
        self.send.assert_not_called()
        widget.winId.assert_not_called()

    def test_hide_dock_icon_makes_an_accessory_app(self):
        self.assertTrue(macos.hide_dock_icon('darwin'))
        self.runtime.objc_getClass.assert_called_once_with(b'NSApplication')
        self.assertEqual(self.selectors(), ['sharedApplication', 'setActivationPolicy:'])
        self.assertEqual(self.send.call_args.args[3], (ctypes.c_long, macos.ACCESSORY))

    def test_float_window_joins_all_spaces_and_stays_shown(self):
        widget = Mock(); widget.winId.return_value = 0x3000
        self.assertTrue(macos.float_window(widget, 'darwin', 'cocoa'))
        self.assertEqual(self.send.call_args_list[0].args[:2], (0x3000, 'window'))
        self.assertEqual(self.selectors(), ['window', 'setCollectionBehavior:', 'setHidesOnDeactivate:'])
        behavior = self.send.call_args_list[1].args[3][1]
        self.assertEqual(behavior, (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8))
        self.assertEqual(self.send.call_args_list[2].args[3], (ctypes.c_bool, False))

    def test_only_a_cocoa_window_id_is_an_nsview(self):
        """Qt's offscreen platform hands out a placeholder winId(), not an NSView*."""
        widget = Mock(); widget.winId.return_value = 0x3000
        for qpa in ('offscreen', 'minimal', ''):
            self.assertFalse(macos.float_window(widget, 'darwin', qpa), qpa)
        self.send.assert_not_called()
        if QT:
            QApplication.instance() or QApplication([])
            self.assertFalse(macos.float_window(widget, 'darwin'))  # asks Qt for the platform
            self.send.assert_not_called()

    def test_failures_leave_qt_defaults(self):
        widget = Mock(); widget.winId.return_value = 0x3000
        self.send.side_effect = OSError('no libobjc')
        self.assertFalse(macos.hide_dock_icon('darwin'))
        self.assertFalse(macos.float_window(widget, 'darwin', 'cocoa'))
        self.send.side_effect = None; self.send.return_value = 0
        self.assertFalse(macos.float_window(widget, 'darwin', 'cocoa'))

    def test_missing_runtime_library_is_harmless(self):
        patch.stopall()
        with patch('keybard_host.macos._runtime_lib', None), patch('ctypes.cdll.LoadLibrary', side_effect=OSError):
            self.assertFalse(macos.hide_dock_icon('darwin'))
            self.assertFalse(macos.float_window(Mock(winId=Mock(return_value=1)), 'darwin', 'cocoa'))


class BrowserTests(unittest.TestCase):
    def test_mac_finds_chrome_or_edge_app_bundles(self):
        with tempfile.TemporaryDirectory() as home:
            edge = Path(home) / 'Applications' / 'Microsoft Edge.app' / 'Contents' / 'MacOS' / 'Microsoft Edge'
            with patch('keybard_host.browser.Path.home', return_value=Path(home)), \
                 patch('keybard_host.browser.Path.is_file', lambda p: p == edge or p == Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')):
                self.assertEqual(find_chromium('darwin'), Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
            with patch('keybard_host.browser.Path.home', return_value=Path(home)), \
                 patch('keybard_host.browser.Path.is_file', lambda p: p == edge):
                self.assertEqual(find_chromium('darwin'), edge)
            with patch('keybard_host.browser.Path.home', return_value=Path(home)), \
                 patch('keybard_host.browser.Path.is_file', return_value=False):
                self.assertIsNone(find_chromium('darwin'))

    @unittest.skipUnless(os.name == 'nt', 'Windows paths')
    def test_windows_lookup_is_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            chrome = Path(root) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe'
            chrome.parent.mkdir(parents=True); chrome.write_bytes(b'')
            env = {'PROGRAMFILES': root, 'PROGRAMFILES(X86)': '', 'LOCALAPPDATA': ''}
            with patch.dict('os.environ', env):
                self.assertEqual(find_chromium('win32'), chrome)


@unittest.skipUnless(QT, 'PySide6 not installed')
class OverlayWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_tool_windows_stay_shown_only_on_mac(self):
        for platform, expected in (('darwin', True), ('win32', False), ('linux', False)):
            widget = QWidget()
            prepare_overlay_window(widget, platform)
            self.assertEqual(widget.testAttribute(Qt.WA_MacAlwaysShowToolWindow), expected, platform)
            widget.deleteLater()


if __name__ == '__main__':
    unittest.main()
