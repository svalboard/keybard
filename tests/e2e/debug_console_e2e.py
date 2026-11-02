"""
Browser tests of Settings > About > Debug console against the simulated
Svalboard (?fakeBoard). Run with `npm run test:e2e:debug-console`.

  1. With Live Updating on, and again with Manual Updates (Live Updating off):
     About shows "Debug console" with one line ("Lasts until the board is
     unplugged."), Off as the board reads it. On goes to the board at once
     (Sval 0x3E op 1, then a read), the row shows the board's read-back, and
     nothing becomes a pending change; Off the same.
  2. A board that starts again (a reload: the simulated board starts over, as
     at a power-up) reads Off.
  3. Firmware without the command (?fakeBoard=touchpad-434, ?fakeBoard=old)
     and the example layout (no board) show no row and send no 0x3E, and
     searching a word only that row has finds nothing.
  4. Searching "debug" or "console" finds the row.
  5. The row's switch sits beside its label at 1440 and 390 px, light and
     dark, in the side panel and the bottom bar, with no sideways scroll; its
     line of text stays on one line at 1440.

E2E_URL and E2E_SKIP_BUILD work as in fake_board_e2e.py. Needs Python
Playwright with Chromium. Exits 1 when a check fails.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

ROW = "[data-debug-console]"
LINE = "Lasts until the board is unplugged."
PENDING_JS = r"""() => [...document.querySelectorAll('button')].some(b => /^(Pending \(|Apply \d+ Change)/.test(b.textContent.trim()))"""
REQUESTS_JS = "() => [...window.keybardFakeBoard.device.firmware.debugRequests]"
FLAG_JS = "() => window.keybardFakeBoard.device.firmware.debugEnable"


def settings_init(live: bool, position: str = "sidebar") -> str:
    stored = {"live-updating": live, "panel-position": position, "settings-about-open": "open"}
    return (f"(() => {{ const extra = {json.dumps(stored)}; for (const k of Object.keys(localStorage).concat(['keyboard-settings']))"
            " if (/keyboard-settings$/.test(k)) { const v = JSON.parse(localStorage.getItem(k) || '{}');"
            " Object.assign(v, extra); localStorage.setItem(k, JSON.stringify(v)); } })()")


def open_page(browser, url: str, board: str = "fakeBoard", live: bool = True, viewport=(1440, 900), scheme="light",
              position="sidebar", query="panel=settings"):
    context = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, color_scheme=scheme,
                                  reduced_motion="reduce")
    context.add_init_script(settings_init(live, position))
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{url}?{board}&{query}&theme={scheme}" if board else f"{url}?{query}&theme={scheme}")
    if board:
        wait_connected(page)
    expect(page.get_by_label("Search settings")).to_be_visible(timeout=30000)
    return context, page, errors


def state(page: Page) -> str:
    return page.locator(f"{ROW} [data-debug-console-state]").get_attribute("data-debug-console-state")


def wait_state(page: Page, want: str):
    expect(page.locator(f"{ROW} [data-debug-console-state='{want}']")).to_be_visible(timeout=5000)


def flow_toggle(browser, url, live: bool):
    mode = "Live Updating" if live else "Manual Updates"
    context, page, errors = open_page(browser, url, live=live)
    row = page.locator(ROW)
    expect(row).to_be_visible(timeout=10000)
    expect(row.get_by_text("Debug console", exact=True)).to_be_visible()
    expect(row.get_by_text(LINE, exact=True)).to_be_visible()
    wait_state(page, "off")
    assert page.evaluate(REQUESTS_JS) == [2], f"{mode}: first read {page.evaluate(REQUESTS_JS)}"

    row.get_by_role("button", name="ON").click()
    wait_state(page, "on")
    assert page.evaluate(FLAG_JS) is True, f"{mode}: the board is not on"
    assert page.evaluate(REQUESTS_JS) == [2, 1, 2], f"{mode}: on {page.evaluate(REQUESTS_JS)}"
    assert row.get_by_role("button", name="ON").get_attribute("aria-pressed") == "true"
    assert not page.evaluate(PENDING_JS), f"{mode}: on became a pending change"

    row.get_by_role("button", name="OFF").click()
    wait_state(page, "off")
    assert page.evaluate(FLAG_JS) is False, f"{mode}: the board is not off"
    assert page.evaluate(REQUESTS_JS) == [2, 1, 2, 0, 2], f"{mode}: off {page.evaluate(REQUESTS_JS)}"
    assert not page.evaluate(PENDING_JS), f"{mode}: off became a pending change"
    assert row.get_by_role("alert").count() == 0
    assert not errors, errors
    context.close()
    print(f"ok   {mode}: written at once and read back, never pending")


def flow_restart(browser, url):
    context, page, errors = open_page(browser, url)
    page.locator(ROW).get_by_role("button", name="ON").click()
    wait_state(page, "on")
    page.reload()
    wait_connected(page)
    wait_state(page, "off")
    assert page.evaluate(FLAG_JS) is False
    assert not errors, errors
    context.close()
    print("ok   a board that starts again reads Off")


def flow_not_shown(browser, url):
    for board in ("fakeBoard=touchpad-434", "fakeBoard=old"):
        context, page, errors = open_page(browser, url, board=board)
        expect(page.locator("#settings-section-about")).to_be_visible()
        page.wait_for_timeout(500)
        assert page.locator(ROW).count() == 0, f"{board}: row shown"
        assert page.evaluate(REQUESTS_JS) == [], f"{board}: sent 0x3E"
        # Search never finds the hidden row: a word only it has finds nothing.
        page.get_by_label("Search settings").fill("logging")
        expect(page.get_by_text("Nothing in Settings matches")).to_be_visible(timeout=5000)
        assert not errors, errors
        context.close()
    context, page, errors = open_page(browser, url, board="", query="demo=combos&panel=settings")
    page.wait_for_timeout(500)
    assert page.locator(ROW).count() == 0, "example layout: row shown"
    context.close()
    print("ok   no row on older firmware or the example layout")


def flow_search(browser, url):
    context, page, errors = open_page(browser, url)
    search = page.get_by_label("Search settings")
    for word in ("debug", "console"):
        search.fill(word)
        expect(page.locator(ROW)).to_be_visible(timeout=5000)
    search.fill("")
    context.close()
    print("ok   search finds it")


def flow_layout(browser, url):
    for position in ("sidebar", "bottombar"):
        for width in (1440, 390):
            for scheme in ("light", "dark"):
                context, page, errors = open_page(browser, url, viewport=(width, 900), scheme=scheme, position=position)
                row = page.locator(ROW)
                row.scroll_into_view_if_needed()
                expect(row).to_be_visible(timeout=10000)
                wait_state(page, "off")
                box = page.evaluate("""(sel) => { const r = document.querySelector(sel);
                    const label = [...r.querySelectorAll('span')].find(s => s.textContent === 'Debug console').getBoundingClientRect();
                    const line = [...r.querySelectorAll('span')].find(s => s.textContent.startsWith('Lasts')).getBoundingClientRect();
                    const sw = r.querySelector('[role=group]').getBoundingClientRect();
                    const lh = parseFloat(getComputedStyle([...r.querySelectorAll('span')].find(s => s.textContent.startsWith('Lasts'))).lineHeight);
                    return { label, line, sw, lh, page: document.documentElement.scrollWidth, vw: innerWidth }; }""", ROW)
                where = f"{position} {width} {scheme}"
                # Label and switch on one row: the switch beside the text, not under it.
                assert box["sw"]["left"] > box["label"]["right"], f"{where}: switch not beside the label"
                assert box["sw"]["top"] < box["line"]["bottom"], f"{where}: switch below the text"
                # The line of text on one line at desktop width (a phone may wrap it, like every row).
                assert width < 1000 or box["line"]["height"] <= box["lh"] * 1.5, f"{where}: the line wraps ({box['line']['height']})"
                assert box["page"] <= box["vw"] + 1, f"{where}: page scrolls sideways"
                assert not errors, errors
                context.close()
    print("ok   switch beside the label at 1440 and 390, light and dark, side panel and bottom bar; one line at 1440")


def main():
    failures = 0
    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for flow in (lambda: flow_toggle(browser, url, True), lambda: flow_toggle(browser, url, False),
                         lambda: flow_restart(browser, url), lambda: flow_not_shown(browser, url),
                         lambda: flow_search(browser, url), lambda: flow_layout(browser, url)):
                try:
                    flow()
                except Exception as e:  # noqa: BLE001
                    failures += 1
                    print(f"FAIL {e}")
        finally:
            browser.close()
    print("all debug console flows pass" if not failures else f"{failures} flows failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
