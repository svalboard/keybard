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
WINDOWS_CHROMIUM_FLAGS = ('--disable-gpu', '--disable-gpu-compositing')
if sys.platform == 'win32':
    _flags = os.environ.get('QTWEBENGINE_CHROMIUM_FLAGS', '').split()
    os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = ' '.join(_flags + [f for f in WINDOWS_CHROMIUM_FLAGS if f not in _flags])

from PySide6.QtCore import Qt, QTimer, QUrl, Signal, QObject, QStandardPaths, QLockFile, QSize, QPointF
from PySide6.QtGui import QAction, QActionGroup, QColor, QIcon, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget, QToolButton, QHBoxLayout
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings, QWebEngineScript
from .device.protocol import candidates, hid_backend
from .device.worker import DeviceWorker
from .state import DEFAULTS, EFFECTS, PRESETS, HostState, serialize_profile
from .colors import ColorsPanel
from .modifiers import ModifierReader
from .server import REMOTE_ORIGINS, load_paranoid_page, make_server
from .build import build_info
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
        self.setWindowFlags(Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus)
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

    def reposition(self):
        screen = self.surface.screen() or QApplication.primaryScreen()
        area = screen.availableGeometry()
        self.move(max(area.left(), min(self.surface.x() + self.surface.width() - self.width(), area.right() - self.width() + 1)), max(area.top(), self.surface.y() - self.height() - 4))


