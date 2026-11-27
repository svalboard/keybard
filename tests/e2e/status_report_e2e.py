"""
Browser tests of Settings > About > Status report against the simulated
Svalboard (?fakeBoard). Run with `npm run test:e2e:status-report`.

  1. About shows a "Status report" row (title, one-line description,
     chevron) after Keybard's own facts; it opens a dialog that reads the
     board at once (Sval 0x3F: the build text, page 1, then the state, page 0)
     and shows the rows in groups: Firmware, Pointing, Auto Mouse, Computer,
     Scanning, Power. Escape closes it and focus goes back to the row; Enter
     on the row opens it again.
  2. Read again shows what changed on the board (Scroll Mode turned on by a
     key on the board, the computer seen as a Mac). Copy says Copied for a
     moment and puts the same report on the clipboard as plain text, starting
     "Svalboard status report".
  3. A board that stops answering: one line, "Couldn't read your keyboard."
     with Try again, which reads it once it answers.
  4. Firmware without the command (?fakeBoard=touchpad-434, ?fakeBoard=old)
     and the example layout show no row and send no 0x3F.
  5. Searching "status report", "board status" or "output status" finds it.
  6. Side panel at 1280, 1920 and 390 px, bottom bar at 1280 and 390 px,
     light and dark: the row and the dialog with no clipped text, nothing
     outside its box, one line per value except the build text, which wraps
     only at its break points, the footer in view, and no sideways page
     scroll. Screenshots of each, and of the Copied and error states
     (E2E_SHOTS, default the system temp folder, keybard-status-report).

E2E_URL and E2E_SKIP_BUILD work as in fake_board_e2e.py. Needs Python
Playwright with Chromium. Exits 1 when a check fails.
"""
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import expect, sync_playwright  # noqa: E402

ROW = "#settings-section-about button[aria-label='Status report']"
DIALOG = "[data-status-report]"
ROWS = "[data-testid=status-report-rows]"
REQUESTS_JS = "() => window.keybardFakeBoard.device.firmware.statusRequests.map(r => r.join(':'))"
FAILS_JS = "(on) => { window.keybardFakeBoard.device.firmware.statusFails = on; }"
SHOTS = os.environ.get("E2E_SHOTS", os.path.join(tempfile.gettempdir(), "keybard-status-report"))
GROUPS = ["Firmware", "Pointing", "Auto Mouse", "Computer", "Scanning", "Power"]
BUILD = "svalboard/either:sval @ x4.6.7-fake"
MICRO = "µs"


def settings_init(position: str) -> str:
    stored = {"panel-position": position, "settings-about-open": "open"}
    return (f"(() => {{ const extra = {json.dumps(stored)}; for (const k of Object.keys(localStorage).concat(['keyboard-settings']))"
            " if (/keyboard-settings$/.test(k)) { const v = JSON.parse(localStorage.getItem(k) || '{}');"
            " Object.assign(v, extra); localStorage.setItem(k, JSON.stringify(v)); } })()")


def open_page(browser, url, board="fakeBoard", viewport=(1280, 900), scheme="light", position="sidebar", query="panel=settings"):
    context = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, color_scheme=scheme, reduced_motion="reduce")
    context.add_init_script(settings_init(position))
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{url}?{board}&{query}&theme={scheme}" if board else f"{url}?{query}&theme={scheme}")
    if board:
        wait_connected(page)
    expect(page.get_by_label("Search settings")).to_be_visible(timeout=30000)
    return context, page, errors


def open_dialog(page):
    row = page.locator(ROW)
    expect(row).to_be_visible(timeout=10000)
    row.click()
    expect(page.locator(DIALOG)).to_be_visible(timeout=5000)
    expect(page.locator(ROWS)).to_be_visible(timeout=5000)


def value(page, label):
    return page.locator(f"{ROWS} dt", has_text=re.compile(f"^{re.escape(label)}$")).first.locator("xpath=following-sibling::dd[1]").inner_text()


