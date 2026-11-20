"""The host name of the page in the browser in front, for site rules (app rules for a website).

Windows: the browser's address bar through UI Automation (the accessibility interface screen
readers use), so no browser extension is needed. Chrome, Edge, Brave, Vivaldi and Firefox.
macOS: Safari and the Chromium-based browsers are asked for their front tab through Apple Events
(osascript), once the person allows it, per browser (MacAddressBar).
Linux: browsers offer no way without an extension; a site rule's browser counts as the program.

Privacy: only the host name ("cad.onshape.com") leaves this module, never the address, and
nothing here logs or keeps it. The caller keeps only the site rule it matched.

The reads are cross-process calls into the browser and can stall when the browser is busy, so
they run on one thread of their own and the caller never waits (see TimedReader).
"""
import ctypes
import re
import subprocess
import sys
import threading
import time

# Browsers whose address bar we read, by program key (foreground.app_key): Chromium-based ones
# name the address bar's edit box first in their tree; Firefox's has the automation ID urlbar-input.
CHROMIUM = frozenset(('chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe'))
FIREFOX = frozenset(('firefox.exe',))
# macOS, by bundle ID (lowered): Safari has its own words for the front tab; the rest are Chromium.
MAC_SAFARI = frozenset(('com.apple.safari', 'com.apple.safaritechnologypreview'))
MAC_CHROMIUM = frozenset((
    'com.google.chrome', 'com.google.chrome.beta', 'com.google.chrome.dev', 'com.google.chrome.canary',
    'com.microsoft.edgemac', 'com.microsoft.edgemac.beta', 'com.microsoft.edgemac.dev',
    'com.brave.browser', 'com.brave.browser.beta', 'company.thebrowser.browser', 'com.vivaldi.vivaldi',
    'org.chromium.chromium'))
BROWSERS = CHROMIUM | FIREFOX | MAC_SAFARI | MAC_CHROMIUM

KEEP = 'keep'  # the address bar has the keyboard: the person is typing, so keep the last host

_SCHEME = re.compile(r'^([a-z][a-z0-9+.-]*):(//)?', re.I)


def host_of_address(text):
    """The host name in an address bar's text, lowercased (ASCII only; an IDN stays as the browser
    shows it), without port or user. None for search text, a browser page (chrome://) or a file."""
    text = (text or '').strip()
    if not text or any(c.isspace() for c in text): return None
    match = _SCHEME.match(text)
    if match and not match.group(2) and text[match.end():match.end() + 1].isdigit(): match = None  # host:port
    if match:
        if match.group(1).lower() not in ('http', 'https') or not match.group(2): return None
        text = text[match.end():]
    host = re.split(r'[/?#\\]', text, maxsplit=1)[0]
    host = host.rsplit('@', 1)[-1]
    if host.startswith('['): return None  # an IPv6 address: no site rule names one
    host = host.split(':', 1)[0].rstrip('.')
    host = ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in host)
    return host if host and '.' in host or host == 'localhost' else None


class NoAddressBar:
    """Where the address can't be read (macOS and Linux for now): every browser is its program."""
    def host(self, window, browser): return None
    def forget(self, window): pass
    def close(self): pass


# ---------------------------------------------------------------- Windows: UI Automation

class _GUID(ctypes.Structure):
    _fields_ = [('a', ctypes.c_uint32), ('b', ctypes.c_uint16), ('c', ctypes.c_uint16), ('d', ctypes.c_ubyte * 8)]

    @classmethod
    def of(cls, text):
        h = text.replace('-', '')
        return cls(int(h[:8], 16), int(h[8:12], 16), int(h[12:16], 16), (ctypes.c_ubyte * 8)(*bytes.fromhex(h[16:])))


class _VARIANT(ctypes.Structure):
    class _Value(ctypes.Union):
        _fields_ = [('lVal', ctypes.c_long), ('boolVal', ctypes.c_short), ('ptr', ctypes.c_void_p),
                    ('record', ctypes.c_void_p * 2)]  # makes it 24 bytes on 64-bit, 16 on 32-bit, as VARIANT is
    _fields_ = [('vt', ctypes.c_ushort), ('r1', ctypes.c_ushort), ('r2', ctypes.c_ushort), ('r3', ctypes.c_ushort), ('v', _Value)]


