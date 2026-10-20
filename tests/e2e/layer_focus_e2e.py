"""
Browser test of the layer tabs above the keyboard while several layers are
shown, as a person uses them: the built app, the QWERTY Example (?demo), with
a simulated board live layer (&boardLayer=N, changed in place the way a board
reports layer changes while someone types). Run with
`npm run test:e2e:layer-focus`.

  1. With one layer shown, the board's live layer is underlined in the tabs,
     as before.
  2. Show Multiple Layers: the marked tab is the displayed layer (0).
  3. Select a key in the layer 1 view: focus moves there and the marked tab
     is 1.
  4. The board changes its live layer (2, then 0, then 3): the marked tab
     stays on 1 and no tab is underlined for the board.
  5. Focus changes: a key in the layer 0 view marks 0; the layer 2 tab marks
     2. Board changes after each still leave the mark where focus is.
  6. The same in the 3D view, light and dark, with no page errors.

Same server options as combo_editor_e2e.py (E2E_URL, E2E_SKIP_BUILD).
Exits 1 when a check fails.
"""
import os
import sys

from playwright.sync_api import Page, expect, sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from combo_editor_e2e import app_url  # noqa: E402

# The tabs above the keyboard (LayerSelector) are the ones with aria-pressed.
MARKED = 'button[aria-label^="Layer "][aria-pressed="true"]'
TOP_TABS = 'button[aria-label^="Layer "][aria-pressed]'


def open_demo(browser, url: str, theme: str, board: int):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme=theme,
                                  reduced_motion="reduce")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{url}?demo&theme={theme}&boardLayer={board}")
    page.locator("[data-keycap]:visible").first.wait_for(timeout=20000)
    return context, page, errors


def board_reports(page: Page, layer: int):
    """The board's live layer changes, as when a layer key is held while typing."""
    page.evaluate("""layer => {
        const q = new URLSearchParams(location.search);
        q.set('boardLayer', String(layer));
        history.replaceState(null, '', location.pathname + '?' + q.toString());
    }""", layer)
    # Keybard polls the board's layer every 120 ms; let a few polls land.
    page.wait_for_timeout(600)


def marked_layer(page: Page) -> int | None:
    tabs = page.locator(MARKED)
    if tabs.count() != 1:
        return None
    label = tabs.first.get_attribute("aria-label") or ""
    return int(label.split(":")[0].replace("Layer", "").strip())


def underlined_top_tabs(page: Page) -> int:
    return page.locator(f"{TOP_TABS} span.underline").count()


def focus_key_in(page: Page, layer: int):
    """Select a key in the stacked view of that layer (the primary view shows the displayed layer)."""
    view = page.locator(f'[data-keyboard-view-instance="multi-{layer}"]')
    if view.count() == 0:
        view = page.locator('[data-keyboard-view-instance="primary"]')
    key = view.locator("[data-keycap]").first
    key.scroll_into_view_if_needed()
    key.click(force=True)
    page.wait_for_timeout(200)


def run(browser, url: str, theme: str, three_d: bool, failures: list):
    tag = f"{theme}{' 3D' if three_d else ''}"

    def check(ok: bool, what: str):
        if not ok:
            failures.append(f"[{tag}] {what}")
        print(f"  {'ok  ' if ok else 'FAIL'} [{tag}] {what}")

    context, page, errors = open_demo(browser, url, theme, board=2)

    # 1. One layer shown: the board's live layer is underlined in that view's tabs.
    if not three_d:
        view_tabs = page.locator('[data-keyboard-view-instance="primary"] button span.underline')
        expect(view_tabs.first).to_be_visible(timeout=5000)
        check(view_tabs.first.inner_text().strip() == "2",
              "one layer shown: the board's live layer (2) is underlined, as before")

    # 2. Several layers shown.
    page.get_by_label("Show Multiple Layers").click()
    if three_d:
        page.get_by_label("3D View").click()
    expect(page.locator(MARKED)).to_have_count(1, timeout=5000)
    page.wait_for_timeout(800)
    check(marked_layer(page) == 0, f"several layers shown: the marked tab is the displayed layer 0 (got {marked_layer(page)})")

    # 3. Focus moves to layer 1.
    focus_key_in(page, 1)
    check(marked_layer(page) == 1, f"a key selected in layer 1 marks tab 1 (got {marked_layer(page)})")

    # 4. The board changes its live layer; the mark stays on the focused layer.
    for board in (2, 0, 3):
        board_reports(page, board)
        check(marked_layer(page) == 1, f"board on layer {board}: the marked tab stays on 1 (got {marked_layer(page)})")
        check(underlined_top_tabs(page) == 0, f"board on layer {board}: no tab is underlined for the board")

    # 5. Focus changes move the mark.
    focus_key_in(page, 0)
    check(marked_layer(page) == 0, f"a key selected in layer 0 marks tab 0 (got {marked_layer(page)})")
    board_reports(page, 1)
    check(marked_layer(page) == 0, f"board on layer 1: the marked tab stays on 0 (got {marked_layer(page)})")

    page.locator('button[aria-label^="Layer 2:"][aria-pressed]').click()
    page.wait_for_timeout(500)
    check(marked_layer(page) == 2, f"the layer 2 tab marks 2 (got {marked_layer(page)})")
    board_reports(page, 0)
    check(marked_layer(page) == 2, f"board on layer 0: the marked tab stays on 2 (got {marked_layer(page)})")

    check(not errors, f"no page errors ({errors[:2]})")
    context.close()


def main() -> int:
    failures: list = []
    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch(ignore_default_args=["--hide-scrollbars"])
        for theme in ("light", "dark"):
            for three_d in (False, True):
                run(browser, url, theme, three_d, failures)
        browser.close()
    if failures:
        print(f"\n{len(failures)} check(s) failed:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nAll layer focus checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
