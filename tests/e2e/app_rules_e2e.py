"""
Browser flow of the App Layers panel (app rules) against the simulated Svalboard (?fakeBoard, firmware
with GET_INFO byte 22 bit 0 and the 0x40/0x41 commands). Headless, 1440 x 900, light and dark.
Run with `npm run test:e2e:app-rules`.

  1. ?panel=app-layers opens the App Layers panel, "0 of 64 rules", the App Layers switch on, with
     More marked on the rail (App Layers has no rail item of its own). More lists Overrides,
     Alt-Repeat and App Layers, and its App Layers entry opens the panel again; ?panel=app-rules
     (the older name) opens it too.
  2. Add a rule: empty, on, with a sample placeholder; type notepad.exe.
  3. Pick a default layer and a front layer; set one pill on and one off.
  4. After the debounce, one BEGIN/WRITE/COMMIT lands on the board with that rule (format 2, packed,
     the text stored whole).
  4b. Website: a second rule for https://cad.onshape.com/documents keeps the whole site (never
     onshape.com): the hint says what it matches; the board holds site:cad.onshape.com's ID, the
     website flag and the whole site.
  4c. The rule's own switch: off sets its flag on the board; on clears it.
  4d. The App Layers switch: off sets header byte 2 bit 0 on the board and shows off; on clears it.
  4e. No text in the panel is cut off: every control's label fits (scrollWidth <= clientWidth, and a
     select's chosen option fits its box).
  4f. Reorder by the grip (no up or down buttons): a mouse drag puts the website first, with the
     rule lifted and a slot where it lands, and nothing written until the drop; then Space, arrow
     down, Space puts it back, announced in the live region. Each drop is one BEGIN/WRITE/COMMIT.
  5. Reload (the board keeps its settings): the rules read back from the board, the second as
     Website with its whole site, without this browser remembering it.
  6. Bottom bar: the section shows there too.
  6a. Bottom bar: a mouse drag along the row reorders the board, and back.
  6b. Bottom bar: More lists App Layers too.
  7. Older firmware (?fakeBoard=old): More lists Overrides and Alt-Repeat, no App Layers; no editor.

With E2E_SHOTS=<dir>, saves editor-<theme>.png (sidebar), website-<theme>.png, editor-bottombar-<theme>.png,
drag-<theme>.png, keyboard-drag-<theme>.png and drag-bottombar-<theme>.png (mid-drag).
E2E_URL and E2E_SKIP_BUILD work as in fake_board_e2e.py. Exits 1 when a check fails.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import expect, sync_playwright  # noqa: E402

SHOTS = os.environ.get("E2E_SHOTS")
FW = "window.keybardFakeBoard.device.firmware"
NOTEPAD_ID = 0xB884A32C
CAD_ONSHAPE_ID = 0x7E364D67  # site:cad.onshape.com

# Every control and label in the App Layers panel whose text is cut off: [description, ...].
# Selects show their chosen option, which scrollWidth doesn't measure: its text is measured instead.
CLIPPED_JS = """
(root) => {
  const out = [];
  const canvas = document.createElement('canvas').getContext('2d');
  for (const el of root.querySelectorAll('select, button, label, span, p, input[type=text], h3')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue; // hidden, or for screen readers only
    if (el.tagName === 'SELECT') {
      const cs = getComputedStyle(el);
      canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = el.options[el.selectedIndex]?.text ?? '';
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (canvas.measureText(text).width > room + 0.5) out.push(`select ${el.getAttribute('aria-label')}: "${text}" in ${room.toFixed(0)}px`);
      continue;
    }
    if (el.tagName === 'INPUT') {
      if (el.scrollWidth > el.clientWidth + 1 && el.value) out.push(`input ${el.getAttribute('aria-label')}: "${el.value}"`);
      continue;
    }
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}"`);
    if (getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) out.push(`ellipsis "${el.textContent.trim().slice(0, 40)}"`);
  }
  return out;
}
"""


def rule_offsets(rec):
    """The offsets of a format 2 record's rules."""
    out, o = [], 4
    for _ in range(rec[1]):
        out.append(o)
        o += 12 + rec[o + 11]
    return out


APP_RULES_SETTLE_MS = 900  # the 500 ms write delay, and the write


def first_ids(page):
    """The IDs of the rules on the board, in order."""
    rec = page.evaluate(f"Array.from({FW}.state.appRules.slice(0, 200))")
    return [rec[o] | (rec[o + 1] << 8) | (rec[o + 2] << 16) | (rec[o + 3] << 24) for o in rule_offsets(rec)]


