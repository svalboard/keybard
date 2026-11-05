"""
Browser test: Keybard shows what the board reported, or less, never a stand-in value.
The built app (test-site build), the simulated boards, no keyboard. Run with
`npm run test:e2e:no-guess`.

  1. ?fakeBoard=unread, a board that doesn't answer the QMK settings or two custom
     values (left DPI, natural scroll), and holds a tap dance with a term of 0:
     - Settings > Typing behavior says the settings weren't read (no fields, no zeros).
     - Pointing Devices: Left DPI reads "Not read" (nothing selected), Natural Scroll
       has neither ON nor OFF pressed and says "Not read". Choosing ON still writes
       it: a pending change under Manual Updates, written at once under Live Updating.
     - Tap dance 1 shows 0 ms, flagged as too short, and nothing is written for it.
  2. Firmware before the updater (the firmware harness, &proto=0): the card names no
     half ("Plugged-in half"), and Install by hand says "either half's U port", then
     "the other half", with no half named and no usual half.
  3. Confirm on your keyboard: the chord is shown by key position, the lit keys carry
     no letters.
  4. The pointing pills (?demo=pointing): no number unless the board reports the
     factors, and before any hand moves, every drawn device carries them.
  Each screen: light and dark, desktop and phone width, no sideways scroll, and the
  text this change adds at WCAG AA contrast (4.5:1).

Same server options as tapdance_term_e2e.py (E2E_URL, E2E_DIST, E2E_SKIP_BUILD).
Exits 1 when a check fails.
"""
import os
import re
import sys
import tempfile

# The firmware harness (?fwfake) ships only in development and test-site builds.
os.environ.setdefault("VITE_STORAGE_NAMESPACE", "keybard-test")
os.environ.setdefault("E2E_DIST", os.path.join(tempfile.gettempdir(), "keybard-e2e-no-guess"))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import expect, sync_playwright  # noqa: E402

from tapdance_term_e2e import app_url, close_editor, open_tapdance, on_screen  # noqa: E402

DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 430, "height": 932}

# The contrast of an element's text against the first opaque background behind it.
CONTRAST_JS = """(el) => {
    // Through a canvas, so any CSS color (oklch too) comes back as sRGB.
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgb = (s) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#0000'; ctx.fillStyle = s; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const fg = rgb(getComputedStyle(el).color);
    let bg = null;
    for (let n = el; n; n = n.parentElement) {
        const c = rgb(getComputedStyle(n).backgroundColor);
        if (c.a > 0.5) { bg = c; break; }
    }
    bg ??= { r: 255, g: 255, b: 255 };
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
}"""

WIDE_JS = "() => document.documentElement.scrollWidth > innerWidth + 1"


