"""Tray-only host; all overlay pixels and controls belong to Keybard's web build."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time

# Windows: Chromium's GPU path updated the transparent overlay window with partial frames,
# so keys could stay lit or patches go blank until the next change. Software rendering hands
# the window whole frames, and the overlay is small enough that it costs nothing noticeable.
# Must be set before Qt WebEngine starts.
# The last three give WebGL a context, so the overlay draws the pointing devices with the
# same renderer as Keybard; without them WebGL has none under --disable-gpu and only the flat
# stand-in ball is drawn. With them, Qt 6.11 on Windows still runs WebGL on the GPU (ANGLE,
# Direct3D 11), with SwiftShader as the fallback; only compositing stays in software. The
# renderer copies its pixels out with a readback there, since drawImage from WebGL into a
# software canvas took 50-110 ms a frame (see src/components/pointing-viz/webgl/renderer.ts).
# Full GPU compositing measured 60 fps too, but brought back keys left lit (2 in 100 rapid
# taps), so it stays off. The overlay shows only the Host's own Keybard build, which is what
# makes the "unsafe" flag acceptable.
WINDOWS_CHROMIUM_FLAGS = ('--disable-gpu', '--disable-gpu-compositing',
                          '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader')
if sys.platform == 'win32':
    _flags = os.environ.get('QTWEBENGINE_CHROMIUM_FLAGS', '').split()
    os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = ' '.join(_flags + [f for f in WINDOWS_CHROMIUM_FLAGS if f not in _flags])

from PySide6.QtCore import Qt, QTimer, QUrl, Signal, QObject, QStandardPaths, QLockFile, QSize, QPoint, QPointF
from PySide6.QtGui import QAction, QActionGroup, QColor, QIcon, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget, QToolButton, QHBoxLayout
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings, QWebEngineScript
from .device.protocol import candidates, hid_backend
from .device.worker import DeviceWorker
from .boards import Board, Follower, composite, device_keys, kinds, lent_sides, motion_used
from .state import BALL_NAMES, DEFAULT_BALL, DEFAULTS, EFFECTS, PRESETS, HostState, serialize_profile
from .host_pointing import demo_motion
from .colors import ColorsPanel
from .modifiers import ModifierReader, MODIFIER_NOTE
from .keyboard_layout import ForegroundHook, LayoutReader
from .foreground import app_key, foreground_window
from .address_bar import BROWSERS, TimedReader
from .site_rules import PENDING, SiteWatcher, choose_id
from .server import REMOTE_ORIGINS, load_paranoid_page, make_server, web_base_problem
from .build import build_info, build_label
from .handoff import hand_off, REFUSED
from .browser import open_contained
from .macos import float_window, hide_dock_icon, is_mac
from . import backdrop, ontop


class Bridge(QObject):
    command = Signal(object)


class LocalPage(QWebEnginePage):
    def acceptNavigationRequest(self, url, kind, main):
        return url.scheme() in ('http', 'about') and (url.scheme() == 'about' or (url.host() == '127.0.0.1' and url.port() == self.parent().host_port))


def prepare_overlay_window(widget, platform=None):
    # macOS hides tool windows while their app isn't the active one, and the Host never is.
    if is_mac(platform): widget.setAttribute(Qt.WA_MacAlwaysShowToolWindow)


def overlay_flags(platform=None):
    flags = Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus
    # Linux: ask for click-through before the first show. Adding it to a shown X11 window
    # unmaps and maps it again, and the window manager then drops its stay-on-top state.
    if (platform or sys.platform).startswith('linux'): flags |= Qt.WindowTransparentForInput
    return flags


class Surface(QWebEngineView):
    geometry_changed = Signal()

    def showEvent(self, event):
        super().showEvent(event)
        float_window(self)

    def moveEvent(self, event):
        super().moveEvent(event)
        self.geometry_changed.emit()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.geometry_changed.emit()

    def __init__(self, port):
        super().__init__()
        self.host_port = port
        self.setWindowTitle('Keybard · Overlay')
        self.setWindowFlags(overlay_flags())
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        prepare_overlay_window(self)
        self.setStyleSheet('background:transparent')
        page = LocalPage(self)
        self.setPage(page)
        page.setBackgroundColor(QColor(Qt.transparent))
        native = QWebEngineScript()
        native.setName('keybard-native-state')
        native.setInjectionPoint(QWebEngineScript.DocumentCreation)
        native.setWorldId(QWebEngineScript.MainWorld)
        native.setRunsOnSubFrames(False)
        native.setSourceCode('window.__keybardNativeState = true;')
        page.scripts().insert(native)
        page.settings().setAttribute(QWebEngineSettings.PlaybackRequiresUserGesture, True)
        self.resize(1050, 330)
        self.setUrl(QUrl(f'http://127.0.0.1:{port}/?hostOverlay=1'))

    def pass_clicks_through(self):
        """Every click on the overlay reaches the window underneath; only the handle moves it."""
        self.setAttribute(Qt.WA_TransparentForMouseEvents, False)
        for child in self.findChildren(QObject):
            if hasattr(child, 'setAttribute'): child.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        if not self.windowFlags() & Qt.WindowTransparentForInput:
            visible = self.isVisible()
            self.setWindowFlag(Qt.WindowTransparentForInput, True)
            if visible: self.show()


def overlay_control_icon(kind):
    # Draw at 2x resolution rather than relying on platform-specific font glyphs.
    pixmap = QPixmap(32, 32)
    pixmap.fill(Qt.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.scale(2, 2)
    painter.setPen(QPen(QColor('#eeeeee'), 1.3, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
    if kind == 'move':
        for x1, y1, x2, y2 in ((8,1,8,15), (1,8,15,8), (6.4,2.6,8,1), (8,1,9.6,2.6), (6.4,13.4,8,15), (8,15,9.6,13.4), (2.6,6.4,1,8), (1,8,2.6,9.6), (13.4,6.4,15,8), (15,8,13.4,9.6)):
            painter.drawLine(QPointF(x1, y1), QPointF(x2, y2))
    elif kind == 'resize':
        for x1, y1, x2, y2 in ((2,14,14,2), (9,2,14,2), (14,2,14,7), (2,9,2,14), (2,14,7,14)):
            painter.drawLine(QPointF(x1, y1), QPointF(x2, y2))
    elif kind == 'collapse':
        painter.drawLine(QPointF(3, 12), QPointF(13, 12))
    elif kind == 'expand':
        painter.drawRect(3, 3, 10, 10)
    else:
        painter.setPen(Qt.NoPen); painter.setBrush(QColor('#eeeeee'))
        for x in (3, 8, 13): painter.drawEllipse(QPointF(x, 8), 1.2, 1.2)
    painter.end()
    pixmap.setDevicePixelRatio(2)
    return QIcon(pixmap)


def taskbar_is_light():
    """Whether the taskbar/tray (Windows) or the app theme (elsewhere) is light."""
    if sys.platform == 'win32':
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize') as key:
                return bool(winreg.QueryValueEx(key, 'SystemUsesLightTheme')[0])
        except OSError:
            return False  # no setting: the taskbar is dark
    return QApplication.styleHints().colorScheme() != Qt.ColorScheme.Dark


def host_icon(light_background):
    """The Svalboard glyph in whichever color contrasts with the taskbar or tray."""
    name = 'svalboard.png' if light_background else 'svalboard-light.png'
    return QIcon(str(Path(__file__).parent / 'assets' / name))


class DragHandle(QToolButton):
    def __init__(self, surface, parent):
        super().__init__(parent)
        self.surface = surface
        self.offset = None
        self.setIcon(overlay_control_icon('move'))
        self.setIconSize(QSize(20, 20))
        self.setToolTip('Drag overlay')
        self.setAccessibleName('Drag overlay')
        self.setCursor(Qt.SizeAllCursor)

    def target(self):
        """The window the grip drags: the overlay, or while it's collapsed (hidden) the controls
        themselves, which carry the hidden overlay along. A hidden window moves without telling
        anyone, so dragging it left the controls behind until the overlay jumped on expand."""
        return self.window() if getattr(self.window(), 'collapsed', False) else self.surface

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            target = self.target()
            if target.windowHandle() and target.windowHandle().startSystemMove():
                self.offset = None
            else:
                self.offset = event.globalPosition().toPoint() - target.pos()
            event.accept()

    def mouseMoveEvent(self, event):
        if self.offset is not None and event.buttons() & Qt.LeftButton:
            self.target().move(event.globalPosition().toPoint() - self.offset)
            event.accept()

    def mouseReleaseEvent(self, event):
        self.offset = None
        event.accept()


class ResizeHandle(QToolButton):
    """Drag up and right to grow the overlay, down and left to shrink it; the bottom-left corner stays put."""
    def __init__(self, surface, parent, get_scale, set_scale):
        super().__init__(parent)
        self.surface, self.get_scale, self.set_scale = surface, get_scale, set_scale
        self.start = None
        self.setIcon(overlay_control_icon('resize'))
        self.setIconSize(QSize(16, 16))
        self.setToolTip('Drag to resize overlay')
        self.setAccessibleName('Resize overlay')
        self.setCursor(Qt.SizeBDiagCursor)

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.start = (event.globalPosition().toPoint(), self.get_scale(), self.surface.width(), self.surface.height())
            self.scale = self.start[1]
            event.accept()

    def scale_at(self, point):
        origin, scale, width, height = self.start
        delta = point - origin
        # Follow whichever direction the pointer moved further, relative to the overlay's size.
        grow = max((width + delta.x()) / width, (height - delta.y()) / height, key=lambda f: abs(f - 1))
        return max(SCALE_MIN, min(SCALE_MAX, round(scale * grow)))

    def mouseMoveEvent(self, event):
        if self.start is not None and event.buttons() & Qt.LeftButton:
            scale = self.scale_at(event.globalPosition().toPoint())
            if scale != self.scale: self.scale = scale; self.set_scale(scale, False)
            event.accept()

    def mouseReleaseEvent(self, event):
        if self.start is not None:
            self.start = None
            self.set_scale(self.scale, True)
        event.accept()


SCALE_MIN, SCALE_MAX = 50, 150


class OverlayControls(QWidget):
    """A separate input window: the handle moves the overlay while the keyboard passes clicks through."""
    def __init__(self, surface, open_controls, get_scale=lambda: 100, set_scale=lambda scale, final: None, set_capitals=lambda value: None, set_adaptive=lambda value: None, place=lambda: None, reload=lambda: None, add_settings=lambda menu: None):
        super().__init__(None, Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus)
        self.surface = surface
        self.setWindowTitle('Keybard · Overlay controls')
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        prepare_overlay_window(self)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setStyleSheet('QToolButton {color:#eee;background:#303436;border:1px solid #666;border-radius:2px;padding:0;} QToolButton:hover {background:#505456;} QToolButton::menu-indicator {image:none;width:0;height:0;}')
        layout = QHBoxLayout(self); layout.setContentsMargins(0, 0, 0, 0); layout.setSpacing(4)
        self.handle = DragHandle(surface, self)
        self.resizer = ResizeHandle(surface, self, get_scale, set_scale)
        self.collapser = QToolButton(self); self.collapser.setIconSize(QSize(16, 16))
        self.collapser.clicked.connect(lambda: self.set_collapsed(not self.collapsed))
        self.more = QToolButton(self); self.more.setIcon(overlay_control_icon('more')); self.more.setIconSize(QSize(16, 16)); self.more.setToolTip('Overlay controls'); self.more.setAccessibleName('Overlay controls')
        self.more.setPopupMode(QToolButton.InstantPopup)
        menu = QMenu(self.more)
        menu.addAction('Open Keybard', open_controls)
        menu.addSeparator()
        add_settings(menu)
        self.capitals = menu.addAction('Capital letters'); self.capitals.setCheckable(True)
        self.capitals.triggered.connect(set_capitals)
        self.adaptive = menu.addAction('Adaptive contrast'); self.adaptive.setCheckable(True)
        self.adaptive.setToolTip('Restyle each key for the background around it')
        self.adaptive.triggered.connect(set_adaptive)
        self.adaptive.setVisible(backdrop.supported())
        menu.addSeparator()
        # Also in the tray menu; here too for desktops without a tray.
        menu.addAction('Place at bottom', place)
        menu.addAction('Reload board layout', reload)
        self.more.setMenu(menu)
        for button in (self.handle, self.resizer, self.collapser, self.more):
            button.setFixedSize(24, 24); layout.addWidget(button)
        self.setFixedSize(108, 24)
        self.collapsed = False
        self.set_collapsed(False, apply=False)
        surface.geometry_changed.connect(self.reposition)
        self.reposition()

    def set_collapsed(self, value, apply=True):
        """Collapsed: only these controls show. The overlay's window is hidden; the move grip
        still moves it and the controls stay put above its corner.

        Never use window opacity here: on Windows it moves the transparent overlay onto a
        slower update path where the screen kept showing stale frames (a key stuck lit until
        the overlay was moved)."""
        self.collapsed = value
        if apply: self.surface.setVisible(not value)
        self.resizer.setEnabled(not value)
        label = 'Expand overlay' if value else 'Collapse overlay'
        self.collapser.setIcon(overlay_control_icon('expand' if value else 'collapse'))
        self.collapser.setToolTip(label); self.collapser.setAccessibleName(label)

    def showEvent(self, event):
        super().showEvent(event)
        float_window(self)

    def moveEvent(self, event):
        super().moveEvent(event)
        # Collapsed, the controls are what moves: keep the hidden overlay under them, where
        # reposition() would put the controls for it, so expanding shows it right there.
        if getattr(self, 'collapsed', False):
            self.surface.move(self.x() + self.width() - self.surface.width(), self.y() + self.height() + 4)

    def anchor(self):
        """Where the controls belong: above the overlay's top-right corner, kept on its screen."""
        screen = self.surface.screen() or QApplication.primaryScreen()
        if screen is None: return self.pos()  # displays mid-change: stay put until one is back
        area = screen.availableGeometry()
        return QPoint(max(area.left(), min(self.surface.x() + self.surface.width() - self.width(), area.right() - self.width() + 1)),
                      max(area.top(), min(self.surface.y() - self.height() - 4, area.bottom() - self.height() + 1)))

    def reposition(self):
        target = self.anchor()
        if self.pos() != target: self.move(target)

    def keep_anchored(self):
        """Put the controls back over the overlay if something else moved them. Windows moves
        each window on its own when displays change (a monitor waking or reconnecting), so the
        small controls window could land elsewhere while the overlay stayed put, and only a move
        of the overlay (Place at bottom) brought them back. Collapsed, the controls lead instead."""
        if self.collapsed or self.pos() == self.anchor(): return False
        self.reposition()
        return True


