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

from PySide6.QtCore import Qt, QTimer, QUrl, Signal, QObject, QStandardPaths, QLockFile, QSize, QPointF
from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget, QToolButton, QHBoxLayout
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings, QWebEngineScript
from .device.protocol import candidates
from .device.worker import DeviceWorker
from .state import HostState, serialize_profile
from .modifiers import ModifierReader
from .server import REMOTE_ORIGINS, load_paranoid_page, make_server
from .browser import open_contained


class Bridge(QObject):
    command = Signal(object)


class LocalPage(QWebEnginePage):
    def acceptNavigationRequest(self, url, kind, main):
        return url.scheme() in ('http', 'about') and (url.scheme() == 'about' or (url.host() == '127.0.0.1' and url.port() == self.parent().host_port))


class Surface(QWebEngineView):
    geometry_changed = Signal()

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
        self.arranging = True
        self.drag_origin = None

    def mousePressEvent(self, event):
        if self.arranging and event.button() == Qt.LeftButton:
            if self.windowHandle() and self.windowHandle().startSystemMove(): return
        super().mousePressEvent(event)

    def set_arrange(self, value):
        self.arranging = value
        # A transparent child webview leaves drag events to the native surface.
        self.setAttribute(Qt.WA_TransparentForMouseEvents, False)
        self.setWindowFlag(Qt.WindowTransparentForInput, not value)
        for child in self.findChildren(QObject):
            if hasattr(child, 'setAttribute'): child.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.show()


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
    else:
        painter.setPen(Qt.NoPen); painter.setBrush(QColor('#eeeeee'))
        for x in (3, 8, 13): painter.drawEllipse(QPointF(x, 8), 1.2, 1.2)
    painter.end()
    pixmap.setDevicePixelRatio(2)
    return QIcon(pixmap)


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

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            if self.surface.windowHandle() and self.surface.windowHandle().startSystemMove():
                self.offset = None
            else:
                self.offset = event.globalPosition().toPoint() - self.surface.pos()
            event.accept()

    def mouseMoveEvent(self, event):
        if self.offset is not None and event.buttons() & Qt.LeftButton:
            self.surface.move(event.globalPosition().toPoint() - self.offset)
            event.accept()

    def mouseReleaseEvent(self, event):
        self.offset = None
        event.accept()


