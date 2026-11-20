"""
Visual check of the App Layers panel against the simulated Svalboard, each in light and dark:
  narrow     a 640px window with the side panel forced (?panelPosition=sidebar): it shrinks to fit
  threshold  a 900px window, the narrowest that puts the panel in the sidebar on its own
  default    1440px; wide 1920px (the side panel is at most 32rem, 512px)
  bottombar  the bottom bar
 Three rules: a long program name, a long website, and a rule that is off.
Fails when any text in the panel is cut off (app_rules_e2e.CLIPPED_JS).

Run with `npm run test:e2e:app-layers-visual`. E2E_SHOTS=<dir> saves <width>-<theme>.png there.
E2E_URL and E2E_SKIP_BUILD work as in fake_board_e2e.py. Exits 1 when a check fails.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app_rules_e2e import CLIPPED_JS  # noqa: E402
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import expect, sync_playwright  # noqa: E402

SHOTS = os.environ.get("E2E_SHOTS")
FW = "window.keybardFakeBoard.device.firmware"
LONG_PROGRAM = "SolidWorksPDMExplorerEnterprise.exe"
LONG_SITE = "documentation.practice.svalboard.com"
# name, viewport, panel position (None: Keybard's own choice)
LAYOUTS = [
    ("narrow", (640, 900), "sidebar"),
    ("threshold", (900, 900), None),
    ("default", (1440, 900), None),
    ("wide", (1920, 1080), None),
    ("bottombar", (1440, 900), "bottombar"),
]


def main() -> int:
    failures: list[str] = []

    def check(ok: bool, what: str):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)

    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in ("light", "dark"):
            for name, (w, h), position in LAYOUTS:
                bottom = position == "bottombar"
                context = browser.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce", color_scheme=theme)
                page = context.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                extra = f"&panelPosition={position}" if position else ""
                page.goto(f"{url}?fakeBoard&theme={theme}&panel=app-layers{extra}")
                wait_connected(page)
                section = page.locator("[data-app-rules]")
                expect(section).to_be_visible(timeout=20000)
                add = section.get_by_role("button", name="Add rule")

                add.click()
                r = section.locator("[data-app-rule='0']")
                r.get_by_test_id("app-rule-key").fill(LONG_PROGRAM)
                r.get_by_test_id("app-rule-default").select_option("1")
                r.get_by_test_id("app-rule-front").select_option("2")
                r.locator("[data-app-rule-pills] [data-layer='3']").click()

                add.click()
                r = section.locator("[data-app-rule='1']")
                r.get_by_test_id("app-rule-kind").select_option("site")
                r.get_by_test_id("app-rule-site").fill(LONG_SITE)
                r.get_by_test_id("app-rule-front").select_option("3")

                add.click()
                r = section.locator("[data-app-rule='2']")
                r.get_by_test_id("app-rule-key").fill("notepad.exe")
                r.get_by_test_id("app-rule-default").select_option("4")
                r.get_by_role("group", name="Rule 3").get_by_role("button", name="OFF").click()

                page.wait_for_function(f"{FW}.state.appRules[1] === 3", timeout=5000)
                page.mouse.move(0, 0)
                page.wait_for_timeout(300)
                clipped = section.evaluate(CLIPPED_JS)
                check(not clipped, f"{name} {theme} ({w}px): nothing cut off {clipped}")
                if not bottom:
                    check(page.locator(".detail-panel.bottom-panel").count() == 0, f"{name} {theme}: in the sidebar")
                    width = page.locator(".detail-panel").evaluate("e => e.getBoundingClientRect().width")
                    print(f"     side panel {width:.0f}px wide")
                if SHOTS:
                    path = os.path.join(SHOTS, f"{name}-{theme}.png")
                    if bottom:
                        page.screenshot(path=path)
                    else:
                        panel = page.locator(".detail-panel")
                        box = panel.bounding_box()
                        page.screenshot(path=path, clip={"x": 0, "y": 0, "width": box["x"] + box["width"] + 8, "height": h})
                check(not errors, f"{name} {theme}: no page errors {errors}")
                context.close()
        browser.close()

    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
