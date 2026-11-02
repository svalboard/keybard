"""
Browser test of the Scroll key row as a person uses it: the built app, the
QWERTY Example, no keyboard. Run with `npm run test:e2e:scroll-keys`.

  1. Add a tap dance, and pick its Tap key from Pointing Devices: the Scroll
     row has one key per scroll key, each reading its label (Drag Scroll, Vel Scroll,
     Vel Scroll Toggle).
  2. At Normal and Medium key sizes each label fits its key face. (At Small,
     30px keys, the word "Scroll" is wider than the key; the label is still
     checked to be there.)
  3. All of it in the sidebar and the bottom bar layouts, light and dark.

It builds the app (vite build, base /keybard-e2e/) into a temporary folder
and serves it with vite preview. Set E2E_URL to test a server that is already
running (its full base URL), and E2E_DIST to build into (and with
E2E_SKIP_BUILD=1 reuse) a folder of your choice. Needs Python Playwright with
Chromium:
  pip install playwright && python -m playwright install chromium
Exits 1 when a check fails.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from contextlib import contextmanager

from playwright.sync_api import Page, expect, sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE_PATH = "/keybard-e2e/"
NPX = shutil.which("npx") or "npx"
# The Scroll row's keys, in order, by the label each shows on its key face.
SCROLL_KEYS = ["Drag Scroll", "Vel Scroll", "Vel Scroll Toggle"]
# Key sizes (the editor's size buttons) at which every label must fit its key.
FIT_SIZES = ["Normal", "Medium"]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextmanager
def app_url():
    if os.environ.get("E2E_URL"):
        yield os.environ["E2E_URL"].rstrip("/") + "/"
        return
    out_dir = os.environ.get("E2E_DIST") or os.path.join(tempfile.gettempdir(), "keybard-e2e-dist")
    if not os.environ.get("E2E_SKIP_BUILD"):
        subprocess.run([NPX, "vite", "build", f"--base={BASE_PATH}", f"--outDir={out_dir}", "--emptyOutDir"],
                       cwd=ROOT, check=True)
    port = free_port()
    server = subprocess.Popen(
        [NPX, "vite", "preview", f"--base={BASE_PATH}", f"--outDir={out_dir}", "--host", "127.0.0.1",
         "--port", str(port), "--strictPort"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}{BASE_PATH}"
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(url, timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError(f"vite preview did not start at {url}")
        yield url
    finally:
        # The whole tree on Windows (npx -> cmd -> node -> esbuild), as fake_board_e2e.stop_server does.
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(server.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


def on_screen(locator):
    """The matches inside the viewport (panels keep off-screen copies for their slide-in)."""
    page = locator.page
    width = page.viewport_size["width"]
    out = []
    for i in range(locator.count()):
        el = locator.nth(i)
        box = el.bounding_box() if el.is_visible() else None
        if box and box["x"] >= 0 and box["x"] + box["width"] <= width:
            out.append(el)
    return out


def open_example(browser, url: str, theme: str, bottom_bar: bool, size: str):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
    # The theme as Settings saves it.
    # Builds whose editor has no layout and size buttons keep both in Settings > Appearance.
    stored = {"theme": theme, "panel-position": "bottombar" if bottom_bar else "sidebar",
              "key-size": {"Normal": "default", "Medium": "medium", "Small": "small"}[size]}
    context.add_init_script(
        f"try {{ localStorage.setItem('keyboard-settings', {json.dumps(json.dumps(stored))}); }} catch {{}}")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.get_by_text("QWERTY Example").first.click()
    expect(page.get_by_text("Tap Dance Keys").first).to_be_visible(timeout=20000)
    if page.evaluate("document.documentElement.classList.contains('dark')") != (theme == "dark"):
        raise AssertionError(f"the page is not in the {theme} theme")
    layout_button = page.get_by_role("button", name="Bottom bar layout" if bottom_bar else "Sidebar layout")
    if layout_button.count():
        layout_button.click()
        page.get_by_role("button", name=re.compile(f"^{size}$", re.I)).click()
    return context, page, errors


def open_pointing_picker(page: Page):
    """Opens tap dance 0 (adding it where the list is empty) and the Pointing Devices picker for its Tap key."""
    page.get_by_text("Tap Dance Keys").first.click()
    add = page.get_by_title("Add new tap dance")
    expect(add.or_(page.get_by_text("0", exact=True)).first).to_be_visible(timeout=10000)
    if add.count() and add.first.is_visible():
        add.first.click()
    else:
        on_screen(page.get_by_text("0", exact=True))[0].click()
    # The editor's title: "Tap Dance Key 0", or "Editing Tap Dance 0" where the
    # panel itself becomes the editor and the rail picks the keys.
    expect(page.get_by_text(re.compile(r"^(Tap Dance Key|Editing Tap Dance) 0$")).first).to_be_visible(timeout=10000)
    page.wait_for_timeout(700)  # the picker slides in
    buttons = on_screen(page.get_by_role("button", name="Pointing Devices"))
    tabs = [t for t in buttons if t.bounding_box()["x"] > 230] or buttons
    if not tabs:
        raise AssertionError("no Pointing Devices tab in the binding editor's picker")
    tabs[-1].click()
    expect(page.get_by_text("Scroll", exact=True).first).to_be_visible(timeout=10000)


def check_scroll_row(page: Page, where: str, must_fit: bool, failures: list):
    for label in SCROLL_KEYS:
        faces = on_screen(page.get_by_text(label, exact=True))
        if len(faces) != 1:
            failures.append(f"{where}: {len(faces)} keys reading {label!r} in the Pointing Devices picker, not 1")
            continue
        if not must_fit:
            continue
        fit = faces[0].evaluate("""(t) => {
            const key = t.closest('.cursor-pointer') || t.parentElement;
            const r = t.getBoundingClientRect(), k = key.getBoundingClientRect();
            return { text: t.innerText, clipped: t.scrollWidth > t.clientWidth + 1
                || r.left < k.left - 1 || r.right > k.right + 1 || r.top < k.top - 1 || r.bottom > k.bottom + 1 };
        }""")
        if fit["clipped"]:
            failures.append(f"{where}: {label!r} does not fit its key face ({fit['text']!r})")


def main() -> int:
    failures = []
    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in ("light", "dark"):
            for bottom_bar in (False, True):
                for size in FIT_SIZES + ["Small"]:
                    where = f"{theme}, {'bottom bar' if bottom_bar else 'sidebar'}, {size}"
                    context, page, errors = open_example(browser, url, theme, bottom_bar, size)
                    try:
                        open_pointing_picker(page)
                        check_scroll_row(page, where, size in FIT_SIZES, failures)
                        failures.extend(f"{where}: page error: {e}" for e in errors)
                    except Exception as e:  # a step that could not run is a failure, not a crash
                        failures.append(f"{where}: {str(e).splitlines()[0]}")
                    finally:
                        context.close()
        browser.close()
    for f in failures:
        print("FAIL", f)
    print("scroll keys e2e:", "FAILED" if failures else "passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