def wait_first(page, rule_id):
    page.wait_for_function(
        f"(() => {{ const r = {FW}.state.appRules; return ((r[4] | r[5] << 8 | r[6] << 16 | r[7] << 24) >>> 0) === {rule_id}; }})()",
        timeout=5000)


def panel_clip(page):
    """The side panel (or the bottom bar) and a margin, for screenshots."""
    panel = page.locator(".detail-panel").first
    box = panel.bounding_box()
    vw, vh = page.viewport_size["width"], page.viewport_size["height"]
    if box["width"] > vw * 0.8:
        return {"x": 0, "y": 0, "width": vw, "height": vh}
    return {"x": 0, "y": 0, "width": min(vw, box["x"] + box["width"] + 8), "height": vh}


def drag_rule(page, section, src, dst, shot, check, theme):
    """Drags rule src by its grip onto rule dst with the mouse; the write is one BEGIN/COMMIT."""
    ops = len(page.evaluate(f"{FW}.appRulesOps"))
    grip = section.locator(f"[data-app-rule='{src}'] [data-testid='app-rule-grip']")
    grip.scroll_into_view_if_needed()
    g = grip.bounding_box()
    t = section.locator(f"[data-app-rule='{dst}']").bounding_box()
    x0, y0 = g["x"] + g["width"] / 2, g["y"] + g["height"] / 2
    s = section.locator(f"[data-app-rule='{src}']").bounding_box()
    # Move the rule's corner onto the other rule's corner.
    x1, y1 = x0 + t["x"] - s["x"], y0 + t["y"] - s["y"]
    page.mouse.move(x0, y0)
    page.mouse.down()
    for k in range(1, 21):
        page.mouse.move(x0 + (x1 - x0) * k / 20, y0 + (y1 - y0) * k / 20)
        page.wait_for_timeout(16)
        if k == 14:
            # Most of the way: the lifted rule and the slot it will land in both show.
            page.wait_for_timeout(250)
            check(page.locator("[data-app-rule-lifted]").count() == 1, f"{theme}: the dragged rule is lifted")
            check(page.locator("[data-app-rule-slot]").count() == 1, f"{theme}: a slot shows where it lands")
            if shot:
                page.screenshot(path=shot, clip=panel_clip(page))
    page.wait_for_timeout(250)
    check(len(page.evaluate(f"{FW}.appRulesOps")) == ops, f"{theme}: nothing is written while dragging")
    page.mouse.up()
    page.wait_for_timeout(APP_RULES_SETTLE_MS)
    new_ops = page.evaluate(f"{FW}.appRulesOps")[ops:]
    check(new_ops.count(3) == 1 and new_ops.count(4) == 1, f"{theme}: one write for the drop ({new_ops!r})")


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
            context = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce",
                                          color_scheme=theme)
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"{url}?fakeBoard&theme={theme}&panel=app-layers")
            wait_connected(page)
            section = page.locator("[data-app-rules]")
            expect(section).to_be_visible(timeout=20000)

            # 1.
            check(page.get_by_test_id("app-rules-count").inner_text() == "0 of 64 rules", f"{theme}: empty list, 64 max")
            check(page.get_by_test_id("app-rules-bytes").inner_text() == "4 of 1792 bytes used", f"{theme}: bytes used")
            switch = page.get_by_role("group", name="App Layers", exact=True)
            check(switch.locator("button[aria-pressed='true']").inner_text() == "ON", f"{theme}: App Layers on")
            check(page.locator("[data-app-layers-panel]").count() == 1, f"{theme}: in the App Layers panel")
            more = page.get_by_role("button", name="More", exact=True)
            check(page.get_by_role("button", name="App Layers", exact=True).count() == 0, f"{theme}: no App Layers rail item")
            check(more.get_attribute("aria-pressed") == "true", f"{theme}: More marked on the rail")
            more.click()
            tools = page.locator("[data-more-tool]")
            expect(tools.first).to_be_visible()
            names = tools.evaluate_all("es => es.map(e => e.dataset.moreTool)")
            check(names == ["overrides", "altrepeat", "app-layers"], f"{theme}: More lists {names}")
            if SHOTS:
                page.screenshot(path=os.path.join(SHOTS, f"more-{theme}.png"), clip={"x": 0, "y": 0, "width": 760, "height": 900})
            page.locator("[data-more-tool='app-layers']").click()
            expect(section).to_be_visible()
            check(page.locator("[data-app-layers-panel]").count() == 1 and more.get_attribute("aria-pressed") == "true",
                  f"{theme}: More's App Layers opens the panel, More still marked")
            page.goto(f"{url}?fakeBoard&theme={theme}&panel=app-rules")
            wait_connected(page)
            expect(section).to_be_visible(timeout=20000)
            check(page.locator("[data-app-layers-panel]").count() == 1, f"{theme}: ?panel=app-rules opens App Layers")

            # 2.
            section.get_by_role("button", name="Add rule").click()
            rule = section.locator("[data-app-rule='0']")
            expect(rule).to_be_visible()
            key = rule.get_by_test_id("app-rule-key")
            check(key.input_value() == "" and key.get_attribute("placeholder") in ("program.exe", "com.example.app", "program"),
                  f"{theme}: a new rule is empty, with a sample placeholder ({key.get_attribute('placeholder')!r})")
            check(rule.get_by_role("group", name="Rule 1").locator("button[aria-pressed='true']").inner_text() == "ON", f"{theme}: a new rule is on")
            key.fill("notepad.exe")
            names = (rule.get_by_text("Turn on layer").count(), rule.get_by_text("Other layers while the app is in front").count(),
                     rule.get_by_text("Front layer").count())
            check(names[0] >= 1 and names[1] == 1 and names[2] == 0, f"{theme}: plain labels {names}")

            # 3.
            rule.get_by_test_id("app-rule-default").select_option("1")
            rule.get_by_test_id("app-rule-front").select_option("2")
            pills = rule.locator("[data-app-rule-pills]")
            on, off = pills.locator("[data-layer='3']"), pills.locator("[data-layer='4']")
            on.click()
            off.click(); off.click()
            check(on.get_attribute("data-state") == "on", f"{theme}: layer 3 pill on")
            check(off.get_attribute("data-state") == "off", f"{theme}: layer 4 pill off")
            deco = off.locator("span").evaluate("e => getComputedStyle(e).textDecorationLine")
            check("line-through" in deco, f"{theme}: an off layer is struck through")

            # 4.
            page.wait_for_function(f"{FW}.state.appRules[1] === 1 && {FW}.appRulesOps.includes(4)", timeout=5000)
            ops = page.evaluate(f"{FW}.appRulesOps")
            check(ops.count(3) == 1 and ops.count(4) == 1, f"{theme}: one BEGIN and one COMMIT for the burst ({ops!r})")
            rec = page.evaluate(f"Array.from({FW}.state.appRules.slice(0, 64))")
            app = rec[4] | (rec[5] << 8) | (rec[6] << 16) | (rec[7] << 24)
            check(rec[0] == 2, f"{theme}: format 2 record")
            check(app == NOTEPAD_ID, f"{theme}: the board holds notepad.exe's ID ({app:#x})")
            check(rec[8] == 1 and rec[9] == 2, f"{theme}: default layer 1, front layer 2 ({rec[8]}, {rec[9]})")
            check((rec[10] | rec[11] << 8) == 1 << 3 and (rec[12] | rec[13] << 8) == 1 << 4, f"{theme}: on mask layer 3, off mask layer 4")
            check(rec[14] == 0 and bytes(rec[16:16 + rec[15]]).decode() == "notepad.exe", f"{theme}: on, text notepad.exe")
            page.mouse.move(0, 0)
            if SHOTS:
                section.scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                section.screenshot(path=os.path.join(SHOTS, f"editor-{theme}.png"))
                page.screenshot(path=os.path.join(SHOTS, f"editor-page-{theme}.png"))

            # 4b.
            section.get_by_role("button", name="Add rule").click()
            site_rule = section.locator("[data-app-rule='1']")
            expect(site_rule).to_be_visible()
            site_rule.get_by_test_id("app-rule-kind").select_option("site")
            check(site_rule.get_by_test_id("app-rule-pick").count() == 0, f"{theme}: no running-app picker for a website")
            check(site_rule.get_by_test_id("app-rule-site").get_attribute("placeholder") == "example.com", f"{theme}: website sample placeholder")
            site_rule.get_by_test_id("app-rule-site").fill("https://cad.onshape.com/documents")
            hint = site_rule.get_by_test_id("app-rule-site-hint").inner_text()
            check(hint == "Matches cad.onshape.com and every address under it.", f"{theme}: website hint ({hint!r})")
            site_rule.get_by_test_id("app-rule-front").select_option("3")
            page.wait_for_function(f"{FW}.state.appRules[1] === 2 && {FW}.state.appRules[27 + 5] === 3", timeout=5000)
            rec = page.evaluate(f"Array.from({FW}.state.appRules.slice(0, 80))")
            o = rule_offsets(rec)[1]
            sid = rec[o] | (rec[o + 1] << 8) | (rec[o + 2] << 16) | (rec[o + 3] << 24)
            text = bytes(rec[o + 12:o + 12 + rec[o + 11]]).decode()
            check(sid == CAD_ONSHAPE_ID and text == "cad.onshape.com" and rec[o + 10] == 2,
                  f"{theme}: the board holds site:cad.onshape.com whole ({sid:#x}, {text!r}, flags {rec[o + 10]})")

            # 4c.
            site_rule.get_by_role("group", name="Rule 2").get_by_role("button", name="OFF").click()
            page.wait_for_function(f"({FW}.state.appRules[27 + 10] & 1) === 1", timeout=5000)
            check(site_rule.get_attribute("data-rule-on") == "false", f"{theme}: rule 2 off on the board")
            site_rule.get_by_role("group", name="Rule 2").get_by_role("button", name="ON").click()
            page.wait_for_function(f"({FW}.state.appRules[27 + 10] & 1) === 0", timeout=5000)
            check(site_rule.get_attribute("data-rule-on") == "true", f"{theme}: rule 2 on again")

            # 4d.
            switch.get_by_role("button", name="OFF").click()
            page.wait_for_function(f"({FW}.state.appRules[2] & 1) === 1", timeout=5000)
            page.wait_for_timeout(300)
            check(switch.locator("button[aria-pressed='true']").inner_text() == "OFF", f"{theme}: App Layers off on the board, and shown off")
            switch.get_by_role("button", name="ON").click()
            page.wait_for_function(f"({FW}.state.appRules[2] & 1) === 0", timeout=5000)
            check(switch.locator("button[aria-pressed='true']").inner_text() == "ON", f"{theme}: App Layers on again")

            # 4e.
            clipped = section.evaluate(CLIPPED_JS)
            check(not clipped, f"{theme}: nothing in the panel is cut off {clipped}")
            page.mouse.move(0, 0)
            if SHOTS:
                site_rule.scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                site_rule.screenshot(path=os.path.join(SHOTS, f"website-{theme}.png"))

            # 4f. Reorder by the grip: a mouse drag, then the keyboard. Each drop writes once.
            check(section.get_by_role("button", name="Move rule 1 down").count() == 0, f"{theme}: no up or down buttons")
            drag_rule(page, section, 1, 0, os.path.join(SHOTS, f"drag-{theme}.png") if SHOTS else None, check, theme)
            wait_first(page, CAD_ONSHAPE_ID)
            check(first_ids(page) == [CAD_ONSHAPE_ID, NOTEPAD_ID], f"{theme}: a mouse drag puts the website first on the board")
            check(section.locator("[data-app-rule='0'] [data-testid='app-rule-site']").count() == 1, f"{theme}: the website shows as rule 1")
            grip = section.get_by_role("button", name="Reorder rule 1")
            ops = len(page.evaluate(f"{FW}.appRulesOps"))
            grip.focus()
            page.keyboard.press("Space")
            page.wait_for_timeout(100)
            page.keyboard.press("ArrowDown")
            if SHOTS:
                page.wait_for_timeout(250)
                page.screenshot(path=os.path.join(SHOTS, f"keyboard-drag-{theme}.png"), clip=panel_clip(page))
            live = page.locator("[id^='DndLiveRegion']").inner_text()
            check(live == "Rule 1 is at position 2 of 2.", f"{theme}: keyboard move announced ({live!r})")
            page.keyboard.press("Space")
            wait_first(page, NOTEPAD_ID)
            check(first_ids(page) == [NOTEPAD_ID, CAD_ONSHAPE_ID], f"{theme}: Space, arrow down, Space puts it back on the board")
            page.wait_for_timeout(APP_RULES_SETTLE_MS)
            new_ops = page.evaluate(f"{FW}.appRulesOps")[ops:]
            check(new_ops.count(3) == 1 and new_ops.count(4) == 1, f"{theme}: one write for the keyboard drop ({new_ops!r})")
            live = page.locator("[id^='DndLiveRegion']").inner_text()
            check(live == "Rule 1 dropped at position 2.", f"{theme}: drop announced ({live!r})")
            check(section.get_by_role("button", name="Reorder rule 2").is_visible(), f"{theme}: numbers follow the order")

            # 5.
            page.reload()
            wait_connected(page)
            expect(section).to_be_visible(timeout=20000)
            rule = section.locator("[data-app-rule='0']")
            expect(rule).to_be_visible()
            check(rule.get_by_test_id("app-rule-key").input_value() == "notepad.exe", f"{theme}: app read back")
            check(rule.get_by_test_id("app-rule-default").input_value() == "1", f"{theme}: default layer read back")
            check(rule.get_by_test_id("app-rule-front").input_value() == "2", f"{theme}: front layer read back")
            states = rule.locator("[data-app-rule-pills] [data-layer]").evaluate_all("es => es.map(e => e.dataset.state)")
            check(states[3] == "on" and states[4] == "off" and states.count("neutral") == len(states) - 2,
                  f"{theme}: pills read back ({states!r})")
            site_rule = section.locator("[data-app-rule='1']")
            check(site_rule.get_by_test_id("app-rule-kind").input_value() == "site", f"{theme}: website rule read back as Website")
            page.evaluate("localStorage.removeItem('keybard-app-rule-keys')")
            page.reload()
            wait_connected(page)
            expect(section).to_be_visible(timeout=20000)
            site_rule = section.locator("[data-app-rule='1']")
            check(site_rule.get_by_test_id("app-rule-site").input_value() == "cad.onshape.com", f"{theme}: whole site read back from the board alone")

            # 6.
            page.goto(f"{url}?fakeBoard&theme={theme}&panel=app-layers&panelPosition=bottombar")
            wait_connected(page)
            expect(section).to_be_visible(timeout=20000)
            check(section.locator("[data-app-rule='0']").count() == 1, f"{theme}: bottom bar shows the rule")
            check(section.locator("[data-app-rule='1'] [data-testid='app-rule-site']").count() == 1, f"{theme}: bottom bar shows the website rule")
            clipped = section.evaluate(CLIPPED_JS)
            check(not clipped, f"{theme}: bottom bar: nothing cut off {clipped}")
            if SHOTS:
                section.scroll_into_view_if_needed()
                page.wait_for_timeout(200)
                page.screenshot(path=os.path.join(SHOTS, f"editor-bottombar-{theme}.png"))
            # 6a. Bottom bar: the rules sit side by side; a drag moves along the row.
            drag_rule(page, section, 1, 0, os.path.join(SHOTS, f"drag-bottombar-{theme}.png") if SHOTS else None, check, f"{theme} bottom bar")
            wait_first(page, CAD_ONSHAPE_ID)
            check(first_ids(page) == [CAD_ONSHAPE_ID, NOTEPAD_ID], f"{theme}: bottom bar drag reorders the board")
            drag_rule(page, section, 1, 0, None, check, f"{theme} bottom bar")
            wait_first(page, NOTEPAD_ID)
            check(first_ids(page) == [NOTEPAD_ID, CAD_ONSHAPE_ID], f"{theme}: bottom bar drag back")
            # 6b.
            page.get_by_role("button", name="More", exact=True).click()
            expect(page.locator("[data-more-tool='app-layers']")).to_be_visible()
            check(page.locator("[data-more-tool]").count() == 3, f"{theme}: bottom bar More lists the three editors")
            if SHOTS:
                page.wait_for_timeout(200)
                page.screenshot(path=os.path.join(SHOTS, f"more-bottombar-{theme}.png"))
            check(not errors, f"{theme}: no page errors {errors}")
            context.close()

        # 7.
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.goto(f"{url}?fakeBoard=old&panel=layers")
        wait_connected(page)
        page.wait_for_timeout(2500)
        check(page.locator("[data-app-rules]").count() == 0, "older firmware: no App Layers editor in Layer Keys")
        check(page.get_by_role("button", name="App Layers", exact=True).count() == 0, "older firmware: no App Layers rail item")
        page.get_by_role("button", name="More", exact=True).click()
        expect(page.locator("[data-more-tool]").first).to_be_visible()
        names = page.locator("[data-more-tool]").evaluate_all("es => es.map(e => e.dataset.moreTool)")
        check(names == ["overrides", "altrepeat"], f"older firmware: More lists {names}, no App Layers")
        context.close()
        browser.close()

    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