class WindowsAddressBar:
    """IUIAutomation from UIAutomationCore through ctypes (vtable slots from the Windows SDK's
    UIAutomationClient.h). One instance per thread: COM objects stay on the thread that made them."""
    CLSID_CUIAutomation8 = 'e22ad333-b25f-460c-83d0-0581107395c9'
    CLSID_CUIAutomation = 'ff48dba4-60ef-4201-aa87-54103eef594e'
    IID_IUIAutomation2 = '34723aff-0c9d-49d0-9896-7ab52df8cd8a'
    IID_IUIAutomation = '30cbe57d-d9d0-452a-ab13-7ac5ac4825ee'
    # IUIAutomation(2) slots
    ELEMENT_FROM_HANDLE, CREATE_PROPERTY_CONDITION, CREATE_AND_CONDITION = 6, 23, 25
    PUT_CONNECTION_TIMEOUT, PUT_TRANSACTION_TIMEOUT = 61, 63
    # IUIAutomationElement slots
    FIND_FIRST, GET_CURRENT_PROPERTY_VALUE = 5, 10
    RELEASE = 2
    TREE_SCOPE_DESCENDANTS = 4
    CONTROL_TYPE, HAS_KEYBOARD_FOCUS, AUTOMATION_ID, VALUE = 30003, 30008, 30011, 30045
    EDIT = 50004
    VT_I4, VT_BSTR, VT_BOOL = 3, 8, 11
    TIMEOUT_MS = 400  # UI Automation's own limit on one call: a hung browser can't hold the thread long

    def __init__(self):
        if sys.platform != 'win32': raise OSError('UI Automation is Windows only')
        self.ole = ctypes.OleDLL('ole32')
        self.oleaut = ctypes.WinDLL('oleaut32')
        self.oleaut.SysAllocString.restype = ctypes.c_void_p
        self.oleaut.SysAllocString.argtypes = [ctypes.c_wchar_p]
        self.oleaut.VariantClear.argtypes = [ctypes.POINTER(_VARIANT)]
        try: self.ole.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED, as UI Automation clients should be
        except OSError: pass  # already initialized on this thread
        self.uia = ctypes.c_void_p()
        try:
            self.ole.CoCreateInstance(ctypes.byref(_GUID.of(self.CLSID_CUIAutomation8)), None, 1,
                                      ctypes.byref(_GUID.of(self.IID_IUIAutomation2)), ctypes.byref(self.uia))
            self._call(self.uia, self.PUT_CONNECTION_TIMEOUT, (ctypes.c_uint32,), self.TIMEOUT_MS)
            self._call(self.uia, self.PUT_TRANSACTION_TIMEOUT, (ctypes.c_uint32,), self.TIMEOUT_MS)
        except OSError:
            self.uia = ctypes.c_void_p()
            self.ole.CoCreateInstance(ctypes.byref(_GUID.of(self.CLSID_CUIAutomation)), None, 1,
                                      ctypes.byref(_GUID.of(self.IID_IUIAutomation)), ctypes.byref(self.uia))
        self.conditions = {}
        self.elements = {}  # window handle -> its address bar element

    @staticmethod
    def _call(obj, slot, argtypes, *args):
        vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        method = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, *argtypes)(vtable[slot])
        return method(obj, *args)

    def _release(self, obj):
        if obj: ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(
            ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents[self.RELEASE])(obj)

    def _condition(self, prop, vt, value):
        variant = _VARIANT(vt=vt)
        bstr = None
        if vt == self.VT_I4: variant.v.lVal = value
        else: bstr = variant.v.ptr = self.oleaut.SysAllocString(value)
        out = ctypes.c_void_p()
        try: self._call(self.uia, self.CREATE_PROPERTY_CONDITION, (ctypes.c_long, _VARIANT, ctypes.POINTER(ctypes.c_void_p)),
                        prop, variant, ctypes.byref(out))
        finally:
            if bstr: self.oleaut.VariantClear(ctypes.byref(variant))
        return out

    def condition(self, browser):
        kind = 'firefox' if browser in FIREFOX else 'chromium'
        if kind not in self.conditions:
            edit = self._condition(self.CONTROL_TYPE, self.VT_I4, self.EDIT)
            if kind == 'firefox':
                ident = self._condition(self.AUTOMATION_ID, self.VT_BSTR, 'urlbar-input')
                both = ctypes.c_void_p()
                self._call(self.uia, self.CREATE_AND_CONDITION, (ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)),
                           edit, ident, ctypes.byref(both))
                self._release(edit); self._release(ident)
                edit = both
            self.conditions[kind] = edit
        return self.conditions[kind]

    def _property(self, element, prop):
        variant = _VARIANT()
        self._call(element, self.GET_CURRENT_PROPERTY_VALUE, (ctypes.c_long, ctypes.POINTER(_VARIANT)), prop, ctypes.byref(variant))
        try:
            if variant.vt == self.VT_BSTR: return ctypes.wstring_at(variant.v.ptr) if variant.v.ptr else ''
            if variant.vt == self.VT_BOOL: return variant.v.boolVal != 0
            return None
        finally: self.oleaut.VariantClear(ctypes.byref(variant))

    def _find(self, window, browser):
        root = ctypes.c_void_p()
        self._call(self.uia, self.ELEMENT_FROM_HANDLE, (ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)), window, ctypes.byref(root))
        if not root: return None
        try:
            found = ctypes.c_void_p()
            self._call(root, self.FIND_FIRST, (ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)),
                       self.TREE_SCOPE_DESCENDANTS, self.condition(browser), ctypes.byref(found))
            return found if found else None
        finally: self._release(root)

    def host(self, window, browser):
        """The host name in this browser window's address bar, KEEP while the person types in it,
        or None (not found, or not a web page). Raises OSError when UI Automation fails."""
        for attempt in range(2):
            element = self.elements.get(window)
            if element is None:
                element = self._find(window, browser)
                if element is None: return None
                if len(self.elements) >= 32: self.forget(next(iter(self.elements)))
                self.elements[window] = element
            try:
                if self._property(element, self.HAS_KEYBOARD_FOCUS): return KEEP
                return host_of_address(self._property(element, self.VALUE))
            except OSError:
                self.forget(window)  # the browser rebuilt its toolbar: find the box again, once
                if attempt: raise
        return None

    def forget(self, window):
        element = self.elements.pop(window, None)
        if element is not None: self._release(element)

    def close(self):
        for window in list(self.elements): self.forget(window)
        for condition in self.conditions.values(): self._release(condition)
        self.conditions.clear()
        if self.uia: self._release(self.uia); self.uia = ctypes.c_void_p()