class OverlayControls(QWidget):
    """A separate input window keeps the handle usable when the keyboard passes clicks through."""
    def __init__(self, surface, hide, open_controls, set_click_through):
        super().__init__(None, Qt.Tool | Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.WindowDoesNotAcceptFocus)
        self.surface = surface
        self.setWindowTitle('Keybard · Overlay controls')
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setStyleSheet('QToolButton {color:#eee;background:#303436;border:1px solid #666;border-radius:2px;padding:0;} QToolButton:hover {background:#505456;} QToolButton::menu-indicator {image:none;width:0;height:0;}')
        layout = QHBoxLayout(self); layout.setContentsMargins(0, 0, 0, 0); layout.setSpacing(4)
        self.handle = DragHandle(surface, self)
        self.more = QToolButton(self); self.more.setIcon(overlay_control_icon('more')); self.more.setIconSize(QSize(16, 16)); self.more.setToolTip('Overlay controls'); self.more.setAccessibleName('Overlay controls')
        self.more.setPopupMode(QToolButton.InstantPopup)
        menu = QMenu(self.more)
        menu.addAction('Hide overlay', hide)
        menu.addAction('Open Keybard', open_controls)
        self.click_through = menu.addAction('Click through keyboard'); self.click_through.setCheckable(True)
        self.click_through.triggered.connect(set_click_through)
        self.more.setMenu(menu)
        for button in (self.handle, self.more):
            button.setFixedSize(24, 24); layout.addWidget(button)
        self.setFixedSize(52, 24)
        surface.geometry_changed.connect(self.reposition)
        self.reposition()

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
        self.server = make_server(state, assets, self.bridge.command.emit, port, set() if paranoid else REMOTE_ORIGINS | set(remote_origins), paranoid, page)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/'
        self.surface = Surface(self.server.server_port)
        self.published_layout = -1
        self.published_state = None
        self.last_publish = 0
        self.surface.loadFinished.connect(self.renderer_loaded)
        self.surface.show()
        self.surface.set_arrange(True)
        self.place()
        self.controls = OverlayControls(self.surface,
            lambda: self.command(dict(op='show', value=False)), self.open_controls,
            lambda value: self.command(dict(op='arrange', value=not value)))
        self.controls.show()
        icon = QIcon(str(Path(__file__).parent / 'assets' / 'svalboard.png'))
        app.setWindowIcon(icon); self.surface.setWindowIcon(icon)
        self.tray = QSystemTrayIcon(icon, self)
        menu = QMenu()
        self.status_action = menu.addAction('Keybard Host · waiting for board'); self.status_action.setEnabled(False)
        menu.addSeparator(); menu.addAction('Open Keybard', self.open_controls)
        self.show_action = QAction('Show overlay', menu, checkable=True, checked=True)
        self.show_action.triggered.connect(lambda value: self.command(dict(op='show', value=value)))
        menu.addAction(self.show_action)
        self.arrange_action = QAction('Drag to reposition', menu, checkable=True, checked=True)
        self.arrange_action.triggered.connect(lambda value: self.command(dict(op='arrange', value=value)))
        menu.addAction(self.arrange_action)
        menu.addAction('Place at bottom', self.place)
        menu.addSeparator(); menu.addAction('Reload board layout', lambda: self.command(dict(op='reload')))
        menu.addAction('Quit host', app.quit)
        self.tray.setContextMenu(menu); self.tray.setToolTip('Keybard Host')
        self.tray.activated.connect(lambda reason: self.open_controls() if reason == QSystemTrayIcon.DoubleClick else None)
        self.tray.show()
        self.modifier_reader = ModifierReader()
        self.modifier_timer = QTimer(self); self.modifier_timer.timeout.connect(self.read_modifiers); self.modifier_timer.start(16)
        self.timer = QTimer(self); self.timer.timeout.connect(self.tick); self.timer.start(100)
        self.scan_timer = QTimer(self); self.scan_timer.timeout.connect(self.scan); self.scan_timer.start(2500)
        QTimer.singleShot(0, self.scan)
        self.surface.windowHandle().screenChanged.connect(lambda screen: QTimer.singleShot(0, self.size_surface))
        app.aboutToQuit.connect(self.shutdown)

    def read_modifiers(self):
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

    def open_controls(self):
        if self.paranoid: return open_paranoid(self.url)
        from PySide6.QtGui import QDesktopServices
        QDesktopServices.openUrl(QUrl(self.url))

    def size_surface(self):
        screen = self.surface.screen() or self.app.primaryScreen()
        area = screen.availableGeometry()
        width = min(int(1050 * self.state.config['scale'] / 100), area.width() - 32)
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

    def place(self):
        self.size_surface()
        area = (self.surface.screen() or self.app.primaryScreen()).availableGeometry()
        self.surface.move(area.x() + (area.width() - self.surface.width()) // 2, area.bottom() - self.surface.height() - 25)

    def scan(self):
        import hid
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
            self.state.default = None; self.state.active = 0; self.state.matrix_available = None
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
        self.publish_state()

    def command(self, value):
        op = value['op']
        if op == 'configure':
            if self.worker:
                self.generation = self.worker.set_press_tracking(self.state.config['highlightPressed'])
            with self.state.lock: self.state.pressed = []
            self.size_surface()
        elif op == 'show':
            self.state.visible = value['value']; self.surface.setVisible(value['value']); self.show_action.setChecked(value['value']); self.controls.setVisible(value['value'])
        elif op == 'arrange':
            self.state.arrange = value['value']; self.surface.set_arrange(value['value']); self.surface.setVisible(self.state.visible); self.arrange_action.setChecked(value['value']); self.controls.click_through.setChecked(not value['value']); self.controls.reposition()
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
        self.publish_state()

    def shutdown(self):
        self.modifier_timer.stop()
        self.modifier_reader.close()
        self.scan_timer.stop(); self.timer.stop()
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
    parser.add_argument('--open-file', type=Path, help='open a local Keybard Paranoid file in the contained browser, then exit')
    args = parser.parse_args()
    if args.open_file:
        app = QApplication(sys.argv[:1]); app.setApplicationName('Keybard Host')
        return open_paranoid(QUrl.fromLocalFile(str(args.open_file.resolve())).toString())
    if args.paranoid:
        if args.allow_origin: parser.error('--paranoid accepts no extra origins')
        if args.assets == parser.get_default('assets'): args.assets = args.assets.parent / 'web-paranoid'
    app = QApplication(sys.argv[:1]); app.setApplicationName('Keybard Host'); app.setQuitOnLastWindowClosed(False)
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
        QDesktopServices.openUrl(QUrl(url)); return
    if not (args.assets / 'index.html').exists(): raise SystemExit('Build Keybard web assets before starting the host.')
    page = None
    if args.paranoid:
        try: page = load_paranoid_page(args.assets)
        except (OSError, ValueError) as e: return refuse(f'Paranoid mode will not start: {e}.')
    state = HostState(args.settings or folder / 'preferences.json')
    host = Host(app, args.assets, state, args.port, args.allow_origin, args.paranoid, page)
    if not args.no_open: host.open_controls()
    sys.exit(app.exec())

if __name__ == '__main__': main()