def flow_read(browser, url):
    context, page, errors = open_page(browser, url)
    row = page.locator(ROW)
    expect(row).to_be_visible(timeout=10000)
    expect(row).to_contain_text("Firmware and settings, to share with support")
    expect(row).to_contain_text("›")
    assert page.evaluate(REQUESTS_JS) == [], "read before the dialog opened"
    # About: Keybard's facts first, then the row.
    order = page.evaluate("""(sel) => { const about = document.querySelector('#settings-section-about');
        const k = about.querySelector('dl[aria-label=Keybard]'), s = about.querySelector(sel);
        return !!(k.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); }""", ROW)
    assert order, "the row is not after Keybard's facts"
    open_dialog(page)
    expect(page.get_by_role("dialog", name="Status report")).to_be_visible()
    for g in GROUPS:
        expect(page.locator(ROWS).get_by_role("region", name=g)).to_be_visible()
    reqs = page.evaluate(REQUESTS_JS)
    assert reqs[0] == "1:0" and reqs[-1] == "0:0", f"reads {reqs}"
    assert value(page, "Build") == BUILD, value(page, "Build")
    assert value(page, "Detected OS") == "Windows"
    assert value(page, "Wait before read").endswith(" " + MICRO), value(page, "Wait before read")
    page.keyboard.press("Escape")
    expect(page.locator(DIALOG)).to_have_count(0)
    focused = page.evaluate("() => document.activeElement && document.activeElement.getAttribute('aria-label')")
    assert focused == "Status report", f"focus after close: {focused}"
    # Keyboard only: Enter on the row opens it again, and reads again.
    before = len(page.evaluate(REQUESTS_JS))
    page.keyboard.press("Enter")
    expect(page.locator(ROWS)).to_be_visible(timeout=5000)
    assert len(page.evaluate(REQUESTS_JS)) > before, "opening again didn't read"
    assert not errors, errors
    context.close()
    print("ok   the row opens the dialog, which reads the board; Escape closes it and focus returns")


def flow_read_again_copy(browser, url):
    context, page, errors = open_page(browser, url)
    context.grant_permissions(["clipboard-read", "clipboard-write"])
    open_dialog(page)
    was_on = value(page, "Left Scroll Mode") == "On"
    want = "Off" if was_on else "On"
    # A Scroll Mode key on the board, and a Mac plugged in: Keybard's own cache doesn't know.
    page.evaluate(f"() => {{ const fw = window.keybardFakeBoard.device.firmware; fw.state.custom[2] = {0 if was_on else 1}; fw.hostOs = 3; }}")
    before = len(page.evaluate(REQUESTS_JS))
    page.get_by_test_id("status-report-read").click()
    expect(page.locator(f"{ROWS} dd", has_text="macOS")).to_be_visible(timeout=5000)
    assert value(page, "Left Scroll Mode") == want, value(page, "Left Scroll Mode")
    assert len(page.evaluate(REQUESTS_JS)) > before
    copy = page.get_by_test_id("status-report-copy")
    copy.click()
    expect(copy).to_have_text("Copied", timeout=3000)
    text = page.evaluate("() => navigator.clipboard.readText()").replace(chr(13), "")  # Windows clipboards use CRLF
    assert text.startswith(f"Svalboard status report\n\nFirmware\nBuild: {BUILD}"), text[:120]
    assert "Detected OS: macOS" in text and f"Left Scroll Mode: {want}" in text, text
    assert MICRO in text and " us\n" not in text, "microseconds"
    for g in GROUPS:
        assert f"\n{g}\n" in text, f"no {g} heading in the copy"
    expect(copy).to_have_text("Copy", timeout=4000)
    assert not errors, errors
    context.close()
    print("ok   Read again shows the board's changes; Copy says Copied and copies the report")


def flow_failure(browser, url):
    context, page, errors = open_page(browser, url)
    page.evaluate(FAILS_JS, True)
    page.locator(ROW).click()
    err = page.get_by_test_id("status-report-error")
    expect(err).to_contain_text("Couldn't read your keyboard.", timeout=5000)
    assert page.locator(ROWS).count() == 0
    expect(page.get_by_test_id("status-report-copy")).to_be_disabled()
    page.evaluate(FAILS_JS, False)
    page.get_by_test_id("status-report-read").click()
    expect(page.locator(ROWS)).to_be_visible(timeout=5000)
    expect(err).to_have_count(0)
    assert not errors, errors
    context.close()
    print("ok   a failed read is one line with Try again")


def flow_not_shown(browser, url):
    for board in ("fakeBoard=touchpad-434", "fakeBoard=old"):
        context, page, errors = open_page(browser, url, board=board)
        expect(page.locator("#settings-section-about")).to_be_visible()
        page.wait_for_timeout(500)
        assert page.locator(ROW).count() == 0, f"{board}: shown"
        assert page.evaluate(REQUESTS_JS) == [], f"{board}: sent 0x3F"
        assert not errors, errors
        context.close()
    context, page, errors = open_page(browser, url, board="", query="demo=combos&panel=settings")
    page.wait_for_timeout(500)
    assert page.locator(ROW).count() == 0, "example layout: shown"
    context.close()
    print("ok   not shown on older firmware or the example layout")


def flow_search(browser, url):
    context, page, errors = open_page(browser, url)
    search = page.get_by_label("Search settings")
    for words in ("status report", "board status", "output status"):
        search.fill(words)
        expect(page.locator(ROW)).to_be_visible(timeout=5000)
    context.close()
    print("ok   search finds it")


CLIP_JS = """(sel) => { const root = document.querySelector(sel); const box = root.getBoundingClientRect(); const bad = [];
    for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || el.closest('.sr-only')) continue;
        const cs = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') bad.push('scrolls: ' + el.textContent.slice(0, 40));
        if (r.right > box.right + 1 || r.left < box.left - 1) bad.push('outside: ' + el.textContent.slice(0, 40));
        if (el.children.length === 0 && el.textContent && el.scrollWidth > el.clientWidth + 1) bad.push('clipped: ' + el.textContent.slice(0, 40));
    }
    return { bad, page: document.documentElement.scrollWidth, vw: innerWidth }; }"""

