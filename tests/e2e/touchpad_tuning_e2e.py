"""
Browser tests of Touchpad tuning (svalboard/qmk "Touchpad tuning" and
"Touchpad touch": VIA values 55-57, GET_INFO byte 20 bits 5 and 6) against the
simulated Svalboard, whose two pads play scripted touches through a model of
the chip's tap and press-and-hold rules. Run with
`npm run test:e2e:touchpad-tuning`.

  1. Settings: a Touchpad tuning entry beside Hardware, one line and a "Tune
     touchpad…" button that opens the tuning dialog (dead zone 1.2 mm, tap
     time 150 ms, hold time 300 ms, the build's scroll start 1.05 mm);
     ?panel=settings&tune=touchpad opens Settings with the dialog open.
  2. Pointing Devices: "Tune touchpad…" in its Touchpad section (and no
     tuning values of its own) opens the same dialog, as
     ?panel=pointing&tune=touchpad does; Escape closes it.
  3. Both pads show live: a touch shows within about 100 ms of touch-down,
     drawn at its reported footprint, and each touch that ends is listed
     with what it did.
  4. The dead zone writes and saves (1.2 -> 0.5 mm, VIA 55), the board's
     setting follows, and the rolling tap is then listed as canceled; back to
     1.2 mm it taps again. Tap time and hold time write 56 and 54.
  5. One layout: the controls above both pads, a timer ring in each close-up.
  6. Not shown: no touchpad (?fakeBoard), or firmware without the setting
     (?fakeBoard=old): no Touchpad chip or entry, no link.
  7. No animation beyond the live finger and timer.
  8. Layout: no sideways overflow at 390 and 1440 px, light and dark, from
     both entries; ink unlike the page.
  9. No layout shift: with 50+ touches played, the dialog, the controls, the
     pads and their close-ups keep their size and place, the touch lists
     scroll inside their own boxes, and nothing scrolls sideways (390, 1440).

E2E_URL and E2E_SKIP_BUILD work as in fake_board_e2e.py. SHOT_DIR=path saves
screenshots. Needs Python Playwright with Chromium. Exits 1 when a check fails.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402
from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

TITLE = "Touchpad tuning"
LINK = "Tune touchpad…"
FROM_SETTINGS = "panel=settings&tune=touchpad"
FROM_POINTING = "panel=pointing&tune=touchpad"


def open_page(browser, url: str, query: str, board="fakeBoard=touchpad", viewport=(1440, 1000), scheme="light"):
    context = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, color_scheme=scheme, reduced_motion="reduce")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{url}?{board}&{query}&theme={scheme}")
    wait_connected(page)
    return context, page, errors


def view(page: Page):
    return page.locator("[data-touchpad-tuning]").first


def step_value(page: Page, label: str) -> str:
    return page.locator(f"[data-step='{label}'] [data-step-value]").first.inner_text()


def flow_settings(browser, url):
    context, page, errors = open_page(browser, url, "panel=settings")
    entry = page.locator("[data-touchpad-entry]")
    expect(entry).to_be_visible(timeout=15000)
    chips = page.get_by_role("navigation", name="Settings sections").get_by_role("button").all_inner_texts()
    assert chips[:2] == ["Hardware", "Touchpad"], chips
    assert page.locator("[data-step]").count() == 0, "tuning controls inline in Settings"
    entry.get_by_role("button", name=LINK).click()
    dialog = page.get_by_role("dialog", name=TITLE)
    expect(dialog).to_be_visible(timeout=5000)
    for label, want in (("Dead zone", "1.2 mm"), ("Tap time", "150 ms"), ("Hold time", "300 ms"), ("Scroll start", "1.05 mm")):
        assert step_value(page, label) == want, f"{label} {step_value(page, label)}"
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden(timeout=5000)
    context.close()
    context, page, errors2 = open_page(browser, url, FROM_SETTINGS)
    expect(page.get_by_role("dialog", name=TITLE)).to_be_visible(timeout=15000)
    expect(page.locator("[data-touchpad-entry]")).to_be_attached()
    assert not errors and not errors2, errors + errors2
    context.close()


def flow_dialog(browser, url):
    context, page, errors = open_page(browser, url, "panel=pointing")
    link = page.get_by_role("button", name=LINK)
    expect(link).to_be_visible(timeout=15000)
    assert page.locator("[data-step]").count() == 0, "Pointing Devices shows tuning controls"
    for name in ("Dead Zone (0.01 mm)", "Tap Time (ms)", "Scroll Start (0.01 mm)"):
        assert page.get_by_text(name).count() == 0, f"{name} shown in Pointing Devices"
    link.click()
    dialog = page.get_by_role("dialog", name=TITLE)
    expect(dialog).to_be_visible(timeout=5000)
    expect(dialog.locator("[data-step='Dead zone']")).to_be_visible()
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden(timeout=5000)
    context.close()
    context, page, errors2 = open_page(browser, url, FROM_POINTING)
    expect(page.get_by_role("dialog", name=TITLE)).to_be_visible(timeout=15000)
    assert not errors and not errors2, errors + errors2
    context.close()


LATENCY_JS = """() => {
    // Touch-down time from the board's own clock: a read that first shows a
    // finger down says how long it has been down. Then when the finger shows.
    const f = window.keybardFakeBoard.device.firmware;
    const page = f.touchPage.bind(f);
    window.__lat = [];
    let downAt = null;
    f.touchPage = (out) => {
        page(out);
        const down = (out[14] & 2) !== 0, ms = out[24] | (out[25] << 8);
        if (down && downAt === null) downAt = performance.now() - ms;
        if (!down) downAt = null;
    };
    const target = document.querySelector("[data-pad='left'] [data-pad-svg]");
    let shown = false;
    new MutationObserver(() => {
        const now = !!target.querySelector("[data-finger]");
        if (now && !shown && downAt !== null) window.__lat.push(performance.now() - downAt);
        shown = now;
    }).observe(target, { subtree: true, childList: true });
}"""


def flow_live(browser, url):
    context, page, errors = open_page(browser, url, FROM_SETTINGS)
    expect(page.locator("[data-pad='left'] [data-pad-svg]")).to_be_visible(timeout=15000)
    expect(page.locator("[data-pad='right'] [data-pad-svg]")).to_be_visible()
    page.evaluate(LATENCY_JS)
    page.wait_for_function("window.__lat.length >= 4", timeout=30000)
    lat = page.evaluate("window.__lat")
    # The page reads every 90 ms while the pads rest, every 30 ms while busy; a frame to draw.
    assert max(lat) <= 130 and sum(lat) / len(lat) <= 100, f"touch-down to screen, ms: {[round(x) for x in lat]}"
    for side in ("left", "right"):
        page.locator(f"[data-pad='{side}'] [data-outcome]").first.wait_for(timeout=15000)
    # The simulated board reports each finger's strength and area: drawn as its footprint, not a dot.
    page.locator("[data-contact='sized']").first.wait_for(state="attached", timeout=15000)
    kinds = page.locator("[data-outcome]").evaluate_all("els => els.map(e => e.dataset.outcome)")
    assert set(kinds) & {"tap", "hold", "right", "canceled", "late"}, kinds
    assert not errors, errors
    context.close()
    print(f"     touch-down to screen: {', '.join(str(round(x)) for x in lat)} ms")


def press_slider(page: Page, label: str, key: str, times: int):
    slider = page.get_by_role("slider", name=label)
    slider.focus()
    for _ in range(times):
        slider.press(key)


def saves_after(page: Page, vid: int) -> int:
    return page.evaluate(f"""(() => {{
        const sent = window.keybardFakeBoard.device.sent.map(r => Array.from(r));
        const via = sent.filter(r => r[0] === 0xdd && r[5] === 0xfe);
        let last = -1; via.forEach((r, i) => {{ if (r[6] === 0x07 && r[8] === {vid}) last = i; }});
        return last < 0 ? 0 : via.slice(last + 1).filter(r => r[6] === 0x09).length;
    }})()""")


def flow_dead_zone(browser, url):
    context, page, errors = open_page(browser, url, FROM_SETTINGS)
    expect(page.locator("[data-step='Dead zone']")).to_be_visible(timeout=15000)
    press_slider(page, "Dead zone", "ArrowLeft", 6)  # 1.2 -> 1.0 -> 0.9 -> 0.8 -> 0.7 -> 0.6 -> 0.5
    page.wait_for_function("window.keybardFakeBoard.device.firmware.padTuning.deadZone === 50", timeout=5000)
    page.wait_for_timeout(300)
    assert saves_after(page, 55) >= 1, "dead zone not saved"
    assert step_value(page, "Dead zone") == "0.5 mm"
    # The rolling tap (0.6 mm at the lift) is now canceled.
    page.locator("[data-pad] [data-outcome='canceled']", has_text="moved 0.6").first.wait_for(state="attached", timeout=15000)
    press_slider(page, "Dead zone", "ArrowRight", 6)
    page.wait_for_function("window.keybardFakeBoard.device.firmware.padTuning.deadZone === 120", timeout=5000)
    press_slider(page, "Tap time", "ArrowRight", 1)
    page.wait_for_function("window.keybardFakeBoard.device.firmware.padTuning.tapMs === 175", timeout=5000)
    press_slider(page, "Hold time", "ArrowRight", 1)
    page.wait_for_function("((window.keybardFakeBoard.device.firmware.padSetting >> 3) & 15) === 7", timeout=5000)  # 350 ms
    assert step_value(page, "Hold time") == "350 ms"
    assert not errors, errors
    context.close()


def flow_layout(browser, url):
    for query in (FROM_SETTINGS, FROM_POINTING):
        context, page, errors = open_page(browser, url, query)
        v = view(page)
        expect(v).to_be_visible(timeout=15000)
        v.locator("[data-timer-ring]").first.wait_for(timeout=15000)
        assert v.locator("[data-timer-bar]").count() == 0, f"{query}: a timeline"
        controls, pads = v.locator("[data-tuning-controls]").bounding_box(), v.locator("[data-pads]").bounding_box()
        assert controls["y"] < pads["y"], f"{query}: the controls are not above the pads"
        assert not errors, errors
        context.close()


def flow_hidden(browser, url):
    for board, why in (("fakeBoard", "no touchpad"), ("fakeBoard=old", "firmware without the setting")):
        context, page, errors = open_page(browser, url, "panel=settings", board=board)
        expect(page.get_by_role("navigation", name="Settings sections")).to_be_visible(timeout=15000)
        chips = page.get_by_role("navigation", name="Settings sections").get_by_role("button").all_inner_texts()
        assert "Touchpad" not in chips, f"{why}: {chips}"
        assert page.locator("[data-touchpad-entry]").count() == 0, f"{why}: the entry shows"
        context.close()
        context, page, errors2 = open_page(browser, url, "panel=pointing", board=board)
        expect(page.get_by_role("group", name="Natural Scroll", exact=True)).to_be_visible(timeout=15000)
        assert page.get_by_role("button", name=LINK).count() == 0, f"{why}: the link shows"
        assert not errors and not errors2, errors + errors2
        context.close()


def flow_no_animation(browser, url):
    context, page, _ = open_page(browser, url, FROM_SETTINGS)
    expect(view(page)).to_be_visible(timeout=15000)
    page.wait_for_timeout(500)
    shared = "[data-slot='slider-thumb'], [data-slot='slider-range'], [data-slot='slider-track'], [data-slot='slider']"
    bad = view(page).evaluate(f"""root => [root, ...root.querySelectorAll('*')].filter(e => {{
        const s = getComputedStyle(e);
        const trans = s.transitionDuration.split(',').some(d => parseFloat(d) !== 0) && !e.matches({shared!r});
        return s.animationName !== 'none' || trans; }}).map(e => e.tagName + ' ' + String(e.className).slice(0, 60))""")
    assert not bad, bad[:5]
    context.close()


def flow_layout_checks(browser, url):
    for width, height in ((390, 844), (1440, 1000)):
        for scheme in ("light", "dark"):
            for query in (FROM_SETTINGS, FROM_POINTING):
                context, page, _ = open_page(browser, url, query, viewport=(width, height), scheme=scheme)
                v = view(page)
                expect(v).to_be_visible(timeout=15000)
                over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                box = page.locator("[data-touchpad-tuning-dialog]").bounding_box()
                assert over <= 1 and box and box["x"] >= 0 and box["x"] + box["width"] <= width + 1 and box["y"] >= 0 and box["y"] + box["height"] <= height + 1, \
                    f"{query} {width}px {scheme}: overflow {over}, dialog {box}"
                ink = page.locator("[data-step='Dead zone'] [data-step-value]").evaluate("e => getComputedStyle(e).color")
                bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
                assert ink != bg, f"ink {ink} on {bg}"
                context.close()


BOXES_JS = """() => {
    const box = (sel) => [...document.querySelectorAll(sel)].map(e => {
        const r = e.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(v => Math.round(v * 2) / 2);
    });
    return { dialog: box("[data-touchpad-tuning-dialog]"), controls: box("[data-tuning-controls]"), steps: box("[data-step]"),
             pads: box("[data-pad-svg]"), closeUps: box("[data-close-up]"), lists: box("[data-outcomes]") };
}"""


def flow_stable(browser, url):
    for width, height in ((390, 844), (1440, 1000)):
        context, page, errors = open_page(browser, url, FROM_SETTINGS, viewport=(width, height))
        expect(view(page)).to_be_visible(timeout=15000)
        page.locator("[data-pad-svg]").nth(1).wait_for(timeout=15000)
        page.wait_for_timeout(500)
        first = page.evaluate(BOXES_JS)
        page.evaluate("window.keybardFakeBoard.device.firmware.touchSpeed = 6")
        changes, touches, started = [], 0, time.time()
        while touches < 50 and time.time() - started < 90:
            page.wait_for_timeout(200)
            now = page.evaluate(BOXES_JS)
            if now != first:
                changes.append({k: (first[k], now[k]) for k in first if first[k] != now[k]})
            touches = page.evaluate("[...document.querySelectorAll('[data-pad]')].reduce((n, e) => n + Number(e.dataset.touches || 0), 0)")
        lists = page.locator("[data-outcomes]").evaluate_all("els => els.map(e => [e.children.length, e.scrollHeight > e.clientHeight])")
        side = page.evaluate("""[document.documentElement, document.querySelector('[data-touchpad-tuning-body]')]
            .map(e => e.scrollWidth - e.clientWidth)""")
        assert touches >= 50, f"{width}px: only {touches} touches played"
        assert not changes, f"{width}px: layout moved: {changes[0]}"
        assert all(n > 5 and scrolls for n, scrolls in lists), f"{width}px: the lists don't scroll in place: {lists}"
        assert max(side) <= 1, f"{width}px: sideways scroll {side}"
        assert not errors, errors
        context.close()
        print(f"     {width}px: {touches} touches, nothing moved")


def shots(browser, url, out):
    os.makedirs(out, exist_ok=True)
    for scheme in ("light", "dark"):
        for query, tag in ((FROM_SETTINGS, "from-settings"), (FROM_POINTING, "from-pointing")):
            context, page, _ = open_page(browser, url, query, scheme=scheme)
            expect(view(page)).to_be_visible(timeout=15000)
            # One loop of the scripted touches, then a moment with a finger down.
            page.wait_for_timeout(11000)
            page.locator("[data-contact='sized']").first.wait_for(state="attached", timeout=15000)
            page.screenshot(path=os.path.join(out, f"tuning-{tag}-{scheme}.png"))
            context.close()
        context, page, _ = open_page(browser, url, "panel=settings", scheme=scheme)
        entry = page.locator("[data-touchpad-entry]")
        expect(entry).to_be_visible(timeout=15000)
        page.get_by_role("button", name="Touchpad", exact=True).first.click()
        page.wait_for_timeout(900)
        page.screenshot(path=os.path.join(out, f"settings-entry-{scheme}.png"))
        context.close()
    context, page, _ = open_page(browser, url, FROM_SETTINGS, viewport=(390, 844))
    expect(view(page)).to_be_visible(timeout=15000)
    page.wait_for_timeout(4000)
    page.screenshot(path=os.path.join(out, "tuning-phone-light.png"))
    context.close()


def main() -> int:
    flows = [
        ("1. Settings: the entry opens the dialog, defaults; ?panel=settings&tune=touchpad", flow_settings),
        ("2. Pointing Devices: Tune touchpad… opens the dialog; ?tune=touchpad too", flow_dialog),
        ("3. both pads live, touch-down shows within ~100 ms, touches listed", flow_live),
        ("4. dead zone 0.5 mm writes, saves, cancels the rolling tap; tap and hold times", flow_dead_zone),
        ("5. one layout: controls above the pads, timer ring", flow_layout),
        ("6. no touchpad, or older firmware: no entry, no chip, no link", flow_hidden),
        ("7. no animation beyond the live finger and timer", flow_no_animation),
        ("8. layout: 390 and 1440 px, light and dark, no overflow", flow_layout_checks),
        ("9. no layout shift over 50+ touches, lists scroll in place (390, 1440)", flow_stable),
    ]
    failed = 0
    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        print(f"Testing {url}")
        for label, flow in flows:
            started = time.time()
            try:
                flow(browser, url)
                print(f"PASS {label} ({time.time() - started:.0f} s)")
            except Exception as error:  # noqa: BLE001 - report every flow
                failed += 1
                lines = str(error).strip().splitlines() or [repr(error)]
                print(f"FAIL {label}\n     {lines[0]}")
                print("     " + "\n     ".join(lines[1:12]))
        if os.environ.get("SHOT_DIR"):
            shots(browser, url, os.environ["SHOT_DIR"])
            print(f"screenshots in {os.environ['SHOT_DIR']}")
        browser.close()
    print(f"{len(flows) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
