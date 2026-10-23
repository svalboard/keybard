"""
Browser test of firmware updates from Settings > Firmware as a person runs them: the
built app (test-site build, so ?fwfake=1 backs Firmware with the mock board), the
QWERTY Example, no keyboard. Every release is one pair UF2 for both halves (x4 on).
Run with `npm run test:e2e:firmware`.

  1. Update from Keybard: Start (one sentence, the layout choice, Update), then
     "Confirm on your keyboard" only while the board waits for the two keys, then
     Updating with one bar, then Done ("x4 is installed. Your layout is back.").
  2. A warning (an older release): a sentence with what to do, and Update anyway.
  3. A refusal (a file that misses its pin): the sentence, Reload and Close, no Update.
  4. Install from a file: Install a firmware file... takes the one .uf2 and installs
     both halves; a real pair UF2 built on the firmware branch opens the sheet too.
  5. An older per-side .uf2 (the real x3.1.3 left half's file) is refused in a
     sentence that says how to install it by hand.
  6. Install by hand, both halves updated: one file, either half, the other half
     follows by itself; Connect reads both halves, puts the layout back and says it's
     done. No Next buttons and no check marks before.
  7. Install by hand, one half still old: that half's steps, then Connect again.
  8. Which half is which (one-image firmware): a half without a side, or two on one
     side, on the Firmware card; before an update; after an update (sides the
     firmware picked shown once: That's right or Swap; a half that came back
     unknown); after an install by hand. The answer is the confirmation: one click.
  9. One line, at phone width (430 px) and desktop, light and dark: no sideways
     scroll; titles, choices and buttons each on one line; one title per dialog,
     and it names the dialog. Plain words only.
 10. The reset notice after new firmware: "Your layout was reset", a Firmware line (what
     the halves run now) and a Layout line (the backup, by when and why it was saved,
     never by a firmware version); Restore my layout leads, Start from the default
     layout beside it, Other backups a link. One row at 1280 px, stacked at 390 px,
     never wrapped; light and dark.
 11. Reading the board: Check again beside the halves (busy while it reads); a missed
     INFO is retried (&infofail=1), a board that doesn't answer until Check again says
     Keybard couldn't read the firmware, and Check again reads it (&infofail=read), one that keeps failing never
     offers Install by hand (&infofail=always).
 12. The mule's timing (the default) and twice it (&timing=slow): updates end on the new
     release; old firmware still answering after its COMMIT (&slowcommit=8000) is waited
     out, never reported as "Update stopped".

FW_SHOTS=<folder> also saves a phone-width (light) screenshot of every state there,
the reset notice at desktop and phone width (22-reset-dialog-desktop.png,
23-reset-dialog-phone.png), and the card with Check again and the couldn't-read card
(24-card-check-again.png, 25-card-couldnt-read.png).
Same server options as combo_editor_e2e.py (E2E_URL, E2E_SKIP_BUILD). E2E_URL must
be a test-site build (VITE_STORAGE_NAMESPACE=keybard-test), e.g.
https://morganvenable.github.io/keybard-test/. Exits 1 when a check fails.
"""
import gzip
import os
import re
import sys
import tempfile

# The mock board ships only in development and test-site builds.
os.environ.setdefault("VITE_STORAGE_NAMESPACE", "keybard-test")

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from combo_editor_e2e import app_url  # noqa: E402

BASE = "?demo&fwfake=1&panel=firmware"
PROTO4 = f"{BASE}&speed=4"
PROTO3 = f"{BASE}&proto=3&running=x3.1.3&speed=20"
SHOTS = os.environ.get("FW_SHOTS")
PHONE = {"width": 430, "height": 932}
DESKTOP = {"width": 1440, "height": 900}
DESKTOP_1280 = {"width": 1280, "height": 800}
PHONE_390 = {"width": 390, "height": 844}
WORDS = re.compile(r"\b(hold|approv\w*|chord\w*|TRRS|Viable|Keybard Host|keybard-ng|svup)\b", re.I)
FIXTURES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "firmware")


def fixture_file(name: str) -> str:
    """A gzipped firmware fixture, unpacked to a temp file under its real name."""
    out = os.path.join(tempfile.mkdtemp(prefix="kb-fw-"), name[:-3])
    with gzip.open(os.path.join(FIXTURES, name), "rb") as src, open(out, "wb") as dst:
        dst.write(src.read())
    return out


def open_firmware(browser, url: str, query: str, theme: str = "light", viewport=None):
    context = browser.new_context(viewport=viewport or DESKTOP, color_scheme=theme, reduced_motion="reduce")
    page = context.new_page()
    errors, dialogs = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # A native confirm or alert would freeze the page mid-install on a real keyboard.
    page.on("dialog", lambda d: (dialogs.append(f"{d.type}: {d.message}"), d.dismiss()))
    page.goto(f"{url}{query}&theme={theme}")
    expect(page.get_by_test_id("firmware-section")).to_be_visible(timeout=30000)
    return context, page, errors, dialogs


