"""
Browser tests of the mouse key settings against the simulated Svalboard
(?fakeBoard), whose firmware stores values as sent, like firmware before the
limits (so these checks prove Keybard itself never sends a value that wraps).
Run with `npm run test:e2e:mouse-limits`.

  1. Mouse Keys > Movement shows no Step size (QMK builds it in) and each
     value's range stops at what the firmware variable holds: 0 - 2550 for
     the delays, 1 - 255 for the cursor interval, 0 - 255 for the others.
  2. Typing 300 in the cursor interval saves 255 to the board (300 used to
     wrap to 44), typing 255 saves 255, and typing 0 in the wheel interval
     saves 0 (the fastest value stays allowed).
  3. Importing a layout with a cursor interval of 300 and a wheel delay of
     10000 shows them in the replaced-settings note as 255 and 2550, with no
     release link, and applying writes 255 and 2550.
  4. Layout: Movement fits at phone and desktop widths, light and dark, with
     no sideways scroll.

E2E_URL and E2E_SKIP_BUILD work as in fake_board_e2e.py. Needs Python
Playwright with Chromium. Exits 1 when a check fails.
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

UID = int("4829f621f27d181b", 16)
ROWS, COLS = 10, 6
# Byte offsets of the mouse key values in the simulated board's settings block.
OFFSET = {9: 4, 10: 6, 12: 10, 13: 12, 14: 14, 15: 16, 16: 18, 17: 20}
TITLES = {
    9: "Delay between pressing a movement key and cursor movement",
    10: "Time between cursor movements in milliseconds",
    12: "Maximum cursor speed at which acceleration stops",
    13: "Time until maximum cursor speed is reached",
    14: "Delay between pressing a wheel key and wheel movement",
    15: "Time between wheel movements",
    16: "Maximum number of scroll steps per scroll action",
    17: "Time until maximum scroll speed is reached",
}
RANGES = {9: "0 - 2550", 10: "1 - 255", 12: "0 - 255", 13: "0 - 255", 14: "0 - 2550", 15: "0 - 255", 16: "0 - 255", 17: "0 - 255"}


def open_page(browser, url, viewport=(1440, 900), scheme="light"):
    context = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, color_scheme=scheme,
                                  reduced_motion="reduce")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{url}?fakeBoard&theme={scheme}")
    wait_connected(page)
    return context, page, errors


def stored(page: Page, qsid: int) -> int:
    o = OFFSET[qsid]
    return page.evaluate(f"(() => {{ const s = window.keybardFakeBoard.device.firmware.state.qmkSettings; return s[{o}] | (s[{o + 1}] << 8); }})()")


def open_movement(page: Page):
    page.get_by_role("button", name="Mouse Keys", exact=True).first.click()
    heading = page.get_by_role("heading", name="Movement")
    expect(heading).to_be_visible(timeout=15000)
    heading.scroll_into_view_if_needed()
    return page.locator("section[aria-labelledby='mouse-movement-heading']")


def type_value(page: Page, section, qsid: int, value: str):
    field = section.get_by_role("spinbutton", name=TITLES[qsid])
    field.scroll_into_view_if_needed()
    field.fill(value)
    field.press("Enter")
    page.wait_for_timeout(600)


def flow_ranges(browser, url):
    context, page, errors = open_page(browser, url)
    section = open_movement(page)
    expect(section.get_by_role("spinbutton", name="Step size")).to_have_count(0)
    expect(section.get_by_text("Step size")).to_have_count(0)
    for qsid, title in TITLES.items():
        row = section.get_by_role("spinbutton", name=title)
        expect(row).to_have_count(1)
        expect(section.get_by_text(f"Range: {RANGES[qsid]}")).not_to_have_count(0)
    assert not errors, errors
    context.close()


def flow_typing(browser, url):
    context, page, errors = open_page(browser, url)
    section = open_movement(page)
    type_value(page, section, 10, "300")
    assert stored(page, 10) == 255, stored(page, 10)
    expect(section.get_by_role("spinbutton", name=TITLES[10])).to_have_value("255")
    type_value(page, section, 10, "255")
    assert stored(page, 10) == 255, stored(page, 10)
    type_value(page, section, 10, "25")
    assert stored(page, 10) == 25, stored(page, 10)
    type_value(page, section, 15, "0")
    assert stored(page, 15) == 0, stored(page, 15)
    type_value(page, section, 9, "2560")
    assert stored(page, 9) == 2550, stored(page, 9)
    assert not errors, errors
    context.close()


def flow_import(browser, url):
    context, page, errors = open_page(browser, url)
    text = json.dumps({
        "version": 1, "uid": UID, "svil_protocol": 3, "via_protocol": 13,
        "layout": [[["KC_NO"] * COLS for _ in range(ROWS)]],
        "settings": {"10": 300, "14": 10000, "15": 80},
    })
    path = os.path.join(tempfile.mkdtemp(prefix="kb-mouse-"), "old-mouse.svil")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    page.goto(page.url.split("?")[0] + "?fakeBoard&panel=settings")
    wait_connected(page)
    page.locator("input[type=file][accept*='.svil']").first.set_input_files(path)
    dialog = page.get_by_role("dialog", name="Review layout import")
    expect(dialog).to_be_visible(timeout=15000)
    note = dialog.get_by_test_id("settings-replaced")
    items = sorted(t.strip() for t in note.get_by_role("listitem").all_inner_texts())
    assert items == ["Delay between pressing a wheel key and wheel movement: 10000 → 2550",
                     "Time between cursor movements in milliseconds: 300 → 255"], items
    expect(note.get_by_role("link")).to_have_count(0)
    dialog.get_by_role("button", name="Apply import").click()
    expect(dialog).to_have_count(0, timeout=20000)
    page.wait_for_timeout(800)
    assert (stored(page, 10), stored(page, 14), stored(page, 15)) == (255, 2550, 80), (stored(page, 10), stored(page, 14))
    assert not errors, errors
    context.close()


def flow_layout(browser, url):
    for scheme in ("light", "dark"):
        for viewport in ((390, 844), (1440, 900)):
            context, page, errors = open_page(browser, url, viewport=viewport, scheme=scheme)
            section = open_movement(page)
            fits = section.evaluate("e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && e.scrollWidth <= e.clientWidth + 1; }")
            assert fits, f"{scheme} {viewport[0]}px: Movement overflows"
            sideways = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
            assert not sideways, f"{scheme} {viewport[0]}px: the page scrolls sideways"
            assert not errors, errors
            context.close()


def main() -> int:
    flows = [
        ("1. no Step size; each range stops at the firmware variable's limit", flow_ranges),
        ("2. typed values above the limit save the limit; 0 wheel interval stays", flow_typing),
        ("3. an imported value above the limit is held at it and listed", flow_import),
        ("4. Movement fits at phone and desktop widths, light and dark", flow_layout),
    ]
    failed = 0
    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        print(f"Testing {url}")
        for label, flow in flows:
            try:
                flow(browser, url)
                print(f"PASS {label}")
            except Exception as error:  # noqa: BLE001 - report every flow
                failed += 1
                lines = str(error).strip().splitlines() or [repr(error)]
                print(f"FAIL {label}\n     {lines[0]}")
                print("     " + "\n     ".join(lines[1:12]))
        browser.close()
    print(f"{len(flows) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
