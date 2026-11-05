"""
Browser tests of Settings > Backups, its own card apart from Firmware, as a person
reaches it. The built app (test-site build, so ?fwfake=1 backs Firmware with the mock
board) against the simulated Svalboard (?fakeBoard) or the QWERTY Example.
Run with `npm run test:e2e:backups`.

  1. From Settings: the Backups chip opens the Backups card, with the automatic
     backups line, Back up now, the backup folder, the connected board's backup,
     and Import and Export layout.
  2. ?fakeBoard&panel=backups lands on the Backups card, open and in view, with
     Firmware collapsed.
  3. The reset notice's "Other backups" closes the notice and opens Backups.
  4. An "open Backups" request from anywhere (the event the update failures and
     the manual install send) opens Backups while another panel is showing.
  5. The halves-differ banner's Finish update opens Firmware; the Backups card
     right below it opens Backups.
  6. Firmware shows no backup list: no backups, no Back up now, no Import or
     Export, and no line about backups.
  7. An install still takes the automatic backup: the update sheet says it was
     saved before the update, and the layout choice can keep it.
  8. One line: the Backups card at 390 and 1440 px, light and dark: no sideways
     scroll, the title, the automatic backups line's heading and every button
     on one line.

Same server options as combo_editor_e2e.py (E2E_URL, E2E_SKIP_BUILD). E2E_URL must
be a test-site build (VITE_STORAGE_NAMESPACE=keybard-test), e.g.
https://morganvenable.github.io/keybard-test/. SHOT_DIR=path saves screenshots.
Exits 1 when a check fails.
"""
import os
import sys

# The mock firmware board ships only in development and test-site builds.
os.environ.setdefault("VITE_STORAGE_NAMESPACE", "keybard-test")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

CARD = "#settings-section-backups"
FIRMWARE = "#settings-section-firmware"


def open_page(browser, url: str, query: str, scheme="light", viewport=(1440, 900)):
    context = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, color_scheme=scheme,
                                  reduced_motion="reduce")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.dismiss())
    page.goto(f"{url}?{query}&theme={scheme}")
    return context, page, errors


def card_open(page: Page, card: str) -> bool:
    return page.locator(f"{card}-title button").get_attribute("aria-expanded") == "true"


def in_view(page: Page, card: str) -> bool:
    return page.evaluate("""(sel) => {
        const card = document.querySelector(sel);
        let s = card.parentElement; while (s && s.scrollHeight <= s.clientHeight + 2) s = s.parentElement;
        const r = card.getBoundingClientRect(), v = s ? s.getBoundingClientRect() : { top: 0, bottom: innerHeight };
        return r.top >= v.top - 1 && r.top < v.bottom - 20;
    }""", card)


def expect_backups_open(page: Page, label: str):
    expect(page.locator(CARD)).to_be_visible(timeout=15000)
    page.wait_for_function("(sel) => document.querySelector(sel + '-title button')?.getAttribute('aria-expanded') === 'true'", arg=CARD, timeout=5000)
    page.wait_for_timeout(600)  # the smooth scroll
    assert in_view(page, CARD), f"{label}: Backups is not in view"
    expect(page.locator(f"{CARD} [data-testid='backups-status']")).to_be_visible()


def flow_from_settings(browser, url):
    context, page, errors = open_page(browser, url, "fakeBoard&panel=settings")
    wait_connected(page)
    expect(page.get_by_label("Search settings")).to_be_visible(timeout=20000)
    assert not card_open(page, CARD), "Backups is open on a first visit"
    page.get_by_role("navigation", name="Settings sections").get_by_role("button", name="Backups", exact=True).click()
    expect_backups_open(page, "chip")
    card = page.locator(CARD)
    expect(card.get_by_test_id("backups-status")).to_contain_text("Automatic backups")
    expect(card.get_by_test_id("backups-status")).to_contain_text("before a firmware update")
    expect(card.get_by_role("button", name="Back up now")).to_be_visible()
    expect(card.get_by_text("Backup folder", exact=True)).to_be_visible()
    expect(card.get_by_test_id("backup-row").first).to_be_visible(timeout=15000)
    expect(card.get_by_text("Saved when the keyboard connected").first).to_be_visible()
    expect(card.get_by_text("Import layout", exact=True)).to_be_visible()
    expect(card.get_by_text("Export layout", exact=True)).to_be_visible()
    card.get_by_role("button", name="Back up now").click()
    expect(card.get_by_role("status").filter(has_text="Saved Today")).to_be_visible(timeout=5000)
    assert not errors, errors
    context.close()


def flow_deep_link(browser, url):
    context, page, errors = open_page(browser, url, "fakeBoard&panel=backups")
    wait_connected(page)
    expect_backups_open(page, "?panel=backups")
    assert not card_open(page, FIRMWARE), "Firmware opened with Backups"
    assert not errors, errors
    context.close()


def flow_reset_notice(browser, url):
    context, page, errors = open_page(browser, url, "demo&fwfake=1&resetnotice=1")
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_role("button", name="Other backups")).to_be_visible(timeout=30000)
    dialog.get_by_role("button", name="Other backups").click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect_backups_open(page, "reset notice")
    assert not errors, errors
    context.close()


def flow_event(browser, url):
    context, page, errors = open_page(browser, url, "fakeBoard")
    wait_connected(page)
    page.get_by_role("button", name="Combos", exact=True).first.click()
    expect(page.locator(CARD)).to_have_count(0)
    page.evaluate("window.dispatchEvent(new CustomEvent('keybard:open-backups'))")
    expect_backups_open(page, "open-backups request")
    assert not errors, errors
    context.close()