ONE_LINE_JS = """(sel) => {
    const rows = [...document.querySelectorAll(sel)].filter((el) => el.offsetParent).map((el) => {
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        return { text: el.textContent.trim().slice(0, 60), lines: Math.round((el.getBoundingClientRect().height - pad) / lh) };
    });
    return { count: rows.length, wrapped: rows.filter((r) => r.lines > 1) };
}"""

WIDE_JS = """() => {
    const d = document.querySelector('[role=dialog]');
    return { page: document.documentElement.scrollWidth > innerWidth, dialog: !!d && d.scrollWidth > d.clientWidth + 1 };
}"""

TITLES_JS = """() => {
    const d = document.querySelector('[role=dialog]');
    if (!d) return null;
    const heads = [...d.querySelectorAll('h1,h2,h3,[role=heading]')].filter((h) => h.offsetParent);
    const by = d.getAttribute('aria-labelledby');
    const label = by ? document.getElementById(by)?.textContent.trim() : d.getAttribute('aria-label');
    const hidden = [...d.querySelectorAll('.sr-only')].map((e) => e.textContent.trim()).filter((t) => t && t !== 'Close');
    return { heads: heads.map((h) => h.textContent.trim()), label, hidden };
}"""


RESET_ACTIONS_JS = """() => {
    const box = document.querySelector('[data-testid=reset-actions]');
    const out = { actions: box.getBoundingClientRect().toJSON() };
    for (const b of box.querySelectorAll('button')) out[b.textContent.trim()] = b.getBoundingClientRect().toJSON();
    const link = [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Other backups');
    out.link_border = parseFloat(getComputedStyle(link).borderTopWidth) > 0;
    return out;
}"""


