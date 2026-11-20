"""Which app is in front, for app rules (docs/protocol.md, "App rules" in svalboard/qmk).

An app is named by a key: on Windows the program's file name with `.exe` (`notepad.exe`), on
macOS the bundle ID (`com.apple.Safari`), on Linux the Wayland app_id or the X11 WM_CLASS class
(`firefox`). The board stores a 4-byte ID made from the key (app_id below).

foreground_app() and running_apps() are cheap enough to call several times a second. Each
returns None or [] where the system won't say (a locked screen, a Wayland compositor with no
way to ask). Nothing here is kept or sent anywhere but the board and the local Keybard page.
"""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import threading

FNV_OFFSET, FNV_PRIME = 0x811C9DC5, 0x01000193


def app_key(key):
    """The key as the ID is made from it: spaces and tabs dropped at both ends, ASCII A-Z lowered."""
    key = (key or '').strip(' \t')
    return ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in key)


def app_id(key):
    """FNV-1a 32 over the normalized key's UTF-8 bytes. 0 is sent as 1; an empty key is 0 (no app)."""
    data = app_key(key).encode('utf-8')
    if not data: return 0
    value = FNV_OFFSET
    for byte in data:
        value = ((value ^ byte) * FNV_PRIME) & 0xFFFFFFFF
    return value or 1


def platform_name(platform=None):
    platform = platform or sys.platform
    return 'windows' if platform == 'win32' else 'macos' if platform == 'darwin' else 'linux'


# ---------------------------------------------------------------- Windows