def flow_banner(browser, url):
    # The banner shows for a connected board: the simulated one, with the mock firmware board halves differing.
    context, page, errors = open_page(browser, url, "fakeBoard&fwfake=1&differ=1")
    banner = page.get_by_role("alert", name="Halves differ")
    expect(banner).to_be_visible(timeout=30000)
    banner.get_by_role("button", name="Finish update").click()
    expect(page.locator(FIRMWARE)).to_be_visible(timeout=15000)
    page.wait_for_function("(sel) => document.querySelector(sel + '-title button')?.getAttribute('aria-expanded') === 'true'", arg=FIRMWARE, timeout=5000)
    # Firmware says nothing about backups: the Backups card sits right below it.
    expect(page.locator(f"{FIRMWARE} [data-testid='firmware-backups-link']")).to_have_count(0)
    page.locator(f"{CARD}-title button").click()
    expect_backups_open(page, "banner, then the Backups card below Firmware")
    assert not errors, errors
    context.close()


def flow_firmware_has_no_backups(browser, url):
    context, page, errors = open_page(browser, url, "demo&fwfake=1&panel=firmware")
    fw = page.locator(FIRMWARE)
    expect(fw.get_by_test_id("firmware-section")).to_be_visible(timeout=30000)
    expect(fw.locator("h4")).to_have_text("Firmware")
    for gone in ("[data-testid='backups']", "[data-testid='backup-row']", "[data-testid='backups-status']"):
        expect(fw.locator(gone)).to_have_count(0)
    expect(fw.get_by_role("button", name="Back up now")).to_have_count(0)
    expect(fw.get_by_text("Import layout")).to_have_count(0)
    expect(fw.get_by_text("Export layout")).to_have_count(0)
    expect(fw.get_by_test_id("firmware-backups-link")).to_have_count(0)
    expect(fw.get_by_role("button", name="Open Backups")).to_have_count(0)
    assert not errors, errors
    context.close()


def flow_install_backs_up(browser, url):
    context, page, errors = open_page(browser, url, "demo&fwfake=1&panel=firmware&speed=4")
    section = page.get_by_test_id("firmware-section")
    expect(section.get_by_text("Unstable firmware x4 is available")).to_be_visible(timeout=30000)
    section.get_by_role("button", name="Update to Unstable firmware x4").click()
    sheet = page.get_by_test_id("update-sheet")
    expect(sheet.get_by_text("Saved to Downloads just now, before the update, as")).to_be_visible(timeout=20000)
    expect(sheet.get_by_text(".svil")).to_be_visible()
    assert sheet.get_by_role("radio", name="Restore my layout").is_checked(), "the layout choice doesn't keep the backup"
    expect(sheet.get_by_test_id("backups")).to_have_count(0)
    assert not errors, errors
    context.close()


# Lines of text an element shows: distinct line tops of its text, not its box height.
ONE_LINE_JS = """(sels) => sels.flatMap((sel) => [...document.querySelectorAll(sel)].filter((el) => el.offsetParent)).map((el) => {
    const tops = new Set(), walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(t);
        for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top / 4));
    }
    return { text: el.textContent.trim().slice(0, 50), lines: tops.size };
}).filter((r) => r.lines > 1)"""


def flow_layout(browser, url, shots=None):
    for width, height in ((390, 844), (1440, 900)):
        for scheme in ("light", "dark"):
            label = f"{width} {scheme}"
            context, page, errors = open_page(browser, url, "fakeBoard&panel=backups", scheme=scheme, viewport=(width, height))
            wait_connected(page)
            expect_backups_open(page, label)
            expect(page.locator(f"{CARD} [data-testid='backup-row']").first).to_be_visible(timeout=15000)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), f"{label}: sideways scroll"
            card = page.locator(CARD).bounding_box()
            assert card and card["x"] >= 0 and card["x"] + card["width"] <= width + 1, f"{label}: card {card}"
            wrapped = page.evaluate(ONE_LINE_JS, [f"{CARD} h4 button > span", f"{CARD} [data-testid='backups-status'] > span > span:first-child", f"{CARD} [data-slot='button']"])
            assert not wrapped, f"{label}: wrapped {wrapped}"
            bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
            dark = page.evaluate("document.documentElement.classList.contains('dark')")
            assert dark == (scheme == "dark"), f"{label}: theme is not {scheme}"
            if shots:
                page.locator(CARD).screenshot(path=os.path.join(shots, f"backups-card-{width}-{scheme}.png"))
            assert bg, label
            assert not errors, errors
            context.close()


def main() -> int:
    shots = os.environ.get("SHOT_DIR")
    if shots:
        os.makedirs(shots, exist_ok=True)
    flows = [
        ("1. the Backups chip in Settings opens Backups with its list, folder, import and export", flow_from_settings),
        ("2. ?panel=backups lands on Backups, Firmware collapsed", flow_deep_link),
        ("3. the reset notice's Other backups opens Backups", flow_reset_notice),
        ("4. an open-Backups request opens Backups from another panel", flow_event),
        ("5. the halves-differ banner opens Firmware; Backups is right below", flow_banner),
        ("6. Firmware shows no backup list", flow_firmware_has_no_backups),
        ("7. an install still takes the automatic backup", flow_install_backs_up),
        ("8. the Backups card on one line at 390 and 1440 px, light and dark", lambda b, u: flow_layout(b, u, shots)),
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