def main() -> int:
    failures = []

    def check(ok: bool, what: str):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    def shot(page, name: str):
        if not SHOTS or page.viewport_size["width"] != PHONE["width"]:
            return
        os.makedirs(SHOTS, exist_ok=True)
        target = page.locator("[role=dialog]") if page.locator("[role=dialog]").count() else page.get_by_test_id("firmware-section")
        target.first.screenshot(path=os.path.join(SHOTS, f"{name}.png"), animations="disabled")

    def layout(page, label: str):
        wide = page.evaluate(WIDE_JS)
        check(not any(wide.values()), f"{label}: no sideways scroll {wide}")
        rows = page.evaluate(ONE_LINE_JS, "[role=dialog] [data-testid=layout-choice] label, [role=dialog] h2, [role=dialog] button, [data-testid=firmware-section] button, [data-testid=firmware-halves] dd")
        check(rows["count"] > 0 and not rows["wrapped"], f"{label}: each of {rows['count']} titles, choices and buttons on one line {rows['wrapped']}")
        t = page.evaluate(TITLES_JS)
        if t:
            check(len(t["heads"]) == 1 and t["label"] == t["heads"][0] and not t["hidden"], f"{label}: one title, and it names the dialog {t}")
            text = page.locator("[role=dialog]").first.inner_text()
            check(not WORDS.search(text.replace("hold them for a second", "")), f"{label}: plain words only")
        card = page.get_by_test_id("firmware-section").inner_text()
        check(not WORDS.search(card), f"{label}: plain words on the card")

    def wait_result(page, label: str):
        """Until Done; says whether the two keys were asked for more than once."""
        result = page.get_by_test_id("update-result")
        confirm = page.get_by_test_id("update-confirm")
        saw_confirm, again = False, False
        for _ in range(360):
            if result.count():
                break
            if confirm.count():
                if saw_confirm == "gone":
                    again = True
                saw_confirm = True
            elif saw_confirm is True:
                saw_confirm = "gone"
            page.wait_for_timeout(500)
        expect(result).to_be_visible(timeout=5000)
        check(not again, f"{label}: asked for the keys once")
        return result

    def update_flow(page, label: str, shots: bool):
        section = page.get_by_test_id("firmware-section")
        expect(section.get_by_text("x4 is available")).to_be_visible(timeout=15000)
        check(section.get_by_role("link", name="What's new in x4 ↗").count() == 1, f"{label}: What's new links the release notes")
        check(section.get_by_text("· plugged in").count() == 1, f"{label}: the plugged-in half is named")
        layout(page, f"{label} card")
        if shots:
            shot(page, "01-card")
            section.get_by_role("button", name="Other versions and files").click()
            check(section.get_by_role("button", name="Install a firmware file…").count() == 1, f"{label}: Install a firmware file…")
            shot(page, "02-card-other-versions")
            section.get_by_role("button", name="Other versions and files").click()
        section.get_by_role("button", name="Update to x4").click()
        sheet = page.get_by_test_id("update-sheet")
        expect(sheet.get_by_text("Saved to Downloads")).to_be_visible(timeout=20000)
        check(sheet.get_by_text("Keybard updates both halves through the cable to your computer. It takes about 2 minutes.").count() == 1, f"{label}: one sentence")
        check(sheet.get_by_role("radio", name="Restore my layout").is_checked(), f"{label}: Restore my layout chosen")
        check(page.get_by_test_id("update-confirm").count() == 0, f"{label}: no confirm screen before Update")
        check(sheet.locator("[data-problem]").count() == 0, f"{label}: no checks shown when they all pass")
        layout(page, f"{label} start")
        if shots:
            shot(page, "03-update-start")
        sheet.get_by_role("button", name="Update", exact=True).click()
        confirm = page.get_by_test_id("update-confirm")
        expect(confirm).to_be_visible(timeout=20000)
        check("press M and , together and hold them for a second" in confirm.inner_text(), f"{label}: says what to press and how")
        check("On the right half" in confirm.inner_text(), f"{label}: says which half")
        check(confirm.get_by_text("Firmware only changes when someone at the keyboard says so.").count() == 1, f"{label}: says why")
        if shots:
            shot(page, "04-update-confirm")
        layout(page, f"{label} confirm")
        progress = page.get_by_test_id("update-progress")
        expect(progress).to_be_visible(timeout=20000)
        check(confirm.count() == 0, f"{label}: the confirm screen goes once the keys are pressed")
        check(progress.get_by_role("progressbar").count() == 1, f"{label}: one progress bar")
        layout(page, f"{label} updating")
        if shots:
            page.wait_for_timeout(1500)
            shot(page, "05-update-updating")
        result = wait_result(page, label)
        check(result.get_by_role("heading", name="x4 is installed").count() == 1, f"{label}: x4 is installed")
        check(result.get_by_text("Your layout is back on the keyboard.").count() == 1, f"{label}: layout is back")
        layout(page, f"{label} done")
        if shots:
            shot(page, "06-update-done")

    def manual_open(page, label: str):
        section = page.get_by_test_id("firmware-section")
        expect(section.get_by_text("x3.1.3")).to_be_visible(timeout=15000)
        check(section.get_by_text("vNext1").count() == 0, f"{label}: no vNext1 label")
        section.get_by_role("button", name="Update to x4").click()
        dialog = page.get_by_test_id("manual-install")
        expect(dialog.get_by_text("Kip-layout-2026-10-15-0626.svil")).to_be_visible(timeout=15000)
        return dialog

    def answer_sides(scope, answer: str, label: str, primary=None):
        """Which half is plugged in: the likely half is the main button; one click sets the sides."""
        fix = scope.get_by_test_id("side-fix")
        expect(fix).to_be_visible(timeout=20000)
        for side in ("left", "right"):
            button = fix.locator(f'[data-side-answer="{side}"]')
            if button.count():
                cls = button.get_attribute("class") or ""
                check(("bg-kb-primary" in cls) == (side == primary), f"{label}: {side} {'is' if side == primary else 'is not'} the main button")
        check(fix.get_by_role("button", name="Set the sides").count() == 0, f"{label}: no second step before the write")
        fix.locator(f'[data-side-answer="{answer}"]').click()

    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()

        # 1. Update from Keybard, phone and desktop, light and dark.
        for vp_name, vp in [("phone", PHONE), ("desktop", DESKTOP)]:
            for theme in ["light", "dark"]:
                label = f"{vp_name} {theme} update"
                context, page, errors, dialogs = open_firmware(browser, url, PROTO4, theme, vp)
                update_flow(page, label, shots=vp is PHONE and theme == "light")
                check(not dialogs, f"{label}: no native dialogs {dialogs}")
                check(not errors, f"{label}: no page errors {errors}")
                context.close()

        # 2. A warning: an older release. A sentence and what to do; Update anyway.
        for vp_name, vp in [("phone", PHONE), ("desktop", DESKTOP)]:
            context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&speed=20", "light", vp)
            section = page.get_by_test_id("firmware-section")
            expect(section.get_by_text("Your keyboard has the newest firmware.")).to_be_visible(timeout=15000)
            section.get_by_role("button", name="Other versions and files").click()
            section.get_by_role("button", name="Install v3").click()
            sheet = page.get_by_test_id("update-sheet")
            expect(sheet.get_by_text("v3 is older than x4.")).to_be_visible(timeout=20000)
            check(sheet.get_by_text("Parts of your layout added since v3 won't come back.").count() == 1, f"{vp_name} warning: says what it means")
            expect(sheet.get_by_role("button", name="Update anyway")).to_be_enabled(timeout=20000)
            layout(page, f"{vp_name} warning")
            shot(page, "07-update-warning")
            sheet.get_by_role("button", name="Update anyway").click()
            expect(page.get_by_test_id("update-result")).to_be_visible(timeout=60000)
            check(page.get_by_role("heading", name="v3 is installed").count() == 1, f"{vp_name} warning: v3 installed")
            check(not errors, f"{vp_name} warning: no page errors {errors}")
            context.close()

        # 3. A refusal: the carried file misses its pin. Reload and Close, no Update.
        for vp_name, vp in [("phone", PHONE), ("desktop", DESKTOP)]:
            context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&badfile=1&speed=20", "light", vp)
            page.get_by_test_id("firmware-section").get_by_role("button", name="Update to x4").click()
            sheet = page.get_by_test_id("update-sheet")
            expect(sheet.get_by_text("The firmware file failed its check.")).to_be_visible(timeout=20000)
            check(sheet.get_by_role("button", name="Reload").count() == 1 and sheet.get_by_role("button", name="Close").count() == 1, f"{vp_name} refusal: Reload and Close")
            check(sheet.get_by_role("button", name=re.compile(r"^Update")).count() == 0, f"{vp_name} refusal: no Update")
            check(sheet.get_by_role("radio").count() == 0, f"{vp_name} refusal: no layout choice")
            layout(page, f"{vp_name} refusal")
            shot(page, "08-update-refused")
            context.close()

        # 4. Install from a file: one .uf2, both halves. The zero-click link (&pick=x4)
        #    chooses the carried file through the card's file input; then the real pair
        #    UF2 from the firmware branch through the same input.
        for theme in ["light", "dark"]:
            label = f"{theme} from file"
            context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&pick=x4&speed=20", theme, PHONE)
            sheet = page.get_by_test_id("update-sheet")
            expect(sheet.get_by_text("Saved to Downloads")).to_be_visible(timeout=20000)
            check(page.get_by_role("heading", name="Update to x4").count() == 1, f"{label}: the file is x4, matched to its pin")
            check(sheet.get_by_text("Keybard updates both halves through the cable to your computer. It takes about 2 minutes.").count() == 1, f"{label}: both halves from one file")
            layout(page, label)
            if theme == "light":
                shot(page, "13-from-file-start")
            sheet.get_by_role("button", name="Update", exact=True).click()
            result = wait_result(page, label)
            check(result.get_by_role("heading", name="x4 is installed").count() == 1, f"{label}: x4 is installed on both halves")
            page.get_by_role("button", name="Done").click()
            expect(page.get_by_test_id("firmware-halves")).to_contain_text("x4")
            check(page.get_by_test_id("firmware-halves").inner_text().count("x4") == 2, f"{label}: both halves run x4")
            check(not errors, f"{label}: no page errors {errors}")
            context.close()
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&speed=20", "light", DESKTOP)
        page.get_by_test_id("firmware-file-input").set_input_files(fixture_file("svalboard_sval_x4.uf2.gz"))
        sheet = page.get_by_test_id("update-sheet")
        expect(sheet.get_by_text("Keybard can't check where this file came from.")).to_be_visible(timeout=20000)
        check(page.get_by_role("heading", name="Install custom firmware").count() == 1, "real pair UF2: read, both halves, not a carried release")
        check(not errors, f"real pair UF2: no page errors {errors}")
        context.close()

        # 5. An older per-side file: refused with the steps by hand. The real x3.1.3 file, then the review link.
        for theme in ["light", "dark"]:
            context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&speed=20", theme, PHONE)
            page.get_by_test_id("firmware-file-input").set_input_files(fixture_file("svalboard_left_sval_x3.1.3.uf2.gz"))
            error = page.get_by_test_id("firmware-file-error")
            expect(error).to_be_visible(timeout=10000)
            check(error.inner_text() == "Keybard installs only firmware files that update both halves, from x4 on. To install this file by hand, plug in the half it's for, press its RESET button twice, then drag the file onto the RPI-RP2 drive.", f"{theme} per-side file: refused in a sentence, with the steps by hand")
            check(page.locator("[role=dialog]").count() == 0, f"{theme} per-side file: nothing opens")
            layout(page, f"{theme} per-side file")
            check(not errors, f"{theme} per-side file: no page errors {errors}")
            context.close()
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&pick=x3.1.3", "light", PHONE)
        expect(page.get_by_test_id("firmware-file-error")).to_be_visible(timeout=15000)
        shot(page, "14-per-side-file-refused")
        context.close()

        # 6. Install by hand, both halves updated: one file, either half; Connect, the layout back, Done.
        for vp_name, vp in [("phone", PHONE), ("desktop", DESKTOP)]:
            for theme in ["light", "dark"]:
                label = f"{vp_name} {theme} by hand"
                context, page, errors, dialogs = open_firmware(browser, url, PROTO3, theme, vp)
                dialog = manual_open(page, label)
                check(dialog.get_by_role("button", name="Next").count() == 0, f"{label}: no Next buttons")
                check(dialog.locator("svg").count() == 0, f"{label}: no check marks")
                check(dialog.get_by_role("radio", name="Restore my layout").is_checked(), f"{label}: Restore my layout chosen")
                check(dialog.get_by_role("radio", name="Start from a blank keyboard").count() == 0, f"{label}: no blank keyboard")
                text = dialog.inner_text()
                check("about a quarter of a second apart" in text, f"{label}: the reset timing")
                check(dialog.locator("[data-file]").count() == 1, f"{label}: one file")
                check(dialog.locator("[data-file]").get_attribute("download") == "svalboard_sval_x4.uf2", f"{label}: the x4 pair file")
                check("either half's U port" in text, f"{label}: either half")
                check("The other half updates by itself, in about half a minute. Keep the split cable connected." in text, f"{label}: the other half follows")
                check("Then move the cable" not in text, f"{label}: no second half to do by hand")
                layout(page, f"{label} instructions")
                if vp is PHONE and theme == "light":
                    shot(page, "09-by-hand-instructions")
                dialog.get_by_role("button", name="Connect keyboard").click()
                expect(dialog.get_by_role("heading", name="x4 is installed")).to_be_visible(timeout=20000)
                check(dialog.get_by_text("Your layout is back on the keyboard. From now on, updates install from Keybard.").count() == 1, f"{label}: layout back")
                layout(page, f"{label} done")
                if vp is PHONE and theme == "light":
                    shot(page, "12-by-hand-done")
                dialog.get_by_role("button", name="Done").click()
                expect(dialog).to_be_hidden()
                expect(page.get_by_test_id("firmware-halves")).to_contain_text("x4")
                check(page.get_by_test_id("firmware-halves").inner_text().count("x4") == 2, f"{label}: both halves on x4")
                check(not dialogs, f"{label}: no native dialogs {dialogs}")
                check(not errors, f"{label}: no page errors {errors}")
                context.close()

        # 7. Install by hand, one half still old: that half's steps; Connect again finishes.
        for vp_name, vp in [("phone", PHONE), ("desktop", DESKTOP)]:
            label = f"{vp_name} one half"
            context, page, errors, dialogs = open_firmware(browser, url, f"{PROTO3}&byhand=right", "light", vp)
            dialog = manual_open(page, label)
            dialog.get_by_role("button", name="Connect keyboard").click()
            expect(dialog.get_by_role("heading", name="The left half still runs x3.1.3")).to_be_visible(timeout=20000)
            check(dialog.get_by_text("The right half has x4. Install the file on the left half, then connect again.").count() == 1, f"{label}: names both halves")
            check(dialog.locator("[data-file]").count() == 1, f"{label}: the one file")
            check("left half's U port" in dialog.inner_text() and "right half's U port" not in dialog.inner_text(), f"{label}: only the left half's steps")
            layout(page, f"{label}")
            shot(page, "10-by-hand-one-half")
            dialog.get_by_role("button", name="Connect again").click()
            expect(dialog.get_by_role("heading", name="x4 is installed")).to_be_visible(timeout=20000)
            check(not errors, f"{label}: no page errors {errors}")
            context.close()

        # Neither half changed: the instructions with one line (screenshot only at phone width).
        context, page, errors, dialogs = open_firmware(browser, url, f"{PROTO3}&byhand=none", "light", PHONE)
        dialog = manual_open(page, "neither")
        dialog.get_by_role("button", name="Connect keyboard").click()
        expect(dialog.get_by_test_id("manual-still")).to_be_visible(timeout=20000)
        check(dialog.get_by_role("heading", name="Install x4 by hand").count() == 1, "neither: the instructions stay")
        check(dialog.get_by_test_id("manual-still").inner_text() == "The right half still runs x3.1.3. Install the file on it, then connect again.", "neither: one line")
        shot(page, "11-by-hand-neither")
        context.close()

        # 8. Which half is which (one-image firmware).
        # On the card: (scenario, answer, the main button, the half it sets, shot)
        for scenario, answer, primary, shot_name in [
            ("unknown-other", "right", "right", "15-sides-card-unknown"),
            ("same", "right", None, "16-sides-card-same"),
            ("unknown-both", "left", None, None),
        ]:
            for theme in ["light", "dark"]:
                label = f"{theme} card {scenario}"
                context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&sides={scenario}&speed=20", theme, PHONE)
                section = page.get_by_test_id("firmware-section")
                expect(section.get_by_test_id("firmware-sides")).to_be_visible(timeout=20000)
                check(section.get_by_text("Set which half is which").count() == 1, f"{label}: says what to do")
                check(section.get_by_role("button", name=re.compile(r"^Update")).count() == 0, f"{label}: no update offered until it's answered")
                layout(page, label)
                if theme == "light" and shot_name:
                    shot(page, shot_name)
                answer_sides(section, answer, label, primary)
                expect(section.get_by_test_id("firmware-sides")).to_have_count(0, timeout=30000)
                expect(page.get_by_test_id("firmware-halves")).to_be_visible(timeout=10000)
                check(not errors, f"{label}: no page errors {errors}")
                context.close()

        # A thumb PCBA that says the other side: explained, with the support link; nothing retried.
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&sides=strap-same&speed=20", "light", PHONE)
        section = page.get_by_test_id("firmware-section")
        answer_sides(section, "left", "strap", primary="right")
        note = section.get_by_test_id("side-note")
        expect(note).to_contain_text("right thumb PCBA", timeout=20000)
        check("https://www.svalboard.com/discord" in note.inner_text(), "strap: the support link")
        layout(page, "strap")
        shot(page, "17-sides-thumb-pcba")
        context.close()

        # Before an update: the sheet asks first, then offers the update.
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&sides=same&open=update&speed=20", "light", PHONE)
        first = page.get_by_test_id("sheet-sides")
        expect(first).to_be_visible(timeout=20000)
        check(page.get_by_role("heading", name="Set which half is which first").count() == 1, "sheet first: the title")
        layout(page, "sheet first")
        shot(page, "18-sides-before-update")
        answer_sides(first, "right", "sheet first")
        expect(page.get_by_test_id("update-sheet")).to_be_visible(timeout=30000)
        expect(page.get_by_test_id("update-sheet").get_by_role("button", name="Update", exact=True)).to_be_enabled(timeout=20000)
        check(not errors, f"sheet first: no page errors {errors}")
        context.close()

        # After an update: (scenario, what to do, the result line, shot)
        def thats_right(box, page):
            check(box.get_by_text("Each half kept the side of the firmware it ran before.").count() == 1, "migrate: says where the sides came from")
            box.locator('[data-side-action="confirm"]').click()

        def swap(box, page):
            box.locator('[data-side-action="swap"]').click()

        def keep_right(box, page):
            check(box.get_by_text("Keep the plugged-in half as the right half?").count() == 1, "after-unknown: Keep the plugged-in half as the right half?")
            box.locator('[data-side-answer="right"]').click()

        for scenario, act, line, shot_name, title in [
            ("migrate", thats_right, None, "19-sides-after-update-confirm", "Check which half is which"),
            ("migrate", swap, "Each half knows its side now.", None, "Check which half is which"),
            ("after-unknown", keep_right, "Each half knows its side now.", "20-sides-after-update-unknown", "Set which half is which"),
        ]:
            for theme in ["light", "dark"]:
                label = f"{theme} update {scenario} {act.__name__}"
                context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&sides={scenario}&open=update&go=1&speed=20", theme, PHONE)
                box = page.get_by_test_id("flow-sides")
                expect(box).to_be_visible(timeout=120000)
                check(page.get_by_role("heading", name=title).count() == 1, f"{label}: {title}")
                check(box.get_by_role("button", name="Set the sides").count() == 0, f"{label}: no second step")
                layout(page, label)
                if theme == "light" and shot_name:
                    shot(page, shot_name)
                act(box, page)
                result = page.get_by_test_id("update-result")
                expect(result).to_be_visible(timeout=120000)
                check(result.get_by_role("heading", name="x4 is installed").count() == 1, f"{label}: x4 is installed")
                if line:
                    check(line in result.inner_text(), f"{label}: {line}")
                else:
                    check("knows its side" not in result.inner_text(), f"{label}: nothing set, nothing said")
                check(page.get_by_text("Halves differ").count() == 0, f"{label}: no Halves differ afterward")
                check(not errors, f"{label}: no page errors {errors}")
                context.close()

        # Sides Keybard read before, unchanged after the update: nothing asked.
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&sides=ok&open=update&go=1&speed=20", "light", DESKTOP)
        result = page.get_by_test_id("update-result")
        saw = False
        for _ in range(240):
            if result.count():
                break
            saw = saw or page.get_by_test_id("flow-sides").count() > 0
            page.wait_for_timeout(500)
        expect(result).to_be_visible(timeout=5000)
        check(not saw, "sides known before: nothing asked after the update")
        context.close()

        # After an install by hand, a half without a side: which is which first, then the layout goes back.
        context, page, errors, dialogs = open_firmware(browser, url, f"{PROTO3}&sides=after-unknown", "light", PHONE)
        dialog = manual_open(page, "by hand sides")
        dialog.get_by_role("button", name="Connect keyboard").click()
        expect(dialog.get_by_role("heading", name="Set which half is which")).to_be_visible(timeout=20000)
        layout(page, "by hand sides")
        shot(page, "21-sides-after-by-hand")
        answer_sides(dialog, "right", "by hand sides")
        expect(dialog.get_by_role("heading", name="x4 is installed")).to_be_visible(timeout=30000)
        check(dialog.get_by_text("Your layout is back on the keyboard. From now on, updates install from Keybard.").count() == 1, "by hand sides: layout back")
        check(not errors, f"by hand sides: no page errors {errors}")
        context.close()

        # The reset notice after new firmware: what's installed, and three answers that never wrap.
        for theme in ["light", "dark"]:
            for viewport, size in [(DESKTOP_1280, "desktop"), (PHONE_390, "phone")]:
                label = f"{theme} {size} reset notice"
                context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4test9&resetnotice=1", theme, viewport)
                notice = page.get_by_test_id("reset-notice")
                expect(notice).to_be_visible(timeout=20000)
                check(page.get_by_role("heading", name="Your layout was reset").count() == 1, f"{label}: the title")
                firmware = notice.get_by_test_id("reset-firmware").inner_text().strip()
                check(firmware == "x4test9 on both halves", f"{label}: the Firmware line ({firmware!r})")
                backup = notice.get_by_test_id("reset-backup").inner_text().strip()
                check(backup.startswith("Backup saved before the update, today"), f"{label}: the Layout line by when and why ({backup!r})")
                check(not re.search(r"\bx\d|\bv\d", backup), f"{label}: no firmware version in the Layout line ({backup!r})")
                check(notice.get_by_text("Firmware", exact=True).count() == 1 and notice.get_by_text("Layout", exact=True).count() == 1, f"{label}: the two parts are labeled")
                layout(page, label)
                boxes = page.evaluate(RESET_ACTIONS_JS)
                primary, defaults, other = boxes["Restore my layout"], boxes["Start from the default layout"], boxes["Other backups"]
                if size == "desktop":
                    row = abs(primary["top"] - defaults["top"]) < 2 and abs(primary["top"] - other["top"]) < 2
                    check(row, f"{label}: one row {boxes}")
                    check(other["left"] < defaults["left"] < primary["left"], f"{label}: Other backups left, Restore my layout right {boxes}")
                else:
                    check(primary["top"] < defaults["top"] < other["top"], f"{label}: Restore my layout first, stacked {boxes}")
                    full = abs(primary["width"] - defaults["width"]) < 2 and primary["width"] > boxes["actions"]["width"] - 2
                    check(full, f"{label}: full-width buttons {boxes}")
                check(not boxes["link_border"], f"{label}: Other backups is a link, not a button {boxes}")
                if SHOTS and theme == "light":
                    os.makedirs(SHOTS, exist_ok=True)
                    name = "22-reset-dialog-desktop" if size == "desktop" else "23-reset-dialog-phone"
                    page.locator("[role=dialog]").first.screenshot(path=os.path.join(SHOTS, f"{name}.png"), animations="disabled")
                check(not errors, f"{label}: no page errors {errors}")
                context.close()

        # 11. Reading the board: Check again, and a board that doesn't answer at first.
        def card_shot(page, name: str):
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                page.get_by_test_id("firmware-section").screenshot(path=os.path.join(SHOTS, f"{name}.png"), animations="disabled")

        for theme in ["light", "dark"]:
            label = f"{theme} check again"
            context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&speed=4", theme, PHONE)
            section = page.get_by_test_id("firmware-section")
            expect(section.get_by_test_id("firmware-halves")).to_contain_text("x4", timeout=20000)
            recheck = section.get_by_test_id("firmware-recheck")
            expect(recheck).to_have_text("Check again", timeout=20000)
            check(recheck.get_attribute("title") == "Read the keyboard's firmware again", f"{label}: says what it does on hover")
            layout(page, label)
            if theme == "light":
                card_shot(page, "24-card-check-again")
            # The read is quick on the mock board: record the busy state as it happens.
            page.evaluate("""() => { window.__sawChecking = false; const el = document.querySelector('[data-testid=firmware-recheck]');
                new MutationObserver(() => { if (el.textContent === 'Checking…' && el.disabled) window.__sawChecking = true; }).observe(el, { subtree: true, childList: true, characterData: true, attributes: true }); }""")
            recheck.click()
            expect(recheck).to_have_text("Check again", timeout=20000)
            check(page.evaluate("() => window.__sawChecking"), f"{label}: Checking… while it reads")
            check(section.get_by_test_id("firmware-halves").inner_text().count("x4") == 2, f"{label}: both halves read again")
            check(not errors, f"{label}: no page errors {errors}")
            context.close()

        # The first INFO missed: Keybard tries again and reads the board, no other card.
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&infofail=1&speed=4", "light", PHONE)
        section = page.get_by_test_id("firmware-section")
        expect(section.get_by_test_id("firmware-halves")).to_contain_text("x4", timeout=20000)
        check(section.get_by_role("button", name="Install by hand").count() == 0, "infofail=1: no Install by hand")
        check(section.get_by_test_id("firmware-unread").count() == 0, "infofail=1: read on a retry")
        context.close()

        # The whole first read missed: Keybard couldn't read the firmware; Check again reads it.
        for theme in ["light", "dark"]:
            label = f"{theme} couldn't read"
            context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&infofail=read&speed=4", theme, PHONE)
            section = page.get_by_test_id("firmware-section")
            unread = section.get_by_test_id("firmware-unread")
            expect(unread).to_be_visible(timeout=20000)
            check(unread.get_by_text("Keybard couldn't read the firmware.").count() == 1, f"{label}: says so")
            check(section.get_by_role("button", name="Install by hand").count() == 0, f"{label}: no Install by hand")
            check(section.get_by_role("button", name=re.compile(r"^Update")).count() == 0, f"{label}: no update offered on a guess")
            # Opening the card reads it once more: wait for that read to end too.
            expect(section.get_by_test_id("firmware-unread-recheck")).to_have_text("Check again", timeout=20000)
            layout(page, label)
            if theme == "light":
                card_shot(page, "25-card-couldnt-read")
            section.get_by_role("button", name="Check again").click()
            expect(section.get_by_test_id("firmware-halves")).to_contain_text("x4", timeout=20000)
            check(unread.count() == 0, f"{label}: Check again reads the board")
            check(not errors, f"{label}: no page errors {errors}")
            context.close()

        # A board that keeps not answering: still never Install by hand.
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&infofail=always&speed=4", "light", PHONE)
        section = page.get_by_test_id("firmware-section")
        expect(section.get_by_test_id("firmware-unread")).to_be_visible(timeout=20000)
        section.get_by_role("button", name="Check again").click()
        page.wait_for_timeout(500)
        expect(section.get_by_role("button", name="Check again")).to_be_enabled(timeout=20000)
        check(section.get_by_test_id("firmware-unread").count() == 1, "infofail=always: still couldn't read")
        check(section.get_by_role("button", name="Install by hand").count() == 0, "infofail=always: no Install by hand")
        context.close()

        # 12. Timing: twice the mule's, and a half that keeps running its old firmware after COMMIT.
        for query, label in [
            (f"{BASE}&timing=slow&pick=x4&speed=8", "slow timing from file"),
            (f"{BASE}&slowcommit=8000&pick=x4&speed=4", "slow commit from file"),
            # A reinstall of the version the board runs (the mule: x4test12 over x4test12).
            (f"{BASE}&running=x4&pick=x4&speed=4", "reinstall from file"),
            (f"{BASE}&running=x4&pick=x4&fault=commit-reply-lost&speed=4", "reinstall, COMMIT reply lost"),
            (f"{BASE}&running=x4&slowcommit=8000&pick=x4&speed=4", "reinstall, slow commit"),
        ]:
            context, page, errors, dialogs = open_firmware(browser, url, query, "light", DESKTOP)
            sheet = page.get_by_test_id("update-sheet")
            expect(sheet.get_by_text("Saved to Downloads")).to_be_visible(timeout=20000)
            sheet.get_by_role("button", name="Update", exact=True).click()
            result = page.get_by_test_id("update-result")
            failed = page.locator("[data-failure]")
            for _ in range(480):
                if result.count() or failed.count():
                    break
                page.wait_for_timeout(500)
            check(failed.count() == 0, f"{label}: no failure ({failed.first.get_attribute('data-failure') if failed.count() else ''})")
            check(result.count() == 1 and result.get_by_role("heading", name="x4 is installed").count() == 1, f"{label}: x4 is installed")
            check(not errors, f"{label}: no page errors {errors}")
            context.close()

        # Reinstall from Other versions: Reinstall x4 on a board on x4.
        context, page, errors, dialogs = open_firmware(browser, url, f"{BASE}&running=x4&speed=4", "light", DESKTOP)
        section = page.get_by_test_id("firmware-section")
        expect(section.get_by_text("Your keyboard has the newest firmware.")).to_be_visible(timeout=20000)
        section.get_by_role("button", name="Other versions and files").click()
        section.get_by_role("button", name="Reinstall x4").click()
        sheet = page.get_by_test_id("update-sheet")
        primary = sheet.locator("[data-primary]")
        expect(primary).to_be_enabled(timeout=20000)
        primary.click()
        result = page.get_by_test_id("update-result")
        expect(result).to_be_visible(timeout=120000)
        check(result.get_by_role("heading", name="x4 is installed").count() == 1, "Reinstall x4: x4 is installed")
        check(page.locator("[data-failure]").count() == 0, "Reinstall x4: no failure")
        context.close()

        browser.close()

    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