class Host(QObject):
    # Site rules: the address bar was read (on its own thread); decide the app again at once.
    site_read = Signal()

    def __init__(self, app, assets, state, port, remote_origins=(), paranoid=False, page=None, log_app_rules=False, only_boards=None):
        super().__init__()
        # Testing: the serial numbers of the only boards to use (--only-board); None: every board.
        self.only_boards = frozenset(only_boards) if only_boards else None
        self.app, self.state = app, state
        self.auto_connect = True
        self.devices = {}
        # Every connected Svalboard, by id, each with its own reader (see boards.py).
        self.boards = {}
        self.board_order = 0
        self.retiring = []      # readers told to stop, kept until their thread ends
        self.paused = None      # Disconnect: the ids present then; None while connecting
        self.follower = Follower((state.remembered or {}).get('serial'), state.pinned)
        self.shown_signature = None
        self.demo = False
        self.demo_at = 0.0
        self.bridge = Bridge()
        # Pointing: motion waiting to go to the overlay.
        self.pointing_pending = None
        self.pointing_source = None
        self.pointing_sides = {}
        self.pointing_sent = 0.0
        self.demo_pointing = None
        self.bridge.command.connect(self.command)
        # Paranoid mode trusts no website, only the Keybard this host serves itself.
        self.paranoid = paranoid
        self.keybard_url = KEYBARD_URL
        self.server = make_server(state, assets, self.bridge.command.emit, port, set() if paranoid else REMOTE_ORIGINS | set(remote_origins), paranoid, page)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/'
        self.surface = Surface(self.server.server_port)
        self.published_layout = -1
        self.published_state = None
        self.last_publish = 0
        self.surface.loadFinished.connect(self.renderer_loaded)
        self.surface.show()
        self.surface.pass_clicks_through()
        self.place()
        self.build_settings_menus()
        self.controls = OverlayControls(self.surface, self.open_controls,
            lambda: self.state.config['scale'], self.resize_overlay, self.set_capitals, self.set_adaptive,
            self.place, lambda: self.command(dict(op='reload')), self.add_settings)
        self.controls.capitals.setChecked(self.state.config['capitalAlphas'])
        self.controls.adaptive.setChecked(self.state.config['adaptiveContrast'])
        # Expanding shows the overlay's adapted colors at once rather than at the next sample.
        self.controls.collapser.clicked.connect(lambda: QTimer.singleShot(0, self.sample_backdrop))
        # Adaptive contrast samples the screen under the overlay this often (ms).
        self.sampling = False
        self.backdrop_timer = QTimer(self); self.backdrop_timer.timeout.connect(self.sample_backdrop); self.backdrop_timer.start(500)
        # Windows can stack the overlay under ordinary windows despite its always-on-top style; check and fix.
        self.ontop_timer = QTimer(self); self.ontop_timer.timeout.connect(self.keep_overlay); self.ontop_timer.start(1000)
        self.controls.show()
        self.icon_light_background = taskbar_is_light()
        icon = host_icon(self.icon_light_background)
        app.setWindowIcon(icon); self.surface.setWindowIcon(icon)
        self.tray = QSystemTrayIcon(icon, self)
        # Follow light/dark changes. Windows sends no Qt signal for the taskbar's own setting, so check it.
        app.styleHints().colorSchemeChanged.connect(lambda _scheme: self.update_icon())
        self.icon_timer = QTimer(self); self.icon_timer.timeout.connect(self.update_icon); self.icon_timer.start(3000)
        menu = QMenu()
        self.build_action = menu.addAction(build_label(build_info())); self.build_action.setEnabled(False)
        self.status_action = menu.addAction('Keybard Overlay · waiting for board'); self.status_action.setEnabled(False)
        self.firmware_action = menu.addAction(MODIFIER_NOTE); self.firmware_action.setEnabled(False); self.firmware_action.setVisible(False)
        menu.addSeparator(); menu.addAction('Open Keybard', self.open_controls)
        self.show_action = QAction('Show overlay', menu, checkable=True, checked=True)
        self.show_action.triggered.connect(lambda value: self.command(dict(op='show', value=value)))
        menu.addAction(self.show_action)
        menu.addSeparator()
        self.add_settings(menu)
        menu.addAction(self.controls.capitals); menu.addAction(self.controls.adaptive)
        menu.addSeparator()
        menu.addAction('Place at bottom', self.place)
        menu.addSeparator(); menu.addAction('Reload board layout', lambda: self.command(dict(op='reload')))
        menu.addAction('Quit Keybard Overlay', app.quit)
        self.tray.setContextMenu(menu); info = build_info(); self.tray.setToolTip(build_label(info))
        self.tray.activated.connect(lambda reason: self.open_controls() if reason == QSystemTrayIcon.DoubleClick else None)
        self.tray.show()
        # Firmware that reports Shift and Caps Lock (GET_INFO second feature byte,
        # bit 2) is used alone; older firmware falls back to the computer's state.
        self.modifier_reader = ModifierReader()
        self.modifier_timer = QTimer(self); self.modifier_timer.timeout.connect(self.read_modifiers); self.modifier_timer.start(16)
        # Key legends: Automatic. The window in front's keyboard layout: read when another window comes to
        # the front (Windows), and 4 times a second while the overlay is on screen, a visible Keybard tab
        # waits on /api/host/layout, or a page read the state in the last second (a layout switch inside one
        # app sends no event to other apps). Nothing while no one looks.
        self.layout_reader = LayoutReader()
        self.layout_hook = ForegroundHook(lambda: self.read_layout())
        self.layout_timer = QTimer(self); self.layout_timer.timeout.connect(self.read_layout); self.layout_timer.start(250)
        self.read_layout(force=True)
        # App rules: which app is in front, for boards that run rules (each worker sends it).
        # Read 4 times a second and when another window comes to the front (Windows), only
        # while a connected board takes it.
        self.foreground_id = None
        # Site rules: a browser's address bar is read only while a connected board has a site
        # rule, off this thread; the host name is matched and dropped (site_rules.py).
        self.log_app_rules, self.logged_app = log_app_rules, None
        # macOS asks the browser through Apple Events: slower, and no tab title to notice a tab change.
        timing = dict(timeout=0.6, reread=1.0) if sys.platform == 'darwin' else {}
        self.site_watcher = SiteWatcher(lambda done: TimedReader(done=done), notify=self.site_read.emit, **timing)
        self.site_read.connect(self.poll_foreground)
        self.foreground_hook = ForegroundHook(lambda: self.poll_foreground())
        self.foreground_timer = QTimer(self); self.foreground_timer.timeout.connect(self.poll_foreground); self.foreground_timer.start(250)
        self.timer = QTimer(self); self.timer.timeout.connect(self.tick); self.timer.start(100)
        self.scan_timer = QTimer(self); self.scan_timer.timeout.connect(self.scan); self.scan_timer.start(2500)
        QTimer.singleShot(0, self.scan)
        self.surface.windowHandle().screenChanged.connect(lambda screen: QTimer.singleShot(0, self.size_surface))
        app.aboutToQuit.connect(self.shutdown)

    def keep_overlay(self):
        """Once a second: the controls over the overlay, and both above ordinary windows."""
        ontop.keep_on_top((self.surface, self.controls))
        self.controls.keep_anchored()

    def shown_board(self):
        return self.boards.get(self.follower.shown)

    def read_modifiers(self):
        shown = self.shown_board()
        if shown is None or not shown.ready or shown.modifiers is not None: return
        value = self.modifier_reader.read()
        with self.state.lock:
            if value == self.state.modifiers: return
            self.state.modifiers = value
        self.publish_state()

    def read_layout(self, force=False):
        if not force and not (self.surface_shown() or self.state.layout_waiters or time.monotonic() - self.state.read_at < 1): return
        value = self.layout_reader.read()
        if value is None or not self.state.set_os_layout(value): return
        if not force: self.publish_state()

    def renderer_loaded(self, ok):
        self.published_layout = -1
        self.published_state = None
        if ok: self.publish_state()

    def publish_state(self):
        # Native delivery avoids browser timer throttling and a second polling cycle.
        snapshot = self.state.snapshot(self.published_layout)
        encoded = json.dumps(snapshot, separators=(',', ':'))
        if encoded == self.published_state:
            if time.monotonic() - self.last_publish < .25: return
            script = "window.dispatchEvent(new Event('keybard-host-heartbeat'))"
        else:
            self.published_state = encoded
            self.published_layout = snapshot['layoutRevision']
            script = "window.dispatchEvent(new CustomEvent('keybard-host-state',{detail:" + encoded + "}))"
        self.last_publish = time.monotonic()
        self.surface.page().runJavaScript(script)

    def update_icon(self):
        light = taskbar_is_light()
        if light == self.icon_light_background: return
        self.icon_light_background = light
        icon = host_icon(light)
        self.app.setWindowIcon(icon); self.surface.setWindowIcon(icon); self.tray.setIcon(icon)

    def open_controls(self):
        if self.paranoid: return open_paranoid(self.url)
        from PySide6.QtGui import QDesktopServices
        QDesktopServices.openUrl(QUrl(controls_url(False, self.url, self.keybard_url)))

    def resize_overlay(self, scale, final):
        """The resize handle: follow the pointer live, then save the size as the overlay preference."""
        self.size_surface(scale)
        if not final: return
        with self.state.lock:
            if self.state.config['scale'] == scale: return
            config = dict(self.state.config, scale=scale)
            try: self.state.configure(config, self.state.revision)
            except (OSError, RuntimeError, ValueError): return self.size_surface()
        self.publish_state()

    def set_config(self, **fields):
        """A menu choice, saved with the Host's settings; held-key tracking and the size follow."""
        with self.state.lock:
            changed = {k: v for k, v in fields.items() if self.state.config.get(k) != v}
            if changed:
                try: self.state.configure(dict(self.state.config, **changed), self.state.revision)
                except (OSError, RuntimeError, ValueError): changed = {}
        if changed: self.command(dict(op='configure'))
        self.sync_menu()
        self.publish_state()

    def set_flag(self, name, value): self.set_config(**{name: value})

    def build_settings_menus(self):
        """The overlay's settings, shared by its ⋯ menu and the tray menu."""
        self.board_menu = QMenu('Board')
        self.board_menu.aboutToShow.connect(self.fill_board_menu)

        def choices(title, names, apply):
            menu = QMenu(title); group = QActionGroup(menu); actions = {}
            for name in names:
                action = menu.addAction(name); action.setCheckable(True); group.addAction(action)
                action.triggered.connect(lambda _checked=False, n=name: apply(n))
                actions[name] = action
            return menu, actions
        # A style sets the colors; the outline shadow (halo) is its own toggle and survives a style change.
        self.style_menu, self.style_actions = choices('Style', PRESETS,
            lambda n: self.set_config(appearance=dict(PRESETS[n], halo=self.state.config['appearance']['halo'])))
        self.halo_action = QAction('Outline shadow', self, checkable=True)
        self.halo_action.setToolTip('A contrasting shadow around legends and key outlines, readable on any background')
        self.halo_action.triggered.connect(lambda value: self.set_config(appearance=dict(self.state.config['appearance'], halo=value)))
        self.colors_action = QAction('Colors…', self)
        self.colors_action.triggered.connect(self.open_colors)
        self.colors_panel = None
        self.highlight_menu, self.highlight_actions = choices('Layer highlight', EFFECTS, lambda n: self.set_config(**EFFECTS[n]))
        self.hands_menu, self.hands_actions = choices('Hands', ('Both', 'Left', 'Right'), lambda n: self.set_config(hands=n))
        self.held_action = QAction('Highlight held keys', self, checkable=True)
        self.held_action.triggered.connect(lambda value: self.set_config(highlightPressed=value))
        # Pointing devices: drawn in the overlay (off), sniper and boost pills (on).
        self.pointing_menu = QMenu('Pointing devices')
        self.pointing_show_action = self.pointing_menu.addAction('Show pointing devices'); self.pointing_show_action.setCheckable(True)
        self.pointing_show_action.setToolTip('Draw trackballs and touchpads in the overlay')
        self.pointing_show_action.triggered.connect(lambda value: self.set_config(showPointing=value))
        self.pointing_pills_action = self.pointing_menu.addAction('Show sniper and boost'); self.pointing_pills_action.setCheckable(True)
        self.pointing_pills_action.setToolTip('The sniper and boost pills, even with the devices hidden')
        self.pointing_pills_action.triggered.connect(lambda value: self.set_config(pointingPills=value))
        # Which ball each trackball of the board on show has: Keybard's balls, kept per board.
        self.pointing_menu.addSeparator()
        self.ball_menus = {}
        for side, title in (('left', 'Left trackball'), ('right', 'Right trackball')):
            menu = self.pointing_menu.addMenu(title); group = QActionGroup(menu); actions = {}
            for ball, name in BALL_NAMES.items():
                action = menu.addAction(name); action.setCheckable(True); group.addAction(action)
                action.triggered.connect(lambda _checked=False, s=side, b=ball: self.set_ball(s, b))
                actions[ball] = action
            self.ball_menus[side] = (menu, actions)
        self.pointing_menu.aboutToShow.connect(self.sync_balls)
        self.sync_balls()

    def sync_balls(self):
        """Show a ball choice for each hand of the board on show that has a trackball, checked at its ball."""
        with self.state.lock:
            board = self.state.board
            look = self.state.pointing_look()
        pointing = (board or {}).get('pointing') or {}
        for side, (menu, actions) in self.ball_menus.items():
            menu.menuAction().setVisible(pointing.get(side) == 'trackball')
            for ball, action in actions.items(): action.setChecked(ball == look.get(side, DEFAULT_BALL))

    def set_ball(self, side, ball):
        """A ball chosen in the Overlay: kept for the board on show until it or Keybard chooses again."""
        serial = self.state.shown_serial
        if not serial: return
        self.state.set_board_ball(serial, side, ball)
        self.sync_balls()
        self.publish_state()

    def add_settings(self, menu):
        menu.addMenu(self.board_menu)
        menu.addSeparator()
        for item in (self.style_menu, self.halo_action, self.colors_action, self.highlight_menu, self.held_action, self.hands_menu, self.pointing_menu):
            menu.addAction(item) if isinstance(item, QAction) else menu.addMenu(item)

    def open_colors(self):
        """The color setup panel, beside the overlay's controls."""
        if self.colors_panel is None:
            self.colors_panel = ColorsPanel(lambda: dict(self.state.config['appearance']),
                                            lambda appearance: self.set_config(appearance=appearance), DEFAULTS['appearance'])
        self.colors_panel.refresh()
        self.colors_panel.adjustSize()
        corner = self.controls.geometry()
        area = (self.controls.screen() or self.app.primaryScreen()).availableGeometry()
        x = min(max(area.left(), corner.right() - self.colors_panel.width()), area.right() - self.colors_panel.width())
        y = corner.top() - self.colors_panel.height() - 8
        if y < area.top(): y = corner.bottom() + 8
        self.colors_panel.move(x, y)
        self.colors_panel.show(); self.colors_panel.raise_(); self.colors_panel.activateWindow()

    def fill_board_menu(self):
        """Automatic (follow the board in use), or one board only; read when the menu opens so new boards show up."""
        self.board_menu.clear()
        group = QActionGroup(self.board_menu)
        automatic = self.board_menu.addAction('Follow the board in use'); automatic.setCheckable(True); group.addAction(automatic)
        automatic.setToolTip('Show whichever Svalboard you type on or point with')
        automatic.setChecked(self.state.pinned is None)
        automatic.triggered.connect(lambda _checked=False: self.command(dict(op='connect', id='auto')))
        self.board_menu.addSeparator()
        devices = list(self.state.devices)
        names = [d['name'] for d in devices]
        for d in devices:
            label = d['name'] if names.count(d['name']) == 1 else f"{d['name']} ({d['serial'][-4:]})"
            if self.state.pinned is None and d['id'] == self.state.selected_device: label += ' · showing'
            action = self.board_menu.addAction(label); action.setCheckable(True); group.addAction(action)
            action.setToolTip('Show this board only')
            action.setChecked(self.state.pinned is not None and self.state.pinned in (d['serial'], d['id']))
            action.triggered.connect(lambda _checked=False, key=d['id']: self.command(dict(op='connect', id=key)))
        if not devices:
            self.board_menu.addAction('No Svalboard found').setEnabled(False)
        self.board_menu.addSeparator()
        disconnect = self.board_menu.addAction('Disconnect', lambda: self.command(dict(op='disconnect')))
        disconnect.setEnabled(bool(self.boards))

    def set_capitals(self, value): self.set_flag('capitalAlphas', value)

    def set_adaptive(self, value):
        self.set_flag('adaptiveContrast', value)
        self.sample_backdrop()

    def sync_menu(self):
        """Keep the menus' check marks in step with the settings, however they changed."""
        self.controls.capitals.setChecked(self.state.config['capitalAlphas'])
        self.controls.adaptive.setChecked(self.state.config['adaptiveContrast'])
        config = self.state.config
        colors = {k: v for k, v in config['appearance'].items() if k != 'halo'}
        for name, action in self.style_actions.items(): action.setChecked(colors == {k: v for k, v in PRESETS[name].items() if k != 'halo'})
        self.halo_action.setChecked(config['appearance']['halo'])
        if getattr(self, 'colors_panel', None) is not None and self.colors_panel.isVisible(): self.colors_panel.refresh()
        for name, action in self.highlight_actions.items(): action.setChecked(config['effect'] == EFFECTS[name]['effect'])
        for name, action in self.hands_actions.items(): action.setChecked(config['hands'] == name)
        self.held_action.setChecked(config['highlightPressed'])
        for name, key in (('pointing_show_action', 'showPointing'), ('pointing_pills_action', 'pointingPills')):
            action = getattr(self, name, None)
            if action is not None: action.setChecked(config[key])

    def sample_backdrop(self):
        """Adaptive contrast: send the overlay what's on screen under it; tell it to stop when off."""
        active = (backdrop.supported() and self.state.config['adaptiveContrast'] and self.state.visible and not self.controls.collapsed
                  and self.state.valid and self.state.board is not None)
        if active != self.sampling:
            self.sampling = active
            if not active: self.surface.page().runJavaScript("window.dispatchEvent(new CustomEvent('keybard-host-backdrop',{detail:null}))")
        if not active: return
        grid = backdrop.sample(self.surface, exclude=[self.controls.geometry()])
        if grid: self.surface.page().runJavaScript("window.dispatchEvent(new CustomEvent('keybard-host-backdrop',{detail:" + json.dumps(grid) + "}))")

    def size_surface(self, scale=None):
        """Size the overlay for the scale, hands and layout, keeping its bottom edge put and on screen."""
        screen = self.surface.screen() or self.app.primaryScreen()
        area = screen.availableGeometry()
        bottom = self.surface.geometry().bottom()
        width = min(int(1050 * (scale or self.state.config['scale']) / 100), area.width() - 32)
        board = self.state.board
        layout = list(board['keylayout'].values()) if board else []
        hands = self.state.config['hands']
        if hands != 'Both': layout = [k for k in layout if (k['row'] < 5) == (hands == 'Left')]
        if layout:
            ratio = (max(k['y'] + k['h'] for k in layout) - min(k['y'] for k in layout) + .2) / (max(k['x'] + k['w'] for k in layout) - min(k['x'] for k in layout) + .2)
        else: ratio = .3
        height = int(width * ratio)
        if height > area.height() - 40:
            height = area.height() - 40; width = int(height / ratio)
        self.surface.setFixedSize(max(100, width), max(80, height))
        self.surface.move(self.surface.x(), max(area.top(), min(bottom, area.bottom()) - self.surface.height() + 1))

    def place(self):
        self.size_surface()
        area = (self.surface.screen() or self.app.primaryScreen()).availableGeometry()
        self.surface.move(area.x() + (area.width() - self.surface.width()) // 2, area.bottom() - self.surface.height() - 25)

    # The reader class for each board; tests swap in a fake.
    Worker = DeviceWorker

    def scan(self):
        """Find every Svalboard: start a reader for each new one, let go of the ones unplugged."""
        try:
            hid = hid_backend()
            found = candidates(hid)
            only = getattr(self, 'only_boards', None)
            if only is not None: found = [d for d in found if d.get('serial_number') in only]
            self.devices = device_keys(found)
        except (OSError, ValueError) as e:
            with self.state.lock: self.state.status = f'Could not enumerate boards: {e}'
            return
        for key in [k for k in self.boards if k not in self.devices]:
            self.retire(self.boards.pop(key).worker)
        if self.paused is not None:
            # Paused by Disconnect until a board arrives: a new one, or one back after a firmware update.
            self.paused &= set(self.devices)
            if any(key not in self.paused for key in self.devices): self.paused = None
        if self.paused is None and self.auto_connect:
            for key, device in self.devices.items():
                board = self.boards.get(key)
                if board is None:
                    self.board_order += 1
                    board = self.boards[key] = Board(key, device, order=self.board_order)
                board.device = device
                # A board without a serial can't be found again after a drop: its reader ends; start another.
                if board.worker is None or board.worker.isFinished(): self.start(board)
        with self.state.lock:
            self.state.devices = [dict(id=key, name=d.get('product_string') or 'Svalboard', serial=d.get('serial_number') or '') for key, d in self.devices.items()]
        self.follow()

    def start(self, board):
        if board.worker is not None: self.retire(board.worker)
        board.worker = worker = self.Worker(board.device)
        board.ready = board.valid = board.loading = False
        board.poll_plan = None
        self.track_polling(board)
        worker.profile.connect(self.profile)
        worker.state.connect(self.layers)
        worker.pressed.connect(self.pressed)
        worker.status.connect(self.status)
        worker.pointing.connect(self.pointing_motion)
        self.track_pointing(board)
        worker.start()

    def retire(self, worker):
        """Stop a reader without waiting; reaped once its thread ends."""
        if worker is None: return
        worker.stop()
        self.retiring.append(worker)

    def reap(self):
        for worker in [w for w in self.retiring if w.isFinished()]:
            self.retiring.remove(worker); worker.deleteLater()

    def board_of(self, worker):
        return next((b for b in self.boards.values() if b.worker is worker and worker is not None), None)

    def connect(self, key):
        """Show this board only ('auto': follow the board in use), and end a pause."""
        if key == 'auto': pinned = None
        elif key in self.devices: pinned = self.devices[key].get('serial_number') or key
        else: return
        self.state.pinned = self.follower.pinned = pinned
        try: self.state.save()
        except OSError: pass
        if self.paused is not None:
            self.paused = None
            self.scan()
        self.follow()

    def disconnect(self):
        """Let go of every board (Keybard asks this before a firmware update), until a board
        arrives or one is chosen in the Board menu. Waits briefly for the readers to close."""
        workers = [b.worker for b in self.boards.values() if b.worker is not None]
        for worker in workers: worker.stop()
        deadline = time.monotonic() + 1.6
        stopped = all([worker.wait(max(0, int((deadline - time.monotonic()) * 1000))) for worker in workers])
        for worker in workers: self.retire(worker)
        self.boards.clear()
        self.paused = set(self.devices)
        with self.state.lock: self.state.session = secrets.token_hex(12)
        self.follow()
        return stopped

    def follow(self, now=None):
        """Pick the board on show (boards.py) and put its state where the overlay reads it."""
        if self.demo: return
        now = time.monotonic() if now is None else now
        shown_key, lender_key = self.follower.choose(self.boards, now)
        shown, lender = self.boards.get(shown_key), self.boards.get(lender_key)
        signature = (shown.key, shown.revision, lender.key if lender else None, lender.revision if lender else 0) if shown else None
        changed = signature != self.shown_signature
        with self.state.lock:
            state = self.state
            if changed:
                self.shown_signature = signature
                state.board = composite(shown, lender)
                state.layout_revision += 1
            state.selected_device = shown.key if shown else None
            state.shown_serial = (shown.serial or shown.key) if shown else None
            state.pointing_device = lender.key if lender else None
            pinned = self.follower.pinned_board(self.boards) if state.pinned is not None else None
            state.follow = 'auto' if state.pinned is None else (pinned.key if pinned else state.pinned)
            state.paused = self.paused is not None
            state.boards = [b.summary() for b in sorted(self.boards.values(), key=lambda b: b.order)]
            if shown is not None:
                state.active, state.default, state.valid = shown.active, shown.default, shown.valid
                state.matrix_available = shown.matrix_available
                state.pressed = list(shown.pressed) if state.config['highlightPressed'] else []
                if shown.modifiers is not None: state.modifiers = shown.modifiers
                state.modifiers_reported = shown.modifiers_reported
                state.status = shown.status if len(self.boards) < 2 else f'{shown.name} · {shown.status}'
            else:
                state.active, state.default, state.valid, state.pressed, state.matrix_available = 0, None, False, [], None
                state.modifiers_reported = None
                state.status = ('Disconnected by user' if self.paused is not None
                    else 'Waiting for the chosen board' if state.pinned is not None
                    else next((b.status for b in self.boards.values()), 'Waiting for a Svalboard'))
            # Remembered when chosen by use, not when it stands in for a board unplugged.
            if changed and shown is not None and shown.used and shown.keyed and shown.serial and shown.board.get('uid'):
                remembered = dict(serial=shown.serial, uid=shown.board['uid'])
                if remembered != state.remembered:
                    state.remembered = remembered; self.follower.preferred = shown.serial
                    try: state.save()
                    except OSError: pass
        if changed:
            self.pointing_pending = None; self.pointing_sides = {}
            for board in self.boards.values(): self.track_pointing(board); self.track_polling(board)
            self.size_surface()
            self.publish_state()

    def profile(self, profile):
        board = self.board_of(self.sender())
        if board is None: return
        board.board = serialize_profile(profile)
        board.board['name'] = board.device.get('product_string') or profile.name
        board.ready, board.loading = True, False
        board.revision += 1
        self.track_pointing(board)
        self.follow()
        self.publish_state()

    def layers(self, snapshot):
        board = self.board_of(self.sender())
        if board is None or not board.ready or board.loading: return
        board.last_state = time.monotonic()
        board.active, board.default = snapshot.active, snapshot.default
        # Shift and Caps Lock come from this board alone when it reports them.
        board.modifiers = snapshot.modifiers
        board.modifiers_reported = snapshot.modifiers is not None
        mask = snapshot.active | (snapshot.default if snapshot.default is not None else self.state.config['manualDefault'])
        board.valid = not (mask >> len(board.board['keymap']))
        if not board.valid: board.status = 'Board refers to an unknown layer; reload the layout'
        if board.key == self.follower.shown:
            self.follow()
            self.publish_state()

    def pressed(self, snapshot):
        board = self.board_of(self.sender())
        if board is None: return
        generation, positions, sampled_at = snapshot
        if generation != board.generation: return
        board.matrix_available = positions is not None
        board.pressed = [row * 6 + col for row, col in positions] if positions is not None and board.valid and time.monotonic() - sampled_at <= .5 else []
        board.last_press = sampled_at
        if positions and board.ready: board.used = sampled_at
        shown = self.follower.shown
        self.follow()
        if board.key in (shown, self.follower.shown): self.publish_state()

    def status(self, status):
        board = self.board_of(self.sender())
        if board is None: return
        board.status = status
        if not status.startswith('Connected'):
            board.valid = False; board.pressed = []
            if status.startswith(('Connecting', 'Disconnected', 'Stopped')):
                board.ready = False; board.default = None
                self.follow()

    def poll_foreground(self):
        # A board with App Layers off applies no rule: nothing is read or sent for it.
        workers = [b.worker for b in self.boards.values()
                   if b.worker is not None and b.worker.app_rules and getattr(b.worker, 'app_layers_on', True)]
        if not workers:
            self.foreground_id = None
            return
        window, front, title = foreground_window()
        program = front[0] if front else None
        # Site rules: the host name in the browser in front, only if some board has a site rule.
        sites = [site for worker in workers for site in worker.sites]
        host = self.site_watcher.host_for(window, program, title) if sites and program else None
        if host is PENDING: return  # reading the address bar: the board keeps the app it has, for at most 150 ms
        for worker in workers:
            chosen = choose_id(program, host, worker.sites)
            worker.set_foreground(chosen)
        self.foreground_id = chosen
        if self.log_app_rules:
            # Testing: which rule is sent, never the address or the title.
            site = next((s for s, i in sites if i == chosen), None) if host else None
            line = f'site rule {site}' if site else f'program {program or "none"}'
            if sites and not site and window and app_key(program) in BROWSERS:
                line += ', the tab matches no site rule' if host else ', no address read'
            known = sorted({s for s, _ in sites})
            if (line, chosen, known) != self.logged_app:
                self.logged_app = (line, chosen, known)
                print(f'{time.strftime("%H:%M:%S")} app rules: sending {chosen:08X} ({line}); '
                      f'site rules on the board: {", ".join(known) or "none"}', flush=True)

    def tick(self):
        now = time.monotonic()
        for board in self.boards.values():
            if now - board.last_state > .6: board.valid = False; board.pressed = []
            if now - board.last_press > .5: board.pressed = []
        with self.state.lock:
            if self.demo and now - self.demo_at > .6: self.state.valid = False
            if now - self.state.practice_at > 2.5:
                self.state.practice_hidden = []; self.state.practice_target = None
        self.reap()
        self.follow(now)
        # What is on show changes outside follow() too: shown, collapsed, a page polling.
        for board in self.boards.values(): self.track_pointing(board); self.track_polling(board)
        self.status_action.setText(self.state.status[:65])
        self.firmware_action.setVisible(self.state.modifiers_reported is False)
        self.sync_menu()
        self.publish_state()

    def command(self, value):
        op = value['op']
        if op == 'configure':
            for board in self.boards.values():
                board.pressed = []; self.track_pointing(board); self.track_polling(board)
            with self.state.lock: self.state.pressed = []
            self.size_surface()
        elif op == 'show':
            if value['value']: self.controls.set_collapsed(False)
            self.state.visible = value['value']; self.surface.setVisible(value['value']); self.show_action.setChecked(value['value']); self.controls.setVisible(value['value'])
            for board in self.boards.values(): self.track_pointing(board); self.track_polling(board)
        elif op == 'place': self.place()
        elif op == 'quit': QTimer.singleShot(300, self.app.quit)
        elif op == 'practice':
            with self.state.lock:
                self.state.practice_hidden = value['hidden']; self.state.practice_target = value['target']; self.state.practice_at = time.monotonic()
        elif op == 'scan': self.scan()
        elif op == 'connect': self.auto_connect = True; self.connect(value['id'])
        elif op == 'disconnect':
            self.disconnect()
        elif op in ('reload', 'refresh'):
            # Keybard doesn't say which board it changed: every board reads its layout again.
            for board in self.boards.values():
                if board.worker is None: continue
                if op == 'refresh' and board.ready:
                    # The current layout stays on show until the new one arrives.
                    board.worker.refresh()
                else:
                    board.valid, board.loading = False, True
                    board.worker.reload()
            self.follow()
        self.publish_state()

    def track_pointing(self, board):
        """Read a board's pointing motion: often while the overlay draws it (the shown board, and
        keyless boards whose devices it may borrow), now and then otherwise, to see it's in use."""
        if board.worker is None: return
        config = self.state.config
        has_module = board.board is None or bool(kinds(board.board))
        drawn = (config['showPointing'] or config['pointingPills']) and self.surface_shown()
        candidate = board.key in (self.follower.shown, self.follower.lender) or (board.board is not None and not board.keyed)
        # Watching motion only tells which board is in use: needed only while following one of several.
        board.worker.set_pointing_tracking(has_module and drawn and candidate, watch=has_module and self.following())

    def surface_shown(self):
        """Whether the overlay is on screen: shown, and not collapsed to its controls."""
        controls = getattr(self, 'controls', None)
        return self.state.visible and not (controls is not None and controls.collapsed)

    def following(self):
        """Whether the board in use picks the board on show: several boards, none pinned."""
        return self.state.pinned is None and len(self.boards) > 1

    # A page drawing the overlay polls /api/host/state with overlay=1 every 80 ms (about once a
    # second in a background tab): one that polled this recently is taken as showing it.
    POLL_SHOWN = 1.5

    def layer_shown(self, now=None):
        """Whether anything shows the shown board's layer: the overlay on screen, or a page
        drawing it (Keybard's ?hostOverlay page) polling the Overlay."""
        now = time.monotonic() if now is None else now
        return self.surface_shown() or now - self.state.polled_at < self.POLL_SHOWN

    def track_polling(self, board):
        """How often a board's reader reads its layer and held keys (device/schedule.py): fast
        while its layer is shown, with the matrix only while held keys are highlighted;
        otherwise slowly, sampling held keys only while they pick the board on show."""
        if board.worker is None: return
        on_show = board.key == self.follower.shown and self.layer_shown()
        held = on_show and self.state.config['highlightPressed']
        plan = (held, not held and self.following(), on_show)
        if plan != board.poll_plan:
            board.poll_plan = plan
            board.generation = board.worker.set_press_tracking(*plan)

    def pointing_motion(self, motion):
        """Motion from a board (or the demo): to the overlay at up to 60 Hz, from the board on
        show and, on its hands, a keyless board whose devices are borrowed."""
        sender = self.sender()
        if sender is not None and sender is self.demo_pointing: return self.forward_pointing(motion)
        board = self.board_of(sender)
        if board is None: return
        if motion_used(motion) and board.ready:
            board.used = board.moved = time.monotonic()
            self.follow()
        shown, lender = self.shown_board(), self.boards.get(self.follower.lender)
        lent = lent_sides(lender)
        if board is shown:
            sides = tuple(side for side in ('left', 'right') if side not in lent)
            if sides: self.forward_pointing(motion, sides, source=board.key)
        elif board is lender and shown is not None:
            self.forward_pointing(motion, lent, modes=not kinds(shown.board), source=board.key)

    def forward_pointing(self, motion, sides=('left', 'right'), modes=True, source=None):
        """Add this motion to what goes to the overlay next: dx and dy add up, the rest is the newest."""
        pending = self.pointing_pending
        if pending is None:
            pending = self.pointing_pending = dict(sniper=motion['sniper'], boost=motion['boost'], elapsedMs=0)
            for side in ('left', 'right'):
                pending[side] = dict(self.pointing_sides.get(side) or motion[side], dx=0, dy=0)
            self.pointing_source = source
        for side in sides:
            for key in ('dx', 'dy'): pending[side][key] += motion[side][key]
            for key in ('valid', 'touchValid', 'touchX', 'touchY', 'fingers', 'scrolling'): pending[side][key] = motion[side][key]
            for key in ('cpi', 'contacts'):  # the newest only: contacts are where the fingers are now
                if key in motion[side]: pending[side][key] = motion[side][key]
                else: pending[side].pop(key, None)
            self.pointing_sides[side] = dict(motion[side], dx=0, dy=0)
        if modes: pending['sniper'], pending['boost'] = motion['sniper'], motion['boost']
        # Velocity Scroll is a mode too: the newest state, and gone when the board stops sending it.
        if modes:
            if 'velocityScroll' in motion: pending['velocityScroll'] = motion['velocityScroll']
            else: pending.pop('velocityScroll', None)
        # The board's own time between reads, from one board only, or the overlay's speeds double.
        if source == self.pointing_source: pending['elapsedMs'] += motion.get('elapsedMs', 0)
        config = self.state.config
        now = time.monotonic()
        if now - self.pointing_sent < .015: return
        self.pointing_sent, self.pointing_pending = now, None
        if self.state.visible and (config['showPointing'] or config['pointingPills']):
            self.surface.page().runJavaScript("window.dispatchEvent(new CustomEvent('keybard-host-pointing',{detail:" + json.dumps(pending, separators=(',', ':')) + "}))")

    def start_demo_pointing(self, velocity=False):
        """--demo-pointing: an illustration board with a left touchpad and a right trackball, rolling, sniper on.
        --demo-velocity: the same board with Velocity Scroll held on the trackball, its offset moving."""
        from dataclasses import replace
        from .device.model import demo_profile
        profile = replace(demo_profile(), pointing=(('left', 'touchpad'), ('right', 'trackball')))
        self.auto_connect = False
        self.disconnect()
        self.demo = True
        with self.state.lock:
            self.state.board = serialize_profile(profile); self.state.layout_revision += 1
            self.state.valid = True; self.state.status = 'Pointing demo (no board)'
        self.size_surface()
        self.demo_pointing = QTimer(self)
        started = time.monotonic()
        last = [started]
        self.demo_at = started

        def step():
            now = time.monotonic()
            self.demo_at = now
            with self.state.lock: self.state.valid = True
            motion = demo_motion(now - started, now - last[0], velocity); last[0] = now
            self.forward_pointing(motion)
        self.demo_pointing.timeout.connect(step)
        self.demo_pointing.start(16)
        self.publish_state()

    def shutdown(self):
        self.modifier_timer.stop(); self.modifier_reader.close()
        self.layout_timer.stop(); self.layout_hook.close(); self.layout_reader.close()
        self.foreground_timer.stop(); self.foreground_hook.close(); self.site_watcher.close()
        if self.demo_pointing is not None: self.demo_pointing.stop()
        self.scan_timer.stop(); self.timer.stop()
        if self.colors_panel is not None: self.colors_panel.close()
        workers = [b.worker for b in self.boards.values() if b.worker is not None] + self.retiring
        for worker in workers: worker.stop()
        for worker in workers: worker.wait(5000)
        self.server.shutdown(); self.server.server_close(); self.controls.close(); self.surface.close(); self.tray.hide()


def running_mode(url):
    """True/False for a running host's paranoid mode, None if it can't be told."""
    from urllib.request import urlopen
    try:
        with urlopen(url + 'api/host/bootstrap', timeout=2) as r: return json.load(r).get('paranoid') is True
    except (OSError, ValueError): return None


def refuse(message, title='Keybard Overlay (paranoid mode)'):
    from PySide6.QtWidgets import QMessageBox
    QMessageBox.critical(None, title, message)


KEYBARD_URL = 'https://keybard.svalboard.com/#overlay'


def controls_url(paranoid, local_url, keybard_url=KEYBARD_URL):
    """Where Open Keybard goes: the website's Overlay page, or in paranoid mode the
    Keybard Paranoid this host serves itself, since paranoid mode trusts no website."""
    return local_url if paranoid else keybard_url


def open_paranoid(url):
    profile = Path(QStandardPaths.writableLocation(QStandardPaths.AppLocalDataLocation)) / 'paranoid-browser-profile'
    if not open_contained(url, profile):
        refuse('Keybard Paranoid needs Google Chrome or Microsoft Edge, which were not found. Nothing was opened.')


def quit_on_signals(app, platform=None):
    """Linux and macOS: Ctrl+C in the terminal, or a plain kill, quits cleanly. Python only
    sees a signal between bytecodes, so a timer wakes it while Qt's event loop runs."""
    if (platform or sys.platform) == 'win32': return None
    import signal
    for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, lambda *_: app.quit())
    timer = QTimer(app); timer.timeout.connect(lambda: None); timer.start(300)
    return timer