# The build text wraps only where breakable() lets it: a new line starts after "/", ":" or a space, or at a "-".
BUILD_WRAP_JS = """(sel) => { const dd = [...document.querySelectorAll(sel + ' dt')].find(d => d.textContent === 'Build').nextElementSibling;
    const text = dd.textContent, range = document.createRange(), starts = [];
    let top = null, pos = 0, node;
    const walker = document.createTreeWalker(dd, NodeFilter.SHOW_TEXT);
    while ((node = walker.nextNode())) {
        for (let i = 0; i < node.length; i++) {
            range.setStart(node, i); range.setEnd(node, i + 1);
            const r = range.getClientRects()[0];
            if (!r || !r.width) continue;
            if (top !== null && r.top > top + 2) starts.push(pos + i);
            top = r.top;
        }
        pos += node.length;
    }
    return starts.filter(i => !('/: '.includes(text[i - 1]) || text[i] === '-')).map(i => text.slice(Math.max(0, i - 3), i + 3)); }"""

LAYOUTS = [("sidebar", 1280), ("sidebar", 1920), ("sidebar", 390), ("bottombar", 1280), ("bottombar", 390)]


def check_box(page, sel, where):
    r = page.evaluate(CLIP_JS, sel)
    assert not r["bad"], f"{where}: {r['bad'][:5]}"
    assert r["page"] <= r["vw"] + 1, f"{where}: page scrolls sideways"


def flow_layout(browser, url):
    os.makedirs(SHOTS, exist_ok=True)
    for position, width in LAYOUTS:
        for scheme in ("light", "dark"):
            where = f"{position}-{width}-{scheme}"
            context, page, errors = open_page(browser, url, viewport=(width, 844 if width < 400 else 900), scheme=scheme, position=position)
            context.grant_permissions(["clipboard-read", "clipboard-write"])
            expect(page.locator(ROW)).to_be_visible(timeout=10000)
            page.locator("#settings-section-about").evaluate("e => e.scrollIntoView({ block: 'start' })")
            page.wait_for_timeout(250)
            check_box(page, "#settings-section-about", f"{where} About")
            page.screenshot(path=os.path.join(SHOTS, f"{where}-row.png"))
            open_dialog(page)
            page.wait_for_timeout(300)
            check_box(page, DIALOG, f"{where} dialog")
            tall = page.evaluate("""(sel) => [...document.querySelectorAll(sel + ' dd')].filter(d => {
                const lh = parseFloat(getComputedStyle(d).lineHeight); return d.getBoundingClientRect().height > lh * 1.5; })
                .map(d => d.previousElementSibling.textContent)""", ROWS)
            assert [t for t in tall if t != "Build"] == [], f"{where}: values wrap: {tall}"
            bad_breaks = page.evaluate(BUILD_WRAP_JS, ROWS)
            assert bad_breaks == [], f"{where}: build text breaks mid-word: {bad_breaks}"
            # The footer stays in view while the rows scroll.
            for tid in ("status-report-read", "status-report-copy"):
                b = page.get_by_test_id(tid).bounding_box()
                assert b and b["y"] + b["height"] <= page.viewport_size["height"] + 1, f"{where}: {tid} below the fold"
            page.screenshot(path=os.path.join(SHOTS, f"{where}-dialog.png"))
            if position == "sidebar" and width in (1280, 390):
                page.get_by_test_id("status-report-copy").click()
                expect(page.get_by_test_id("status-report-copy")).to_have_text("Copied", timeout=3000)
                page.screenshot(path=os.path.join(SHOTS, f"{where}-copied.png"))
                page.evaluate(FAILS_JS, True)
                page.keyboard.press("Escape")
                expect(page.locator(DIALOG)).to_have_count(0)
                page.locator(ROW).click()
                expect(page.get_by_test_id("status-report-error")).to_be_visible(timeout=5000)
                page.wait_for_timeout(300)
                check_box(page, DIALOG, f"{where} error")
                page.screenshot(path=os.path.join(SHOTS, f"{where}-error.png"))
            assert not errors, errors
            context.close()
    print(f"ok   no clipped text in the row or the dialog, {len(LAYOUTS)} layouts, light and dark ({SHOTS})")


def main():
    failures = 0
    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for flow in (flow_read, flow_read_again_copy, flow_failure, flow_not_shown, flow_search, flow_layout):
                try:
                    flow(browser, url)
                except Exception as e:  # noqa: BLE001
                    failures += 1
                    print(f"FAIL {flow.__name__}: {e}")
        finally:
            browser.close()
    print("all status report flows pass" if not failures else f"{failures} flows failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