class _Windows:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    GW_OWNER = 4
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x80
    DWMWA_CLOAKED = 14
    FRAME_HOST = 'applicationframehost.exe'

    def __init__(self):
        from ctypes import wintypes
        self.wt = wintypes
        user = ctypes.WinDLL('user32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        user.GetForegroundWindow.restype = wintypes.HWND
        user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user.GetWindowThreadProcessId.restype = wintypes.DWORD
        user.IsWindowVisible.argtypes = [wintypes.HWND]
        user.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        user.GetWindow.restype = wintypes.HWND
        user.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
        user.GetWindowLongW.restype = wintypes.LONG
        self.EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user.EnumWindows.argtypes = [self.EnumProc, wintypes.LPARAM]
        user.EnumChildWindows.argtypes = [wintypes.HWND, self.EnumProc, wintypes.LPARAM]
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.user, self.kernel = user, kernel
        try:
            self.dwm = ctypes.WinDLL('dwmapi')
            self.dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        except OSError:
            self.dwm = None
        try:
            version = ctypes.WinDLL('version')
            version.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
            version.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
            version.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
            self.version = version
        except OSError:
            self.version = None
        self.descriptions = {}
        self.lock = threading.Lock()

    def pid_of(self, hwnd):
        pid = self.wt.DWORD()
        self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value

    def path_of_pid(self, pid):
        if not pid: return None
        handle = self.kernel.OpenProcess(self.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle: return None
        try:
            size = self.wt.DWORD(1024)
            buffer = ctypes.create_unicode_buffer(size.value)
            if not self.kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)): return None
            return buffer.value
        finally:
            self.kernel.CloseHandle(handle)

    def description(self, path):
        """The program's FileDescription ("Google Chrome"), or its file name without .exe."""
        with self.lock:
            if path in self.descriptions: return self.descriptions[path]
        name = None
        if self.version is not None:
            try: name = self._file_description(path)
            except (OSError, ValueError): name = None
        name = name or os.path.splitext(os.path.basename(path))[0]
        with self.lock:
            if len(self.descriptions) > 512: self.descriptions.clear()
            self.descriptions[path] = name
        return name

    def _file_description(self, path):
        size = self.version.GetFileVersionInfoSizeW(path, None)
        if not size: return None
        data = ctypes.create_string_buffer(size)
        if not self.version.GetFileVersionInfoW(path, 0, size, data): return None
        pointer, length = ctypes.c_void_p(), self.wt.UINT()
        pages = []
        if self.version.VerQueryValueW(data, '\\VarFileInfo\\Translation', ctypes.byref(pointer), ctypes.byref(length)) and length.value >= 4:
            words = (ctypes.c_ushort * (length.value // 2)).from_address(pointer.value)
            pages = [(words[i], words[i + 1]) for i in range(0, len(words) - 1, 2)]
        for lang, codepage in pages + [(0x0409, 0x04B0), (0x0409, 0x04E4)]:
            query = f'\\StringFileInfo\\{lang:04x}{codepage:04x}\\FileDescription'
            if self.version.VerQueryValueW(data, query, ctypes.byref(pointer), ctypes.byref(length)) and length.value > 1:
                text = ctypes.wstring_at(pointer.value, length.value).rstrip('\0').strip()
                if text: return text
        return None

    def app_of_window(self, hwnd):
        pid = self.pid_of(hwnd)
        path = self.path_of_pid(pid)
        if path and os.path.basename(path).lower() == self.FRAME_HOST:
            # A Store app's window belongs to ApplicationFrameHost; the app is the child of another process.
            found = []

            def child(handle, _):
                other = self.pid_of(handle)
                if other and other != pid:
                    found.append(other); return False
                return True
            self.user.EnumChildWindows(hwnd, self.EnumProc(child), 0)
            if found: path = self.path_of_pid(found[0]) or path
        if not path: return None
        return os.path.basename(path), self.description(path)

    def foreground(self):
        hwnd = self.user.GetForegroundWindow()
        return self.app_of_window(hwnd) if hwnd else None

    def title(self, hwnd):
        length = self.user.GetWindowTextLengthW(hwnd)
        if length <= 0: return ''
        buffer = ctypes.create_unicode_buffer(min(length, 4096) + 1)
        self.user.GetWindowTextW(hwnd, buffer, len(buffer))
        return buffer.value

    def foreground_window(self):
        """(window handle, app, title) of the window in front: for site rules, which read a browser's
        address bar and read it again when the title (the tab) changes."""
        hwnd = self.user.GetForegroundWindow()
        if not hwnd: return None, None, None
        return hwnd, self.app_of_window(hwnd), self.title(hwnd)

    def cloaked(self, hwnd):
        if self.dwm is None: return False
        value = ctypes.c_int(0)
        if self.dwm.DwmGetWindowAttribute(hwnd, self.DWMWA_CLOAKED, ctypes.byref(value), ctypes.sizeof(value)) != 0: return False
        return bool(value.value)

    def running(self):
        """Programs with a top-level window on the taskbar: visible, unowned, titled, not a tool window."""
        windows = []

        def each(hwnd, _):
            if (self.user.IsWindowVisible(hwnd) and not self.user.GetWindow(hwnd, self.GW_OWNER)
                    and self.user.GetWindowTextLengthW(hwnd) > 0
                    and not self.user.GetWindowLongW(hwnd, self.GWL_EXSTYLE) & self.WS_EX_TOOLWINDOW
                    and not self.cloaked(hwnd)):
                windows.append(hwnd)
            return True
        self.user.EnumWindows(self.EnumProc(each), 0)
        return [app for app in (self.app_of_window(hwnd) for hwnd in windows) if app]


# ---------------------------------------------------------------- macOS

class _MacOS:
    """NSWorkspace through the Objective-C runtime (as macos.py does), so no pyobjc is needed.
    Untested on real hardware: written from Apple's documentation."""
    REGULAR = 0  # NSApplicationActivationPolicyRegular: apps with a Dock icon

    def __init__(self, send=None, runtime=None):
        from . import macos
        self.send = send or macos._send
        self.runtime = runtime or macos._runtime()
        lib = self.runtime
        if hasattr(lib, 'objc_autoreleasePoolPush'):
            lib.objc_autoreleasePoolPush.restype = ctypes.c_void_p
            lib.objc_autoreleasePoolPop.argtypes = [ctypes.c_void_p]
        # AppKit is loaded by QApplication; NSWorkspace lives there.
        if not lib.objc_getClass(b'NSWorkspace'):
            ctypes.cdll.LoadLibrary('/System/Library/Frameworks/AppKit.framework/AppKit')

    def text(self, nsstring):
        if not nsstring: return None
        raw = self.send(nsstring, 'UTF8String', ctypes.c_char_p)
        return raw.decode('utf-8', 'replace') if raw else None

    def app(self, running):
        if not running: return None
        key = self.text(self.send(running, 'bundleIdentifier'))
        if not key: return None
        return key, self.text(self.send(running, 'localizedName')) or key

    def pooled(self, work):
        lib = self.runtime
        pool = lib.objc_autoreleasePoolPush() if hasattr(lib, 'objc_autoreleasePoolPush') else None
        try: return work()
        finally:
            if pool: lib.objc_autoreleasePoolPop(pool)

    def workspace(self):
        return self.send(self.runtime.objc_getClass(b'NSWorkspace'), 'sharedWorkspace')

    def foreground(self):
        return self.pooled(lambda: self.app(self.send(self.workspace(), 'frontmostApplication')))

    def foreground_window(self):
        """(process ID, app, None): the app's process stands for its window, so site rules can ask
        the browser for its front tab (address_bar.MacAddressBar). macOS gives no window title
        without the Accessibility permission, so site rules read again every second instead."""
        def work():
            running = self.send(self.workspace(), 'frontmostApplication')
            if not running: return None, None, None
            pid = self.send(running, 'processIdentifier', ctypes.c_int)
            return (pid if pid and pid > 0 else None), self.app(running), None
        return self.pooled(work)

    def running(self):
        def work():
            apps = self.send(self.workspace(), 'runningApplications')
            if not apps: return []
            out = []
            for i in range(self.send(apps, 'count', ctypes.c_ulong)):
                item = self.send(apps, 'objectAtIndex:', ctypes.c_void_p, (ctypes.c_ulong, i))
                if self.send(item, 'activationPolicy', ctypes.c_long) != self.REGULAR: continue
                app = self.app(item)
                if app: out.append(app)
            return out
        return self.pooled(work)


# ---------------------------------------------------------------- Linux

def _run_json(command, run=None):
    run = run or (lambda c: subprocess.run(c, capture_output=True, text=True, timeout=1).stdout)
    try: return json.loads(run(command) or 'null')
    except (OSError, subprocess.SubprocessError, ValueError): return None


class _Sway:
    """sway (and i3-compatible Wayland compositors with swaymsg): the tree has app_id, or the
    WM_CLASS class for XWayland windows."""

    def __init__(self, run=None): self.run = run

    @staticmethod
    def key_of(node):
        key = node.get('app_id') or (node.get('window_properties') or {}).get('class')
        return (key, key) if key else None

    def windows(self):
        tree = _run_json(['swaymsg', '-t', 'get_tree', '-r'], self.run)
        out, stack = [], [tree] if isinstance(tree, dict) else []
        while stack:
            node = stack.pop()
            if node.get('pid') and (node.get('app_id') or node.get('window_properties')): out.append(node)
            stack.extend(node.get('nodes') or []); stack.extend(node.get('floating_nodes') or [])
        return out

    def foreground(self):
        node = next((n for n in self.windows() if n.get('focused')), None)
        return self.key_of(node) if node else None

    def running(self):
        return [app for app in (self.key_of(n) for n in self.windows()) if app]


class _Hyprland:
    """Hyprland: `class` is the Wayland app_id (or the WM_CLASS class under XWayland)."""

    def __init__(self, run=None): self.run = run

    def foreground(self):
        value = _run_json(['hyprctl', 'activewindow', '-j'], self.run)
        key = value.get('class') if isinstance(value, dict) else None
        return (key, value.get('initialTitle') or key) if key else None

    def running(self):
        value = _run_json(['hyprctl', 'clients', '-j'], self.run)
        return [(c['class'], c['class']) for c in value or [] if isinstance(c, dict) and c.get('class')]


class _Kde:
    """KDE Plasma on Wayland, through kdotool (it asks KWin with a short script): the active
    window's resource class, which is the Wayland app_id (or the X11 class under XWayland).
    Untested on a real Plasma desktop."""
    def __init__(self, run=None):
        self.run = run or (lambda c: subprocess.run(c, capture_output=True, text=True, timeout=1).stdout)

    def foreground(self):
        try: out = (self.run(['kdotool', 'getactivewindow', 'getwindowclassname']) or '').strip()
        except (OSError, subprocess.SubprocessError): return None
        key = out.splitlines()[0].strip() if out else ''
        return (key, key) if key else None

    def running(self):
        # kdotool lists windows only by search: the app in front is offered alone.
        front = self.foreground()
        return [front] if front else []


class _X11:
    """The active window's WM_CLASS class through libX11 on its own display connection:
    a few X requests, no process."""

    def __init__(self):
        x = ctypes.CDLL('libX11.so.6')
        x.XOpenDisplay.argtypes = [ctypes.c_char_p]; x.XOpenDisplay.restype = ctypes.c_void_p
        x.XCloseDisplay.argtypes = [ctypes.c_void_p]
        x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]; x.XInternAtom.restype = ctypes.c_ulong
        x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]; x.XDefaultRootWindow.restype = ctypes.c_ulong
        x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
                                         ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                         ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
        x.XFree.argtypes = [ctypes.c_void_p]

        class ClassHint(ctypes.Structure):
            _fields_ = [('res_name', ctypes.c_void_p), ('res_class', ctypes.c_void_p)]
        self.ClassHint = ClassHint
        x.XGetClassHint.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ClassHint)]
        # A window can close between two requests: ignore X errors rather than let Xlib exit.
        self.Handler = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
        self.handler = self.Handler(lambda display, event: 0)
        x.XSetErrorHandler.argtypes = [self.Handler]
        x.XSetErrorHandler(self.handler)
        self.x = x
        self.display = x.XOpenDisplay(None)
        if not self.display: raise OSError('No X display')
        self.root = x.XDefaultRootWindow(self.display)
        self.active = x.XInternAtom(self.display, b'_NET_ACTIVE_WINDOW', 1)
        self.clients = x.XInternAtom(self.display, b'_NET_CLIENT_LIST', 1)
        self.lock = threading.Lock()

    def windows(self, atom):
        if not atom: return []
        kind, fmt, count, after, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        if self.x.XGetWindowProperty(self.display, self.root, atom, 0, 4096, 0, 33,  # XA_WINDOW
                                     ctypes.byref(kind), ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(after), ctypes.byref(data)) != 0:
            return []
        try:
            if not data.value or fmt.value != 32: return []
            return [w for w in (ctypes.c_ulong * count.value).from_address(data.value) if w]
        finally:
            if data.value: self.x.XFree(data)

    def class_of(self, window):
        hint = self.ClassHint()
        if not self.x.XGetClassHint(self.display, window, ctypes.byref(hint)): return None
        try:
            key = ctypes.string_at(hint.res_class).decode('utf-8', 'replace') if hint.res_class else None
        finally:
            for pointer in (hint.res_name, hint.res_class):
                if pointer: self.x.XFree(pointer)
        return (key, key) if key else None

    def foreground(self):
        with self.lock:
            active = self.windows(self.active)
            return self.class_of(active[0]) if active else None

    def running(self):
        with self.lock:
            return [app for app in (self.class_of(w) for w in self.windows(self.clients)) if app]

    def close(self):
        if self.display: self.x.XCloseDisplay(self.display); self.display = None


