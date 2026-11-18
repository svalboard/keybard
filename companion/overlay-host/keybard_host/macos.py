"""macOS window behavior that Qt has no flag for.

Calls the Objective-C runtime through ctypes, so the Host needs no pyobjc.
Everything here is best effort: on other platforms, or if a call fails, it
does nothing and the Host carries on with Qt's defaults.

Untested on real hardware: written on Windows from Apple's documentation.
"""
import ctypes
import sys

LIBOBJC = '/usr/lib/libobjc.A.dylib'

# NSWindowCollectionBehavior
CAN_JOIN_ALL_SPACES = 1 << 0    # show on every Space instead of the one it opened on
STATIONARY = 1 << 4             # stay put during Mission Control
IGNORES_CYCLE = 1 << 6          # skip in Cmd-` window cycling
FULL_SCREEN_AUXILIARY = 1 << 8  # may sit over another app's full-screen window
OVERLAY_BEHAVIOR = CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE | FULL_SCREEN_AUXILIARY

# NSApplicationActivationPolicyAccessory: no Dock icon or app menu, like other menu bar apps.
ACCESSORY = 1

_runtime_lib = None


def is_mac(platform=None):
    return (platform or sys.platform) == 'darwin'


def _platform_name():
    """Qt's QPA plugin name, or '' with no application yet.

    Imported here so the module keeps working without Qt installed."""
    from PySide6.QtGui import QGuiApplication
    app = QGuiApplication.instance()
    return app.platformName() if app else ''


def _runtime():
    global _runtime_lib
    if _runtime_lib is None:
        lib = ctypes.cdll.LoadLibrary(LIBOBJC)
        lib.objc_getClass.restype = ctypes.c_void_p
        lib.objc_getClass.argtypes = [ctypes.c_char_p]
        lib.sel_registerName.restype = ctypes.c_void_p
        lib.sel_registerName.argtypes = [ctypes.c_char_p]
        _runtime_lib = lib
    return _runtime_lib


def _send(receiver, selector, restype=ctypes.c_void_p, *args):
    """objc_msgSend with an exact prototype; args are (ctype, value) pairs.

    Apple Silicon requires objc_msgSend to be called through a non-variadic
    prototype that matches the method, so build one for every call."""
    lib = _runtime()
    prototype = ctypes.CFUNCTYPE(restype, ctypes.c_void_p, ctypes.c_void_p, *(t for t, _ in args))
    send = prototype(ctypes.cast(lib.objc_msgSend, ctypes.c_void_p).value)
    return send(receiver, lib.sel_registerName(selector.encode()), *(v for _, v in args))


def hide_dock_icon(platform=None):
    """Run as a menu bar app. Call after QApplication exists, which loads AppKit."""
    if not is_mac(platform): return False
    try:
        app = _send(_runtime().objc_getClass(b'NSApplication'), 'sharedApplication')
        if not app: return False
        return bool(_send(app, 'setActivationPolicy:', ctypes.c_bool, (ctypes.c_long, ACCESSORY)))
    except (OSError, AttributeError, ValueError, TypeError):
        return False


def float_window(widget, platform=None, qpa=None):
    """Keep an overlay window on every Space, over full-screen apps, and shown
    while another app is active. Qt can recreate the native window when its
    flags change, so call this each time the window is shown."""
    if not is_mac(platform): return False
    # Only Cocoa's winId() is an NSView*. Under the offscreen platform the tests
    # run on, it's a placeholder, and messaging that address kills the process.
    if (_platform_name() if qpa is None else qpa) != 'cocoa': return False
    try:
        view = int(widget.winId())  # an NSView* on macOS
        if not view: return False
        window = _send(view, 'window')
        if not window: return False
        _send(window, 'setCollectionBehavior:', None, (ctypes.c_ulong, OVERLAY_BEHAVIOR))
        _send(window, 'setHidesOnDeactivate:', None, (ctypes.c_bool, False))
        return True
    except (OSError, AttributeError, ValueError, TypeError):
        return False
