"""Read-only check that site rules can read the browser's address bar on this computer.

Reads the address bar of the browser window in front (or, if another program is in front, of
the browser window nearest the top) through UI Automation, and prints only its host name and
how long the read took. Never the address, never the title; changes no focus, sends nothing.

    python scripts/probe_address_bar.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from keybard_host.address_bar import BROWSERS, KEEP, make_address_bar  # noqa: E402
from keybard_host.foreground import _Windows  # noqa: E402


def browser_windows(win):
    """Visible top-level browser windows, nearest the top first (EnumWindows is in Z order)."""
    out = []

    def each(hwnd, _):
        if win.user.IsWindowVisible(hwnd) and not win.user.GetWindow(hwnd, win.GW_OWNER) and win.user.GetWindowTextLengthW(hwnd) > 0:
            app = win.app_of_window(hwnd)
            if app and app[0].lower() in BROWSERS: out.append((hwnd, app[0].lower()))
        return True
    win.user.EnumWindows(win.EnumProc(each), 0)
    return out


def main():
    if sys.platform != 'win32': raise SystemExit('Windows only')
    win = _Windows()
    front = win.user.GetForegroundWindow()
    app = win.app_of_window(front) if front else None
    if app and app[0].lower() in BROWSERS:
        targets = [(front, app[0].lower())]
        print(f'In front: {app[0].lower()}')
    else:
        targets = browser_windows(win)[:1]
        print(f'In front: {app[0].lower() if app else "nothing readable"} (not a browser); '
              f'reading the browser window nearest the top instead')
    if not targets: raise SystemExit('No browser window found')
    bar = make_address_bar()
    print(f'Reader: {type(bar).__name__}')
    for hwnd, browser in targets:
        for label in ('first read (finds the address bar)', 'second read (cached)'):
            start = time.perf_counter()
            try: host = bar.host(hwnd, browser)
            except OSError as exc: host = f'failed: {exc.__class__.__name__}'
            ms = (time.perf_counter() - start) * 1000
            shown = 'address bar has the keyboard (kept the last host)' if host == KEEP else host or 'none (not a web page, or not found)'
            print(f'{browser}: host = {shown} · {label}: {ms:.0f} ms')
    bar.close()


if __name__ == '__main__':
    main()