def main() -> int:
    failures = []

    def check(ok: bool, what: str):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    def readable(locator, what: str):
        el = locator.first
        if not el.count():
            check(False, f"{what}: not on the page")
            return
        ratio = el.evaluate(CONTRAST_JS)
        check(ratio >= 4.5, f"{what}: contrast {ratio:.2f}:1 (AA needs 4.5)")

    def one_line(page, what: str):
        check(not page.evaluate(WIDE_JS), f"{what}: no sideways scroll")

    def open_page(browser, url, query, theme, viewport=DESKTOP, settings=None):
        context = browser.new_context(viewport=viewport, color_scheme=theme, reduced_motion="reduce")
        if settings:
            import json
            context.add_init_script(f"try {{ localStorage.setItem('keybard-test:keyboard-settings', {json.dumps(json.dumps(settings))}); localStorage.setItem('keyboard-settings', {json.dumps(json.dumps(settings))}); }} catch {{}}")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{url}{query}&theme={theme}")
        return context, page, errors

    def wait_board(page):
        page.locator("[data-keycap]:visible").first.wait_for(timeout=60000)
        expect(page.get_by_text("Editing keyboard: Simulated Svalboard").first).to_be_visible(timeout=60000)

    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()

        # 1. A board that doesn't answer some reads.
        for theme in ("light", "dark"):
            for vp_name, vp in (("desktop", DESKTOP), ("phone", PHONE)):
                label = f"unread board, {theme}, {vp_name}"
                context, page, errors = open_page(browser, url, "?fakeBoard=unread&panel=typing", theme, vp)
                try:
                    note = page.get_by_test_id("qmk-settings-not-read")
                    expect(note).to_be_visible(timeout=60000)
                    check(note.inner_text().startswith("Keybard couldn't read these settings"), f"{label}: Typing behavior says the settings weren't read")
                    check(page.get_by_role("spinbutton", name="Tapping Term").count() == 0, f"{label}: no setting field stands in for them")
                    readable(note, f"{label}: the not-read line")
                    one_line(page, f"{label}: Typing behavior")
                except Exception as e:
                    check(False, f"{label}: {str(e).splitlines()[0]}")
                check(not errors, f"{label}: no page errors {errors[:2]}")
                context.close()

        for live in (False, True):
            for theme in ("light", "dark"):
                label = f"unread pointing values, {'Live Updating' if live else 'Manual Updates'}, {theme}"
                context, page, errors = open_page(browser, url, "?fakeBoard=unread&panel=pointing", theme, settings={"live-updating": live, "theme": theme})
                try:
                    wait_board(page)
                    dpi = page.get_by_role("combobox", name="DPI").first
                    expect(dpi).to_be_visible(timeout=30000)
                    check(dpi.inner_text().strip() == "Not read", f"{label}: Left DPI says Not read ({dpi.inner_text().strip()!r})")
                    readable(dpi.locator("span").first, f"{label}: the DPI Not read text")
                    group = page.get_by_role("group", name="Natural Scroll").first
                    group.scroll_into_view_if_needed()
                    on, off = group.get_by_role("button", name="ON", exact=True), group.get_by_role("button", name="OFF", exact=True)
                    check(on.get_attribute("aria-pressed") == "false" and off.get_attribute("aria-pressed") == "false", f"{label}: Natural Scroll has neither side pressed")
                    row = group.locator("xpath=..")
                    note = row.locator("[data-not-read]")
                    check(note.count() == 1, f"{label}: Natural Scroll says Not read")
                    readable(note, f"{label}: the toggle's Not read text")
                    one_line(page, f"{label}: Pointing Devices")
                    on.click()
                    page.wait_for_timeout(800)
                    if live:
                        written = page.evaluate("() => window.keybardFakeBoard.device.firmware.state.custom[7 * 2]")
                        check(written == 1, f"{label}: ON is written at once ({written})")
                    else:
                        apply = page.get_by_role("button", name=re.compile(r"^Apply \d+ Changes?"))
                        check(apply.count() >= 1, f"{label}: ON is a pending change")
                    check(on.get_attribute("aria-pressed") == "true", f"{label}: ON shows once chosen")
                except Exception as e:
                    check(False, f"{label}: {str(e).splitlines()[0]}")
                check(not errors, f"{label}: no page errors {errors[:2]}")
                context.close()

        for theme in ("light", "dark"):
            for bottom in (False, True):
                label = f"tap dance term 0, {theme}, {'bottom bar' if bottom else 'sidebar'}"
                context, page, errors = open_page(browser, url, "?fakeBoard=unread", theme, settings={"theme": theme, "panel-position": "bottombar" if bottom else "sidebar"})
                try:
                    wait_board(page)
                    page.get_by_text("Tap Dance Keys").first.click()
                    page.wait_for_timeout(500)
                    term = open_tapdance(page, 1)
                    check(term.input_value() == "0", f"{label}: the term the board holds ({term.input_value()!r}), not 200")
                    flag = [f for f in on_screen(page.get_by_test_id("tapdance-term-unusable"))]
                    check(len(flag) == 1 and "0 ms is too short" in flag[0].inner_text(), f"{label}: flagged as too short")
                    if flag:
                        readable(flag[0], f"{label}: the flag")
                    one_line(page, f"{label}")
                    term_now = page.evaluate("() => { const t = window.keybardFakeBoard.device.firmware.state.tapDance; return t[18] | (t[19] << 8); }")
                    check(term_now == 0, f"{label}: nothing written for it ({term_now})")
                    close_editor(page, 1)
                except Exception as e:
                    check(False, f"{label}: {str(e).splitlines()[0]}")
                check(not errors, f"{label}: no page errors {errors[:2]}")
                context.close()

        # 2. Firmware before the updater: the hand isn't known.
        for theme in ("light", "dark"):
            for vp_name, vp in (("desktop", DESKTOP), ("phone", PHONE)):
                label = f"firmware with no hand, {theme}, {vp_name}"
                context, page, errors = open_page(browser, url, "?demo&fwfake=1&panel=firmware&proto=0&running=vLaunch2&speed=20", theme, vp)
                try:
                    section = page.get_by_test_id("firmware-section")
                    halves = section.get_by_test_id("firmware-halves")
                    expect(halves).to_be_visible(timeout=30000)
                    check("Plugged-in half" in halves.inner_text() and not re.search(r"Left half|Right half|plugged in", halves.inner_text()), f"{label}: the card names no half ({halves.inner_text()!r})")
                    section.get_by_role("button", name=re.compile(r"^(Update to|Install) Unstable firmware x4")).first.click()
                    dialog = page.get_by_test_id("manual-install")
                    expect(dialog).to_be_visible(timeout=20000)
                    steps = [li.inner_text() for li in dialog.get_by_test_id("manual-steps").locator("li").all()]
                    check(bool(steps) and steps[0].startswith("Plug the USB cable into either half's U port"), f"{label}: the first step names no half ({steps[:1]})")
                    check(len(steps) > 3 and steps[3].startswith("Then the other half:"), f"{label}: then the other half ({steps[3:4]})")
                    check(not re.search(r"left half|right half|usual half", dialog.inner_text(), re.I), f"{label}: no half named, no usual half")
                    one_line(page, f"{label}: Install by hand")
                except Exception as e:
                    check(False, f"{label}: {str(e).splitlines()[0]}")
                check(not errors, f"{label}: no page errors {errors[:2]}")
                context.close()

        # 3. The update chord by position.
        for theme in ("light", "dark"):
            label = f"confirm chord, {theme}"
            context, page, errors = open_page(browser, url, "?demo&fwfake=1&panel=firmware&speed=4", theme, PHONE)
            try:
                section = page.get_by_test_id("firmware-section")
                expect(section.get_by_text("Unstable firmware x4 is available")).to_be_visible(timeout=30000)
                section.get_by_role("button", name="Update to Unstable firmware x4").click()
                sheet = page.get_by_test_id("update-sheet")
                expect(sheet.get_by_text("Saved to Downloads")).to_be_visible(timeout=20000)
                sheet.get_by_role("button", name="Update", exact=True).click()
                confirm = page.get_by_test_id("update-confirm")
                expect(confirm).to_be_visible(timeout=20000)
                diagram = confirm.get_by_test_id("chord-diagram")
                check(diagram.inner_text().strip() == "", f"{label}: the lit keys carry no letters ({diagram.inner_text()!r})")
                lit = [k.get_attribute("data-chord-key") for k in diagram.locator("[data-chord-key]").all()]
                check(sorted(lit) == ["index south", "middle south"], f"{label}: index south and middle south are lit ({lit})")
                check("press the south keys of your index and middle fingers" in confirm.inner_text(), f"{label}: names the keys by position")
                readable(confirm.locator("p", has_text="press the south keys"), f"{label}: the instruction")
                one_line(page, label)
            except Exception as e:
                check(False, f"{label}: {str(e).splitlines()[0]}")
            check(not errors, f"{label}: no page errors {errors[:2]}")
            context.close()

        # 4. The pointing pills.
        cases = [
            ("no factors reported", "&sniper=1&boost=1&motion=0", "SNIPER | BOOST", "SNIPER | BOOST"),
            ("factors reported", "&sniper=1&boost=1&motion=0&sniperDiv=3&boostX=5", "SNIPER ×0.33 | BOOST ×5", "SNIPER ×0.33 | BOOST ×5"),
            ("after the left hand moves", "&sniper=1&hand=left", "SNIPER", ""),
        ]
        for theme in ("light", "dark"):
            for name, query, left, right in cases:
                label = f"pills, {name}, {theme}"
                context, page, errors = open_page(browser, url, f"?demo=pointing&left=trackball&right=trackball{query}", theme)
                try:
                    dev = lambda side: page.locator(f"[data-pointing-device={side}]").first  # noqa: E731
                    expect(dev("left")).to_be_visible(timeout=30000)
                    page.wait_for_timeout(1500)
                    got = (dev("left").get_attribute("data-pills"), dev("right").get_attribute("data-pills"))
                    check(got == (left, right), f"{label}: pills {got}, expected {(left, right)}")
                    one_line(page, label)
                except Exception as e:
                    check(False, f"{label}: {str(e).splitlines()[0]}")
                check(not errors, f"{label}: no page errors {errors[:2]}")
                context.close()

        browser.close()
    print("no guessed state e2e:", "FAILED" if failures else "passed", f"({len(failures)} failed)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