class _Nothing:
    def foreground(self): return None
    def running(self): return []


def linux_source(environ=None, which=shutil.which):
    """Wayland: the compositor's own tool where there is one (sway, Hyprland, KDE Plasma with
    kdotool); others (GNOME) don't tell other apps which window is in front, so nothing. X11: libX11."""
    environ = os.environ if environ is None else environ
    if environ.get('SWAYSOCK') and which('swaymsg'): return _Sway()
    if environ.get('HYPRLAND_INSTANCE_SIGNATURE') and which('hyprctl'): return _Hyprland()
    if environ.get('WAYLAND_DISPLAY') or environ.get('XDG_SESSION_TYPE') == 'wayland':
        desktops = (environ.get('XDG_CURRENT_DESKTOP') or '').split(':')
        if any(d.upper() == 'KDE' for d in desktops) and which('kdotool'): return _Kde()
        # XWayland's _NET_ACTIVE_WINDOW goes stale while a Wayland window is in front: never use it.
        return _Nothing()
    if environ.get('DISPLAY'):
        try: return _X11()
        except (OSError, AttributeError): pass
    return _Nothing()


# ---------------------------------------------------------------- the module's interface

_source, _source_lock = None, threading.Lock()


def make_source(platform=None, environ=None):
    platform = platform or sys.platform
    try:
        if platform == 'win32': return _Windows()
        if platform == 'darwin': return _MacOS()
        return linux_source(environ)
    except (OSError, AttributeError, ImportError, ValueError):
        return _Nothing()


