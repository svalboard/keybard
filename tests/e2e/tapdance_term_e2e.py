"""
Browser test of tap dance terms as a person meets them: the built app, a
layout file loaded from the connect screen, no keyboard. Run with
`npm run test:e2e:tap-dance`.

  1. Load a .svil whose tap dance 0 is stored off with a term of 0 ms (what an
     unused slot reads back as), and tap dance 1 has a term of 350 ms.
  2. Tap dance 0 opens with a term of 200 ms, and the editor has no on/off
     switch.
  3. A term below 20 ms is saved as 20 (Enter); a usable term is kept (blur);
     Escape drops an unsaved edit.
  4. Tap dance 1 keeps its 350 ms.
  5. All of it in the sidebar and the bottom bar layouts, light and dark.

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
EXAMPLE = os.path.join(ROOT, "src", "default-layouts", "sval-default.svil")


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


def layout_file(folder: str) -> str:
    """The QWERTY Example with tap dance 0 stored off at 0 ms and tap dance 1 at 350 ms."""
    with open(EXAMPLE, encoding="utf-8") as f:
        svil = json.load(f)
    svil["tap_dance"][0].update(on=False, on_tap="KC_A", on_hold="KC_LSFT", tapping_term=0)
    svil["tap_dance"][1].update(on=True, on_tap="KC_B", tapping_term=350)
    path = os.path.join(folder, "tap-dance-terms.svil")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(svil, f)
    return path


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


def open_layout(browser, url: str, path: str, theme: str, bottom_bar: bool):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
    # The theme as Settings saves it.
    # Builds whose editor has no layout buttons keep the panel position in Settings > Appearance.
    stored = {"theme": theme, "panel-position": "bottombar" if bottom_bar else "sidebar"}
    context.add_init_script(
        f"try {{ localStorage.setItem('keyboard-settings', {json.dumps(json.dumps(stored))}); }} catch {{}}")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    expect(page.get_by_text("QWERTY Example").first).to_be_visible(timeout=20000)
    page.locator("input[type=file]").first.set_input_files(path)
    expect(page.get_by_text("Tap Dance Keys").first).to_be_visible(timeout=20000)
    if page.evaluate("document.documentElement.classList.contains('dark')") != (theme == "dark"):
        raise AssertionError(f"the page is not in the {theme} theme")
    layout_button = page.get_by_role("button", name="Bottom bar layout" if bottom_bar else "Sidebar layout")
    if layout_button.count():
        layout_button.click()
    page.get_by_text("Tap Dance Keys").first.click()
    page.wait_for_timeout(500)
    return context, page, errors


def open_tapdance(page: Page, idx: int):
    """Opens a tap dance's editor from the Tap Dance Keys panel; returns its term field."""
    # The bottom bar shows a card per tap dance, titled with its name; the
    # sidebar a row per slot, led by its number.
    keys = on_screen(page.get_by_text(f"Tap Dance {idx}", exact=True))         or [k for k in on_screen(page.get_by_text(str(idx), exact=True)) if k.bounding_box()["y"] > 140]
    if not keys:
        raise AssertionError(f"tap dance {idx} is not in the Tap Dance Keys panel")
    keys[0].click()
    # "Tap Dance Key 0", or "Editing Tap Dance 0" where the panel itself becomes the editor.
    expect(title(page, idx)).to_be_visible(timeout=10000)
    page.wait_for_timeout(500)  # the editor slides in
    fields = on_screen(page.locator("input[type=number]"))
    if len(fields) != 1:
        raise AssertionError(f"tap dance {idx}: {len(fields)} term fields in the editor, not 1")
    return fields[0]


def title(page: Page, idx: int):
    return page.get_by_text(re.compile(rf"^(Tap Dance Key|Editing Tap Dance) {idx}$")).filter(visible=True).first


def close_editor(page: Page, idx: int = 0):
    close = page.get_by_role("button", name="Close binding editor")
    if close.count() and close.first.is_visible():
        close.first.click()
    else:  # the panel-as-editor's back arrow, beside the title
        title(page, idx).locator("xpath=ancestor::*[.//button][1]").get_by_role("button").first.click()
    page.wait_for_timeout(500)


def run_flow(page: Page, where: str, failures: list):
    def check(ok: bool, what: str):
        if not ok:
            failures.append(f"{where}: {what}")

    term = open_tapdance(page, 0)
    check(term.input_value() == "200", f"tap dance 0 stored at 0 ms opens at {term.input_value()!r} ms, not 200")
    check(not on_screen(page.get_by_text("Enabled", exact=True)), "the editor still shows Enabled")
    check(not on_screen(page.get_by_role("button", name="OFF", exact=True)), "the editor still has an OFF switch")

    term.fill("5")
    term.press("Enter")
    page.wait_for_timeout(300)
    check(term.input_value() == "20", f"5 ms was saved as {term.input_value()!r}, not the 20 ms minimum")

    term.fill("275")
    term.blur()
    check(term.input_value() == "275", f"275 ms was saved as {term.input_value()!r}")

    term.fill("999")
    term.press("Escape")
    check(term.input_value() == "275", f"Escape kept the unsaved edit ({term.input_value()!r})")

    close_editor(page, 0)
    term = open_tapdance(page, 1)
    check(term.input_value() == "350", f"tap dance 1 reads {term.input_value()!r} ms, not its 350")
    close_editor(page, 1)
    term = open_tapdance(page, 0)
    check(term.input_value() == "275", f"tap dance 0 reopened at {term.input_value()!r} ms, not the 275 saved")


def main() -> int:
    failures = []
    with tempfile.TemporaryDirectory() as folder, app_url() as url, sync_playwright() as p:
        path = layout_file(folder)
        browser = p.chromium.launch()
        for theme in ("light", "dark"):
            for bottom_bar in (False, True):
                where = f"{theme}, {'bottom bar' if bottom_bar else 'sidebar'}"
                context, page, errors = open_layout(browser, url, path, theme, bottom_bar)
                try:
                    run_flow(page, where, failures)
                    failures.extend(f"{where}: page error: {e}" for e in errors)
                except Exception as e:  # a step that could not run is a failure, not a crash
                    failures.append(f"{where}: {str(e).splitlines()[0]}")
                finally:
                    context.close()
        browser.close()
    for f in failures:
        print("FAIL", f)
    print("tap dance term e2e:", "FAILED" if failures else "passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
