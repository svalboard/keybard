"""
Browser flow of the Auto Mouse Layer setting against the simulated Svalboard
(?fakeBoard=pointing, firmware with VIA 63 and 64). Headless, 1440 x 900.
Run with `npm run test:e2e:automouse-layers`.

  1. The AutoMouse group shows Auto Mouse Layer, Everywhere chosen, and no layer row.
  2. Only on Selected Layers shows the Off on Layers row; Choose Layers opens the picker:
     one pill per layer but the mouse layer, none marked.
  3. Clicking pills marks them (aria-pressed, struck through); Cancel keeps the board's mask.
  4. Done writes the mask: the row then names the layers the board read back.
  5. Everywhere hides the row; Only on Selected Layers again shows the same layers.
  6. Older firmware (?fakeBoard=old): no Auto Mouse Layer setting at all.

With E2E_SHOTS=<dir>, saves the toggle and the picker in light and dark there.
E2E_URL and E2E_SKIP_BUILD work as in fake_board_e2e.py. Exits 1 when a check fails.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import expect, sync_playwright  # noqa: E402

SHOTS = os.environ.get("E2E_SHOTS")


def main() -> int:
    failures: list[str] = []

    def check(ok: bool, what: str):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in ("light", "dark"):
            context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce",
                                          color_scheme=theme)
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"{url}?fakeBoard=pointing&theme={theme}&panel=pointing-automouse")
            wait_connected(page)
            expect(page.locator("[data-automouse-settings]")).to_be_visible(timeout=20000)
            page.wait_for_timeout(500)
            group = page.locator("[data-automouse-settings]")
            row = page.locator("[data-row='Auto Mouse Layer']")

            # 1.
            check(row.is_visible(), f"{theme}: Auto Mouse Layer setting shown")
            check(row.get_by_role("radio", name="Everywhere").get_attribute("aria-checked") == "true",
                  f"{theme}: Everywhere is the default")
            check(page.locator("[data-automouse-layers-row]").count() == 0, f"{theme}: no layer row under Everywhere")

            # 2.
            row.get_by_role("radio", name="Only on Selected Layers").click()
            expect(page.locator("[data-automouse-layers-row]")).to_be_visible()
            check(True, f"{theme}: Only on Selected Layers shows the layer row")
            if SHOTS:
                group.screenshot(path=os.path.join(SHOTS, f"toggle-{theme}.png"))
            page.locator("[data-automouse-choose]").click()
            dialog = page.locator("[data-automouse-dialog]")
            expect(dialog).to_be_visible()
            pills = dialog.locator("[data-layer]")
            check(pills.count() == 15, f"{theme}: 15 pills (the mouse layer left out), got {pills.count()}")
            check(dialog.locator("[data-off='1']").count() == 0, f"{theme}: none marked at first")

            # 3.
            dialog.locator("[data-layer='1']").click()
            dialog.locator("[data-layer='3']").click()
            check(dialog.locator("[data-layer='3']").get_attribute("aria-pressed") == "true", f"{theme}: a clicked pill is pressed")
            deco = dialog.locator("[data-layer='3'] span").evaluate("e => getComputedStyle(e).textDecorationLine")
            check("line-through" in deco, f"{theme}: an off layer is struck through")
            if SHOTS:
                dialog.screenshot(path=os.path.join(SHOTS, f"picker-{theme}.png"))
                page.screenshot(path=os.path.join(SHOTS, f"picker-page-{theme}.png"))
            dialog.get_by_role("button", name="Cancel").click()
            expect(dialog).to_be_hidden()
            page.locator("[data-automouse-choose]").click()
            check(dialog.locator("[data-off='1']").count() == 0, f"{theme}: Cancel kept the mask")

            # 4.
            dialog.locator("[data-layer='1']").click()
            dialog.locator("[data-layer='3']").click()
            dialog.locator("[data-automouse-done]").click()
            expect(dialog).to_be_hidden()
            page.wait_for_timeout(800)
            hint = page.locator("[data-automouse-layers-row]").inner_text()
            check("None yet" not in hint and "3" in hint, f"{theme}: the row names the layers after Done ({hint!r})")
            if SHOTS:
                group.screenshot(path=os.path.join(SHOTS, f"after-{theme}.png"))

            # 5.
            row.get_by_role("radio", name="Everywhere").click()
            expect(page.locator("[data-automouse-layers-row]")).to_have_count(0)
            row.get_by_role("radio", name="Only on Selected Layers").click()
            page.locator("[data-automouse-choose]").click()
            check(dialog.locator("[data-off='1']").count() == 2, f"{theme}: the layers survive Everywhere and back")
            dialog.get_by_role("button", name="Cancel").click()
            check(not errors, f"{theme}: no page errors {errors}")
            context.close()

        # 6.
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.goto(f"{url}?fakeBoard=old&panel=pointing-automouse")
        wait_connected(page)
        page.wait_for_timeout(2500)
        check(page.locator("[data-row='Auto Mouse Layer']").count() == 0, "older firmware: no Auto Mouse Layer setting")
        context.close()
        browser.close()

    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