def instance_name(instance):
    """The Qt application name, which names the settings folder and the lock. A test instance
    gets its own, so it never hands off to, asks to quit, or shares files with the installed one."""
    if instance is None: return 'Keybard Host'
    if not instance or not all(c.isalnum() or c in '-_' for c in instance) or len(instance) > 32:
        raise SystemExit('--instance takes a short name of letters, digits, - and _')
    return f'Keybard Host {instance}'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5178)
    parser.add_argument('--no-open', action='store_true')
    parser.add_argument('--assets', type=Path, default=Path(__file__).resolve().parent.parent / 'web')
    parser.add_argument('--settings', type=Path)
    parser.add_argument('--allow-origin', action='append', default=[], help='extra hosted Keybard origin allowed to use the host API (testing)')
    parser.add_argument('--paranoid', action='store_true', help='serve Keybard Paranoid and accept no website origins')
    parser.add_argument('--keybard-url', default=KEYBARD_URL, help='Keybard page that Open Keybard opens (testing)')
    parser.add_argument('--demo-pointing', action='store_true', help='review: an illustration board with pointing devices, rolling, sniper on (no board needed)')
    parser.add_argument('--demo-velocity', action='store_true', help='review: --demo-pointing with Velocity Scroll held on the trackball, its offset moving')
    parser.add_argument('--show-pointing', action='store_true', help='review: turn on Show pointing devices for this run, without saving it')
    parser.add_argument('--instance', help='testing: run as a separate Keybard Host with its own settings, lock and browser data '
                        '(under "Keybard Host <name>"), alongside an installed one; use with --port and --no-open')
    parser.add_argument('--only-board', action='append', default=[], metavar='SERIAL', help='testing: use only the board with this serial '
                        'number (sval:...), never any other; repeat for more')
    parser.add_argument('--log-app-rules', action='store_true', help='testing: print each app rule ID sent to the board, with the site rule '
                        'or program it stands for (never an address or a window title)')
    parser.add_argument('--diagnose', action='store_true', help='print a report of the system, display session, Qt and the boards it can see, then exit')
    args = parser.parse_args()
    if args.diagnose:
        from .diagnose import report
        print(report(), end='')
        return
    if args.paranoid:
        if args.allow_origin: parser.error('--paranoid accepts no extra origins')
        if args.assets == parser.get_default('assets'): args.assets = args.assets.parent / 'web-paranoid'
    # 'Keybard Host' is the app's earlier name. It names the settings folder and the lock,
    # so keep it: settings carry over, and an older copy and this one never run at once.
    app = QApplication(sys.argv[:1]); app.setApplicationName(instance_name(args.instance)); app.setQuitOnLastWindowClosed(False)
    hide_dock_icon()  # macOS: a menu bar app, without a Dock icon
    folder = Path(QStandardPaths.writableLocation(QStandardPaths.AppLocalDataLocation))
    folder.mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(folder / 'host.lock')); lock.setStaleLockTime(0)
    url = f'http://127.0.0.1:{args.port}/'
    if not lock.tryLock(0):
        if args.paranoid:
            # Never hand a paranoid start over to a normal host that trusts websites.
            if running_mode(url) is not True:
                return refuse(f'Another Keybard Overlay is already running and could not be confirmed to be in paranoid mode on port {args.port}. Quit it from the tray icon, then run Start-Paranoid again.')
            return open_paranoid(url)
        # A paranoid host only ever opens in the contained browser profile.
        if running_mode(url) is True: return open_paranoid(url)
        # Another normal Overlay holds the lock: same build, show its controls; another build, ask it to quit.
        outcome = hand_off(url, build_info(), lambda: lock.tryLock(100))
        if outcome.action == 'open':
            from PySide6.QtGui import QDesktopServices
            QDesktopServices.openUrl(QUrl(controls_url(False, url, args.keybard_url))); return
        if outcome.action == 'refuse':
            try: print(outcome.message, flush=True)
            except (OSError, UnicodeError): pass
            try: refuse(outcome.message, 'Keybard Overlay')
            except Exception: pass
            sys.exit(REFUSED)
        # 'start': the old one quit and this start now holds the lock.
    if not (args.assets / 'index.html').exists(): raise SystemExit('Build Keybard web assets before starting the host.')
    if not args.paranoid:
        problem = web_base_problem((args.assets / 'index.html').read_text(encoding='utf-8', errors='replace'))
        if problem:
            # A blank overlay with no word why is worse than not starting.
            print(problem, file=sys.stderr)
            return refuse(f'Keybard Overlay will not start: {problem}.', 'Keybard Overlay')
    page = None
    if args.paranoid:
        try: page = load_paranoid_page(args.assets)
        except (OSError, ValueError) as e: return refuse(f'Paranoid mode will not start: {e}.')
    state = HostState(args.settings or folder / 'preferences.json')
    host = Host(app, args.assets, state, args.port, args.allow_origin, args.paranoid, page, log_app_rules=args.log_app_rules, only_boards=args.only_board)
    host.keybard_url = args.keybard_url
    if args.show_pointing: state.config['showPointing'] = True
    if args.demo_pointing or args.demo_velocity: host.start_demo_pointing(velocity=args.demo_velocity)
    if not args.no_open: host.open_controls()
    quit_on_signals(app)
    sys.exit(app.exec())

if __name__ == '__main__': main()