def source():
    global _source
    with _source_lock:
        if _source is None: _source = make_source()
        return _source


def foreground_app(src=None):
    """(key, display name) of the app in front, or None."""
    try: return (src or source()).foreground()
    except (OSError, ValueError, TypeError, AttributeError): return None


def foreground_window(src=None):
    """(window, (key, display name) or None, title) of the window in front. The window and title
    are None where only the app is known (macOS, Linux): site rules then use the program."""
    src = src or source()
    try:
        if hasattr(src, 'foreground_window'): return src.foreground_window()
        return None, src.foreground(), None
    except (OSError, ValueError, TypeError, AttributeError): return None, None, None


def running_apps(src=None):
    """[(key, display name)] of the apps with windows, one per key, in the order found."""
    try: apps = (src or source()).running()
    except (OSError, ValueError, TypeError, AttributeError): return []
    seen, out = set(), []
    for key, name in apps:
        normalized = app_key(key)
        if normalized and normalized not in seen:
            seen.add(normalized); out.append((key, name))
    return out


def apps_snapshot(src=None, platform=None):
    """The /api/host/apps reply."""
    front = foreground_app(src)
    return dict(platform=platform_name(platform),
                foreground=dict(key=front[0], name=front[1]) if front else None,
                apps=[dict(key=key, name=name) for key, name in running_apps(src)])