# ---------------------------------------------------------------- macOS: Apple Events

_BUNDLE_ID = re.compile(r'^[A-Za-z0-9.-]+$')
NOT_PERMITTED = '-1743'  # errAEEventNotPermitted: the person said no


def front_tab_script(bundle_id):
    """The AppleScript that asks a browser (by bundle ID, already in front) for its front tab's address."""
    if not bundle_id or not _BUNDLE_ID.match(bundle_id): return None
    lowered = ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in bundle_id)
    tab = 'current tab' if lowered in MAC_SAFARI else 'active tab'
    return f'tell application id "{bundle_id}" to return URL of {tab} of front window'


class MacAddressBar:
    """Asks the browser in front for its front tab's address through osascript. A browser the person
    said no to counts as its program until the Host restarts (macOS won't ask again anyway).
    Untested on a Mac."""
    TIMEOUT = 1.5

    def __init__(self, run=None):
        self.run = run or (lambda c: subprocess.run(c, capture_output=True, text=True, timeout=self.TIMEOUT))
        self.denied = set()

    def host(self, window, browser):
        key = (browser or '').lower()
        if key in self.denied: return None
        script = front_tab_script(browser)
        if not script: return None
        try: done = self.run(['/usr/bin/osascript', '-e', script])
        except (OSError, subprocess.SubprocessError): return None
        if done.returncode != 0:
            if NOT_PERMITTED in (done.stderr or ''): self.denied.add(key)
            return None
        return host_of_address(done.stdout)

    def forget(self, window): pass
    def close(self): pass


def make_address_bar(platform=None):
    platform = platform or sys.platform
    if platform == 'win32':
        try: return WindowsAddressBar()
        except (OSError, AttributeError, ValueError): return NoAddressBar()
    if platform == 'darwin': return MacAddressBar()
    return NoAddressBar()


# ---------------------------------------------------------------- off the caller's thread

class TimedReader:
    """Runs address-bar reads one at a time on a thread of its own. The caller never waits:
    request() starts a read if none is running, and the answer arrives through done(token, host)
    on the reader's thread. A read still running after `timeout` counts as failed (the caller
    falls back to the program), and no new read starts until it ends."""

    def __init__(self, make=make_address_bar, done=None, clock=time.monotonic):
        self.make, self.done, self.clock = make, done, clock
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.job = None          # (token, window, browser) waiting to run
        self.busy_since = None   # when the running read started
        self.closing = False
        self.forgotten = set()  # windows closed: drop their elements on the reader's thread
        self.thread = threading.Thread(target=self._run, name='address-bar', daemon=True)
        self.thread.start()

    def busy(self):
        with self.lock: return self.busy_since is not None or self.job is not None

    def stuck(self, timeout):
        """Whether a read has run longer than `timeout` seconds."""
        with self.lock: return self.busy_since is not None and self.clock() - self.busy_since > timeout

    def request(self, token, window, browser):
        """Start a read unless one is running or waiting. Returns whether it was started."""
        with self.lock:
            if self.closing or self.busy_since is not None or self.job is not None: return False
            self.job = (token, window, browser)
        self.wake.set()
        return True

    def forget(self, window):
        with self.lock: self.forgotten.add(window)
        self.wake.set()

    def _run(self):
        reader = None
        while True:
            self.wake.wait(); self.wake.clear()
            with self.lock:
                if self.closing: break
                job, self.job = self.job, None
                forgotten, self.forgotten = self.forgotten, set()
                if job: self.busy_since = self.clock()
            if reader is None:
                try: reader = self.make()
                except Exception: reader = NoAddressBar()  # noqa: BLE001 - never let the thread die
            for window in forgotten: reader.forget(window)
            if not job: continue
            token, window, browser = job
            try: host = reader.host(window, browser)
            except Exception: host = None  # noqa: BLE001 - a failed read is the program, never an error
            with self.lock: self.busy_since = None
            if self.done: self.done(token, host)
        if reader is not None:
            try: reader.close()
            except Exception: pass  # noqa: BLE001

    def close(self):
        with self.lock: self.closing = True
        self.wake.set()
