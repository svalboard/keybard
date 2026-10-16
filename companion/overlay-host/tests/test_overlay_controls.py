"""Native window input boundaries and overlay control actions."""
import os
import unittest
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
try:
    from PySide6.QtCore import Qt, QPoint, QPointF
    from PySide6.QtGui import QMouseEvent
    from PySide6.QtWidgets import QApplication
    from keybard_host.__main__ import Surface, OverlayControls
    AVAILABLE = True
except ImportError:
    AVAILABLE = False

@unittest.skipUnless(AVAILABLE, 'Requires the native Qt WebEngine runtime')
class OverlayControlsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.surface = Surface(5178)
        self.calls = []
        self.controls = OverlayControls(self.surface, lambda: self.calls.append('open'))

    def tearDown(self):
        self.controls.close(); self.surface.close()
        self.controls.deleteLater(); self.surface.deleteLater()
        self.app.processEvents()

    def test_overlay_passes_every_click_through_and_handle_stays_interactive(self):
        self.surface.pass_clicks_through()
        self.assertTrue(self.surface.windowFlags() & Qt.WindowTransparentForInput)
        self.assertTrue(self.surface.mask().isEmpty())
        self.assertFalse(self.controls.windowFlags() & Qt.WindowTransparentForInput)
        self.assertFalse(self.controls.handle.testAttribute(Qt.WA_TransparentForMouseEvents))

    def test_control_menu_has_open_and_capital_letters(self):
        actions = [a for a in self.controls.more.menu().actions() if not a.isSeparator()]
        self.assertEqual([a.text() for a in actions], ['Open Keybard', 'Capital letters', 'Adaptive contrast', 'Place at bottom', 'Reload board layout'])
        from keybard_host import backdrop
        self.assertEqual(self.controls.adaptive.isVisible(), backdrop.supported())
        actions[0].trigger()
        self.assertEqual(self.calls, ['open'])

    def test_capital_letters_is_a_checkable_toggle(self):
        values = []
        controls = OverlayControls(self.surface, lambda: None, set_capitals=lambda v: values.append(v))
        try:
            self.assertTrue(controls.capitals.isCheckable())
            controls.capitals.trigger(); controls.capitals.trigger()
            self.assertEqual(values, [True, False])
        finally:
            controls.close(); controls.deleteLater()

    def test_collapse_leaves_only_the_controls_and_expand_restores(self):
        self.surface.show()
        button = self.controls.collapser
        self.assertEqual(button.accessibleName(), 'Collapse overlay')
        button.click()
        self.assertTrue(self.controls.collapsed)
        self.assertTrue(self.surface.isHidden())
        self.assertFalse(self.controls.resizer.isEnabled())
        self.assertEqual(button.accessibleName(), 'Expand overlay')
        button.click()
        self.assertFalse(self.controls.collapsed)
        self.assertFalse(self.surface.isHidden())
        # Window opacity puts the overlay on a slower Windows update path (stale frames).
        self.assertEqual(self.surface.windowOpacity(), 1)
        self.assertTrue(self.controls.resizer.isEnabled())

    def test_collapsed_overlay_still_moves_with_its_handle(self):
        # Collapsed, the grip drags the visible controls; the hidden overlay follows them, and
        # expanding shows it under the controls where they were dropped, with no jump.
        self.surface.show(); self.controls.show()
        self.surface.resize(400, 200); self.surface.move(200, 300); self.app.processEvents()
        self.controls.set_collapsed(True); self.app.processEvents()
        controls_before = self.controls.pos()
        handle = self.controls.handle
        handle.mousePressEvent(QMouseEvent(QMouseEvent.MouseButtonPress, QPointF(4,4), QPointF(200,200), Qt.LeftButton, Qt.LeftButton, Qt.NoModifier))
        handle.mouseMoveEvent(QMouseEvent(QMouseEvent.MouseMove, QPointF(24,14), QPointF(220,210), Qt.NoButton, Qt.LeftButton, Qt.NoModifier))
        self.app.processEvents()
        self.assertEqual(self.controls.pos(), controls_before + QPoint(20,10))
        self.controls.set_collapsed(False); self.app.processEvents()
        self.assertEqual(self.controls.pos(), controls_before + QPoint(20,10))
        self.assertEqual(self.surface.x() + self.surface.width(), self.controls.x() + self.controls.width())
        self.assertEqual(self.surface.y(), self.controls.y() + self.controls.height() + 4)

    def test_handle_drags_surface_even_in_click_through(self):
        self.surface.pass_clicks_through()
        self.surface.move(100, 100)
        before = self.surface.pos()
        handle = self.controls.handle
        handle.mousePressEvent(QMouseEvent(QMouseEvent.MouseButtonPress, QPointF(4,4), QPointF(200,200), Qt.LeftButton, Qt.LeftButton, Qt.NoModifier))
        handle.mouseMoveEvent(QMouseEvent(QMouseEvent.MouseMove, QPointF(24,14), QPointF(220,210), Qt.NoButton, Qt.LeftButton, Qt.NoModifier))
        self.assertEqual(self.surface.pos(), before + QPoint(20,10))
        handle.mouseReleaseEvent(QMouseEvent(QMouseEvent.MouseButtonRelease, QPointF(24,14), QPointF(220,210), Qt.LeftButton, Qt.NoButton, Qt.NoModifier))
        self.assertIsNone(handle.offset)

    def test_layer_changes_publish_immediately_without_an_http_poll(self):
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        from keybard_host.__main__ import Host
        state = {'layoutRevision': 1, 'active': 0}
        page = SimpleNamespace(runJavaScript=Mock())
        host = SimpleNamespace(state=SimpleNamespace(snapshot=lambda revision: dict(state)),
            surface=SimpleNamespace(page=lambda: page), published_layout=-1, published_state=None, last_publish=0)
        with patch('keybard_host.__main__.time.monotonic', return_value=10):
            Host.publish_state(host)
            Host.publish_state(host)
            self.assertEqual(page.runJavaScript.call_count, 1)
            state['active'] = 4
            Host.publish_state(host)
            self.assertEqual(page.runJavaScript.call_count, 2)
            self.assertIn('"active":4', page.runJavaScript.call_args.args[0])
        with patch('keybard_host.__main__.time.monotonic', return_value=10.3):
            Host.publish_state(host)
            self.assertIn('keybard-host-heartbeat', page.runJavaScript.call_args.args[0])

    def test_resize_handle_scales_from_the_drag_and_saves_on_release(self):
        calls = []
        self.controls.close()
        self.controls = OverlayControls(self.surface, lambda: None, lambda: 100, lambda scale, final: calls.append((scale, final)))
        self.surface.setFixedSize(1000, 300)
        handle = self.controls.resizer
        press = lambda kind, x, y, button, buttons: QMouseEvent(kind, QPointF(4,4), QPointF(x,y), button, buttons, Qt.NoModifier)
        handle.mousePressEvent(press(QMouseEvent.MouseButtonPress, 500, 500, Qt.LeftButton, Qt.LeftButton))
        # 200 px right on a 1000 px overlay: 20% bigger.
        handle.mouseMoveEvent(press(QMouseEvent.MouseMove, 700, 500, Qt.NoButton, Qt.LeftButton))
        # Up grows it too: 150 px on a 300 px overlay, capped at the largest size.
        handle.mouseMoveEvent(press(QMouseEvent.MouseMove, 500, 350, Qt.NoButton, Qt.LeftButton))
        # Down and left shrinks it, no smaller than the smallest size.
        handle.mouseMoveEvent(press(QMouseEvent.MouseMove, 0, 500, Qt.NoButton, Qt.LeftButton))
        handle.mouseReleaseEvent(press(QMouseEvent.MouseButtonRelease, 0, 500, Qt.LeftButton, Qt.NoButton))
        self.assertEqual(calls, [(120, False), (150, False), (50, False), (50, True)])
        self.assertIsNone(handle.start)