class Host(QObject):
    def __init__(self, app, assets, state, port, remote_origins=(), paranoid=False, page=None):
        super().__init__()
        self.app, self.state = app, state
        self.worker = None
        self.last_state = self.last_press = 0
        self.generation = 0
        self.profile_ready = False
        self.auto_connect = True
        self.devices = {}
        self.selected = None
        self.bridge = Bridge()
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
        self.ontop_timer = QTimer(self); self.ontop_timer.timeout.connect(lambda: ontop.keep_on_top((self.surface, self.controls))); self.ontop_timer.start(1000)
        self.controls.show()
        self.icon_light_background = taskbar_is_light()
        icon = host_icon(self.icon_light_background)
        app.setWindowIcon(icon); self.surface.setWindowIcon(icon)
        self.tray = QSystemTrayIcon(icon, self)
        # Follow light/dark changes. Windows sends no Qt signal for the taskbar's own setting, so check it.
        app.styleHints().colorSchemeChanged.connect(lambda _scheme: self.update_icon())
        self.icon_timer = QTimer(self); self.icon_timer.timeout.connect(self.update_icon); self.icon_timer.start(3000)
        menu = QMenu()
        self.status_action = menu.addAction('Keybard Host · waiting for board'); self.status_action.setEnabled(False)
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
        menu.addAction('Quit host', app.quit)
        self.tray.setContextMenu(menu); info = build_info(); self.tray.setToolTip(f"Keybard Host {info['version']}" + (f" · Keybard {info['keybardCommit']}" if info['keybardCommit'] else ''))
        self.tray.activated.connect(lambda reason: self.open_controls() if reason == QSystemTrayIcon.DoubleClick else None)
        self.tray.show()
        # Firmware that reports Shift and Caps Lock (GET_INFO second feature byte,
        # bit 2) is used alone; older firmware falls back to the computer's state.
        self.board_reports_modifiers = False
        self.modifier_reader = ModifierReader()
        self.modifier_timer = QTimer(self); self.modifier_timer.timeout.connect(self.read_modifiers); self.modifier_timer.start(16)
        self.timer = QTimer(self); self.timer.timeout.connect(self.tick); self.timer.start(100)
        self.scan_timer = QTimer(self); self.scan_timer.timeout.connect(self.scan); self.scan_timer.start(2500)
        QTimer.singleShot(0, self.scan)
        self.surface.windowHandle().screenChanged.connect(lambda screen: QTimer.singleShot(0, self.size_surface))
        app.aboutToQuit.connect(self.shutdown)

    def read_modifiers(self):
        if self.board_reports_modifiers or not self.profile_ready: return
        value = self.modifier_reader.read()
        with self.state.lock:
            if value == self.state.modifiers: return
            self.state.modifiers = value
        self.publish_state()

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

    def add_settings(self, menu):
        menu.addMenu(self.board_menu)
        menu.addSeparator()
        for item in (self.style_menu, self.halo_action, self.colors_action, self.highlight_menu, self.held_action, self.hands_menu):
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
        """The connected Svalboards, read when the menu opens so new boards show up."""
        self.board_menu.clear()
        group = QActionGroup(self.board_menu)
        devices = list(self.state.devices)
        names = [d['name'] for d in devices]
        for d in devices:
            label = d['name'] if names.count(d['name']) == 1 else f"{d['name']} ({d['serial'][-4:]})"
            action = self.board_menu.addAction(label); action.setCheckable(True); group.addAction(action)
            action.setChecked(d['id'] == self.state.selected_device)
            action.triggered.connect(lambda _checked=False, key=d['id']: self.command(dict(op='connect', id=key)))
        if not devices:
            self.board_menu.addAction('No Svalboard found').setEnabled(False)
        self.board_menu.addSeparator()
        disconnect = self.board_menu.addAction('Disconnect', lambda: self.command(dict(op='disconnect')))
        disconnect.setEnabled(self.state.selected_device is not None)

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

    def scan(self):
        hid = hid_backend()
        try:
            devices = candidates(hid)
            self.devices = {hashlib.sha256(d['path']).hexdigest()[:20]: d for d in devices}
            with self.state.lock:
                self.state.devices = [dict(id=key, name=d.get('product_string') or 'Svalboard', serial=d.get('serial_number') or '') for key, d in self.devices.items()]
            if self.worker is None and self.auto_connect:
                remembered = self.state.remembered
                matches = [key for key, d in self.devices.items() if remembered and remembered.get('serial') and d.get('serial_number') == remembered['serial']]
                if remembered and len(matches) == 1: self.connect(matches[0], remembered.get('uid'))
                elif not remembered and len(self.devices) == 1: self.connect(next(iter(self.devices)))
        except (OSError, ValueError) as e:
            with self.state.lock: self.state.status = f'Could not enumerate boards: {e}'

    def connect(self, key, uid=None):
        if key not in self.devices: return
        if not self.disconnect(): return
        self.selected = self.devices[key]
        self.state.selected_device = key
        self.worker = DeviceWorker(self.selected, int(uid) if uid else None)
        self.generation = self.worker.set_press_tracking(self.state.config['highlightPressed'])
        self.worker.profile.connect(self.profile)
        self.worker.state.connect(self.layers)
        self.worker.pressed.connect(self.pressed)
        self.worker.status.connect(self.status)
        self.worker.start()

    def disconnect(self):
        if self.worker:
            self.worker.stop()
            if not self.worker.wait(1600): return False
            self.worker.deleteLater(); self.worker = None
        self.profile_ready = False
        with self.state.lock:
            self.state.valid = False; self.state.pressed = []; self.state.board = None; self.state.selected_device = None
            self.state.layout_revision += 1; self.state.session = secrets.token_hex(12)
            self.state.default = None; self.state.active = 0; self.state.matrix_available = None; self.state.modifiers = None
        self.board_reports_modifiers = False
        return True

    def profile(self, profile):
        if self.sender() is not self.worker: return
        with self.state.lock:
            self.state.board = serialize_profile(profile); self.state.layout_revision += 1
            self.state.board['name'] = self.selected.get('product_string') or profile.name
            serial = self.selected.get('serial_number')
            if serial:
                self.state.remembered = dict(serial=serial, uid=str(profile.uid))
                try: self.state.save()
                except OSError: pass
        self.profile_ready = True
        self.size_surface()
        self.publish_state()

    def layers(self, snapshot):
        if self.sender() is not self.worker or not self.profile_ready: return
        self.last_state = time.monotonic()
        with self.state.lock:
            self.state.active, self.state.default = snapshot.active, snapshot.default
            # Shift and Caps Lock come from this board alone when it reports them.
            self.board_reports_modifiers = snapshot.modifiers is not None
            if self.board_reports_modifiers: self.state.modifiers = snapshot.modifiers
            mask = snapshot.active | (snapshot.default if snapshot.default is not None else self.state.config['manualDefault'])
            self.state.valid = not (mask >> len(self.state.board['keymap']))
            if not self.state.valid: self.state.status = 'Board refers to an unknown layer; reload the layout'
        self.publish_state()

    def pressed(self, snapshot):
        if self.sender() is not self.worker: return
        generation, positions, sampled_at = snapshot
        if generation != self.generation or not self.state.config['highlightPressed']: return
        with self.state.lock:
            self.state.matrix_available = positions is not None
            self.state.pressed = [row * 6 + col for row, col in positions] if positions is not None and self.state.valid and time.monotonic() - sampled_at <= .5 else []
        self.last_press = sampled_at
        self.publish_state()

    def status(self, status):
        if self.sender() is not self.worker: return
        with self.state.lock:
            self.state.status = status
            if not status.startswith('Connected'):
                self.state.valid = False; self.state.pressed = []
                if status.startswith(('Connecting', 'Disconnected', 'Stopped')):
                    self.profile_ready = False; self.state.default = None

    def tick(self):
        with self.state.lock:
            if time.monotonic() - self.last_state > .6:
                self.state.valid = False; self.state.pressed = []
            if time.monotonic() - self.last_press > .5: self.state.pressed = []
            if time.monotonic() - self.state.practice_at > 2.5:
                self.state.practice_hidden = []; self.state.practice_target = None
        self.status_action.setText(self.state.status[:65])
        self.sync_menu()
        self.publish_state()

    def command(self, value):
        op = value['op']
        if op == 'configure':
            if self.worker:
                self.generation = self.worker.set_press_tracking(self.state.config['highlightPressed'])
            with self.state.lock: self.state.pressed = []
            self.size_surface()
        elif op == 'show':
            if value['value']: self.controls.set_collapsed(False)
            self.state.visible = value['value']; self.surface.setVisible(value['value']); self.show_action.setChecked(value['value']); self.controls.setVisible(value['value'])
        elif op == 'place': self.place()
        elif op == 'practice':
            with self.state.lock:
                self.state.practice_hidden = value['hidden']; self.state.practice_target = value['target']; self.state.practice_at = time.monotonic()
        elif op == 'scan': self.scan()
        elif op == 'connect': self.auto_connect = True; self.connect(value['id'])
        elif op == 'disconnect':
            self.auto_connect = False
            if self.disconnect(): self.state.status = 'Disconnected by user'
        elif op == 'reload' and self.worker:
            self.state.valid = False; self.profile_ready = False; self.worker.reload()
        elif op == 'refresh' and self.worker and self.profile_ready:
            # Keybard changed the board: re-read it, showing the current layout until the new one arrives.
            self.worker.refresh()
        elif op == 'refresh' and self.worker:
            self.worker.reload()
        self.publish_state()

    def shutdown(self):
        self.modifier_timer.stop(); self.modifier_reader.close()
        self.scan_timer.stop(); self.timer.stop()
        if self.colors_panel is not None: self.colors_panel.close()
        if self.worker:
            self.worker.stop(); self.worker.wait(5000)
        self.server.shutdown(); self.server.server_close(); self.controls.close(); self.surface.close(); self.tray.hide()


def running_mode(url):
    """True/False for a running host's paranoid mode, None if it can't be told."""
    from urllib.request import urlopen
    try:
        with urlopen(url + 'api/host/bootstrap', timeout=2) as r: return json.load(r).get('paranoid') is True
    except (OSError, ValueError): return None


def refuse(message):
    from PySide6.QtWidgets import QMessageBox
    QMessageBox.critical(None, 'Keybard Host (paranoid mode)', message)


KEYBARD_URL = 'https://keybard.svalboard.com/#overlay'


def controls_url(paranoid, local_url, keybard_url=KEYBARD_URL):
    """Where Open Keybard goes: the website's Overlay page, or in paranoid mode the
    Keybard Paranoid this host serves itself, since paranoid mode trusts no website."""
    return local_url if paranoid else keybard_url


def open_paranoid(url):
    profile = Path(QStandardPaths.writableLocation(QStandardPaths.AppLocalDataLocation)) / 'paranoid-browser-profile'
    if not open_contained(url, profile):
        refuse('Keybard Paranoid needs Google Chrome or Microsoft Edge, which were not found. Nothing was opened.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5178)
    parser.add_argument('--no-open', action='store_true')
    parser.add_argument('--assets', type=Path, default=Path(__file__).resolve().parent.parent / 'web')
    parser.add_argument('--settings', type=Path)
    parser.add_argument('--allow-origin', action='append', default=[], help='extra hosted Keybard origin allowed to use the host API (testing)')
    parser.add_argument('--paranoid', action='store_true', help='serve Keybard Paranoid and accept no website origins')
    parser.add_argument('--keybard-url', default=KEYBARD_URL, help='Keybard page that Open Keybard opens (testing)')
    args = parser.parse_args()
    if args.paranoid:
        if args.allow_origin: parser.error('--paranoid accepts no extra origins')
        if args.assets == parser.get_default('assets'): args.assets = args.assets.parent / 'web-paranoid'
    app = QApplication(sys.argv[:1]); app.setApplicationName('Keybard Host'); app.setQuitOnLastWindowClosed(False)
    hide_dock_icon()  # macOS: a menu bar app, without a Dock icon
    folder = Path(QStandardPaths.writableLocation(QStandardPaths.AppLocalDataLocation))
    folder.mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(folder / 'host.lock')); lock.setStaleLockTime(0)
    url = f'http://127.0.0.1:{args.port}/'
    if not lock.tryLock(0):
        if args.paranoid:
            # Never hand a paranoid start over to a normal host that trusts websites.
            if running_mode(url) is not True:
                return refuse(f'Another Keybard Host is already running and could not be confirmed to be in paranoid mode on port {args.port}. Quit it from the tray icon, then run Start-Paranoid again.')
            return open_paranoid(url)
        # A paranoid host only ever opens in the contained browser profile.
        if running_mode(url) is True: return open_paranoid(url)
        from PySide6.QtGui import QDesktopServices
        QDesktopServices.openUrl(QUrl(controls_url(False, url, args.keybard_url))); return
    if not (args.assets / 'index.html').exists(): raise SystemExit('Build Keybard web assets before starting the host.')
    page = None
    if args.paranoid:
        try: page = load_paranoid_page(args.assets)
        except (OSError, ValueError) as e: return refuse(f'Paranoid mode will not start: {e}.')
    state = HostState(args.settings or folder / 'preferences.json')
    host = Host(app, args.assets, state, args.port, args.allow_origin, args.paranoid, page)
    host.keybard_url = args.keybard_url
    if not args.no_open: host.open_controls()
    sys.exit(app.exec())

if __name__ == '__main__': main()
