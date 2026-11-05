"""
Browser test of how Keybard names its releases, with the other site's
version.json mocked. Run with `npm run test:e2e:about-versions`.

Builds three Keybards:
- next.keybard.svalboard.com (x4.4, --mode next);
- keybard.svalboard.com (v4.3.6, --mode svalboard), built with the test site's
  storage namespace so ?fwfake=1 can stand in for a keyboard on Unstable firmware;
- an untagged build.
Each is opened at ?panel=about in light and dark theme.

  1. About says which Keybard this is in one sentence, then one table on every
     site: Release, Keybard, Firmware, Site; Stable then Unstable. The current
     release's row is bold; an untagged build has no bold row. Each site is a link.
     The section has no parentheticals.
  2. Release notes link this release's notes (the releases list when untagged).
  3. On next, the banner names the Stable firmware and the Stable site.
  4. When version.json cannot be read, that release's values are blank and the
     banner names only the site.
  5. Every text in About and the banner has a contrast of at least 4.5:1 (AA).
     At phone width (375 px) the rows stack and fit, with no sideways scroll.
  6. On keybard.svalboard.com with a keyboard on Unstable firmware x4.4, the
     editor shows one notice line and About a sentence, each linking next.
  7. No page errors.

E2E_SKIP_BUILD reuses the last builds. E2E_SHOTS=<dir> saves screenshots of
About (desktop and phone), the banner and the notice per site and theme.
Exits 1 when a check fails.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from combo_editor_e2e import NPX, ROOT, free_port  # noqa: E402
from select_contrast_e2e import contrast, rgba  # noqa: E402

BASE_PATH = "/keybard-e2e-about/"
ABOUT = "#settings-section-about"
# About's own content: the sentence, the table, the notice sentence and the links (not the card's other rows).
ABOUT_BODY = "[data-about]"
TABLE = "table[data-about-releases]"
FILES = {
    "https://keybard.svalboard.com/version.json": {"tag": "v4.3.6", "firmware": "v4.3.5"},
    "https://next.keybard.svalboard.com/version.json": {"tag": "x4.4", "firmware": "x4.4"},
}
# name, vite mode, RELEASE_TAG, extra env
BUILDS = [
    ("next", "next", "x4.4", {}),
    ("production", "svalboard", "v4.3.6", {"VITE_STORAGE_NAMESPACE": "keybard-test"}),
    ("untagged", "production", "", {}),
]
# This build's own firmware comes from what it carries: today's main carries x4.4 only,
# so keybard.svalboard.com's own firmware is blank, never guessed.
EXPECTED = {
    "next": ("You're using Unstable Keybard x4.4.",
             ["Stable | v4.3.6 | v4.3.5 | keybard.svalboard.com", "*Unstable | x4.4 | x4.4 | next.keybard.svalboard.com"]),
    "production": ("You're using Stable Keybard v4.3.6.",
                   [re.compile(r"^\*Stable \| v4\.3\.6 \| (v[\d.]+)? \| keybard\.svalboard\.com$"), "Unstable | x4.4 | x4.4 | next.keybard.svalboard.com"]),
    "untagged": (re.compile(r"^You're using a development build, commit [0-9a-f]+\.$"),
                 ["Stable | v4.3.6 | v4.3.5 | keybard.svalboard.com", "Unstable | x4.4 | x4.4 | next.keybard.svalboard.com"]),
}
FAILED_READ = {
    "next": (0, "Stable |  |  | keybard.svalboard.com"),
    "production": (1, "Unstable |  |  | next.keybard.svalboard.com"),
}
BANNER = "This is the Unstable release and may break. For the Stable release, flash Stable firmware v4.3.5 and use keybard.svalboard.com."
BANNER_UNKNOWN = "This is the Unstable release and may break. For the Stable release, use keybard.svalboard.com."
NOTICE = "Your keyboard runs Unstable firmware x4.4. Unstable Keybard at next.keybard.svalboard.com goes with it."

failures: list[str] = []


def check(cond: bool, label: str):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


def matches(got, want) -> bool:
    return bool(want.match(got)) if isinstance(want, re.Pattern) else got == want


def out_dir(name: str) -> str:
    return os.path.join(ROOT, f".e2e-dist-about-{name}")


def build(name: str, mode: str, tag: str, extra: dict):
    env = {**os.environ, "RELEASE_TAG": tag, **extra}
    subprocess.run([NPX, "vite", "build", "--mode", mode, f"--base={BASE_PATH}", f"--outDir={out_dir(name)}", "--emptyOutDir"],
                   cwd=ROOT, check=True, env=env)


@contextmanager
def serve(name: str):
    port = free_port()
    server = subprocess.Popen(
        [NPX, "vite", "preview", f"--base={BASE_PATH}", f"--outDir={out_dir(name)}", "--host", "127.0.0.1",
         "--port", str(port), "--strictPort"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}{BASE_PATH}"
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(url, timeout=1)
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError(f"vite preview did not start at {url}")
        yield url
    finally:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(server.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()


# Every text node's element in a subtree: [text, color, first non-transparent background behind it].
READ_COLORS = """(root) => {
    const toRgb = (c) => {
        const x = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        x.clearRect(0, 0, 1, 1); x.fillStyle = c; x.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = x.getImageData(0, 0, 1, 1).data;
        return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    };
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        const el = n.parentElement;
        let e = el, bg = 'rgba(255, 255, 255, 1)';
        while (e) { const b = toRgb(getComputedStyle(e).backgroundColor); if (!b.endsWith(', 0)')) { bg = b; break; } e = e.parentElement; }
        out.push([n.textContent.trim(), toRgb(getComputedStyle(el).color), bg]);
    }
    return out;
}"""


def check_contrast(page, locator, label: str):
    rows = locator.evaluate(READ_COLORS)
    worst = min(((contrast(rgba(c)[:3], rgba(b)[:3]), t, c, b) for t, c, b in rows), default=None)
    check(worst is not None and worst[0] >= 4.5,
          f"{label}: lowest contrast {worst[0]:.1f}:1 ({worst[1]!r}: {worst[2]} on {worst[3]})" if worst else f"{label}: no text")


def mock_version_files(context, reachable: bool, reads: list[str]):
    def version_file(route):
        reads.append(route.request.url)
        body = FILES.get(route.request.url.split("?")[0])
        if not reachable or body is None:
            route.abort()
            return
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body),
                      headers={"Access-Control-Allow-Origin": "*"})
    context.route(re.compile(r"^https://(next\.)?keybard\.svalboard\.com/"), version_file)


def open_page(browser, url: str, theme: str, query: str, reachable: bool = True, width: int = 1440):
    context = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=theme, reduced_motion="reduce")
    reads: list[str] = []
    mock_version_files(context, reachable, reads)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{url}?{query}&theme={theme}")
    if theme == "dark":
        expect(page.locator("html")).to_have_class(re.compile(r"\bdark\b"), timeout=20000)
    return context, page, errors, reads


def open_about(browser, url: str, theme: str, reachable: bool = True, extra: str = ""):
    context, page, errors, reads = open_page(browser, url, theme, f"demo=combos&panel=about{extra}", reachable)
    expect(page.get_by_label("Search settings")).to_be_visible(timeout=20000)
    expect(page.locator(TABLE)).to_be_visible(timeout=10000)
    return context, page, errors, reads


# Each body row as its cells joined with " | ", "*" before the current (bold) row.
READ_ROWS = """t => [...t.tBodies[0].rows].map(r =>
    (r.hasAttribute('data-current') ? '*' : '') + [...r.cells].map(c => {
        const k = c.cloneNode(true); k.querySelectorAll('[data-stack-label]').forEach(l => l.remove());
        return k.textContent.trim();
    }).join(' | '))"""


def rows(page) -> list[str]:
    return page.locator(TABLE).evaluate(READ_ROWS)


def wait_rows(page, want: list) -> list[str]:
    deadline = time.time() + 5
    got = rows(page)
    while time.time() < deadline and not (len(got) == len(want) and all(matches(g, w) for g, w in zip(got, want))):
        page.wait_for_timeout(100)
        got = rows(page)
    return got


def phone(page, name: str, theme: str, shots: str | None):
    """Phone width: each row stacks inside the card, nothing scrolls sideways."""
    page.set_viewport_size({"width": 375, "height": 812})
    page.wait_for_timeout(300)
    page.evaluate(f"() => document.querySelector('{ABOUT}').scrollIntoView({{ block: 'start' }})")
    page.wait_for_timeout(200)
    fit = page.evaluate("""(sel) => {
        const t = document.querySelector(sel), card = document.querySelector('#settings-section-about');
        const cr = card.getBoundingClientRect();
        const cells = [...t.querySelectorAll('tbody th, tbody td')].map(c => c.getBoundingClientRect());
        const rows = [...t.tBodies[0].rows];
        return {
            inside: cells.every(c => c.left >= cr.left - 1 && c.right <= cr.right + 1),
            noScroll: document.documentElement.scrollWidth <= innerWidth + 1,
            stacked: rows.every(r => getComputedStyle(r).display === 'block'),
            labels: [...t.querySelectorAll('[data-stack-label]')].every(l => getComputedStyle(l).display !== 'none' && l.getAttribute('aria-hidden') === 'true'),
            headerHidden: t.tHead.getBoundingClientRect().height <= 1,
        };
    }""", TABLE)
    check(all(fit.values()), f"{name}/{theme}: phone width stacks each row and fits {fit}")
    check_contrast(page, page.locator(ABOUT_BODY), f"{name}/{theme}: About at phone width")
    if shots:
        page.locator(ABOUT).screenshot(path=os.path.join(shots, f"about-{name}-{theme}-phone.png"))
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(300)


def flow(browser, name: str, tag: str, url: str, theme: str, shots: str | None):
    sentence_want, rows_want = EXPECTED[name]
    context, page, errors, reads = open_about(browser, url, theme)
    try:
        about = page.locator(ABOUT)
        got = wait_rows(page, rows_want)
        check(len(got) == len(rows_want) and all(matches(g, w) for g, w in zip(got, rows_want)), f"{name}/{theme}: rows {got}")
        sentence = page.locator("[data-about-using]").inner_text().strip()
        check(matches(sentence, sentence_want), f"{name}/{theme}: sentence {sentence!r}")
        heads = page.locator(TABLE).evaluate("t => [...t.tHead.rows[0].cells].map(c => c.textContent.trim())")
        check(heads == ["Release", "Keybard", "Firmware", "Site"], f"{name}/{theme}: columns {heads}")
        bold = page.locator(TABLE).evaluate("t => [...t.tBodies[0].rows].map(r => getComputedStyle(r.cells[0]).fontWeight)")
        current = [r.startswith("*") for r in got]
        check(all((w == "600") == c for w, c in zip(bold, current)) and all(w == "400" for w, c in zip(bold, current) if not c),
              f"{name}/{theme}: only the current row is bold {bold}")
        colors = page.locator(TABLE).evaluate("t => [...t.tBodies[0].rows].map(r => getComputedStyle(r.cells[1]).color)")
        check(len(set(colors)) == 1, f"{name}/{theme}: bold is the only marker, every row one color {colors}")
        for host in ("keybard.svalboard.com", "next.keybard.svalboard.com"):
            link = page.locator(TABLE).get_by_role("link", name=host, exact=True)
            check(link.count() == 1 and link.get_attribute("href") == f"https://{host}/", f"{name}/{theme}: {host} links to its site")
        check(not re.search(r"[()]|this one", about.inner_text(), re.I), f"{name}/{theme}: no parentheticals in About")
        notes = about.get_by_role("link", name="Release notes").get_attribute("href")
        want_notes = f"https://github.com/svalboard/keybard/releases/tag/{tag}" if tag else "https://github.com/svalboard/keybard/releases"
        check(notes == want_notes, f"{name}/{theme}: release notes link {notes}")
        own = {"next": "next", "production": "keybard"}.get(name)
        check(bool(reads) and (all(("next." in r) != (own == "next") for r in reads) if own else len(reads) == 2),
              f"{name}/{theme}: reads only the other site's version.json ({reads})")
        check_contrast(page, page.locator(ABOUT_BODY), f"{name}/{theme}: About")
        banner = page.get_by_role("note").filter(has_text="Unstable release")
        if name == "next":
            expect(banner).to_have_text(re.compile("firmware"), timeout=5000)
            check(banner.inner_text().strip() == BANNER, f"{name}/{theme}: banner {banner.inner_text()!r}")
            check(banner.get_by_role("link").get_attribute("href") == "https://keybard.svalboard.com/", f"{name}/{theme}: banner links to keybard.svalboard.com")
            check_contrast(page, banner, f"{name}/{theme}: banner")
        else:
            check(banner.count() == 0, f"{name}/{theme}: no Unstable banner")
        check(page.get_by_test_id("about-unstable-firmware").count() == 0, f"{name}/{theme}: no Unstable firmware sentence without such a keyboard")
        if shots:
            os.makedirs(shots, exist_ok=True)
            page.evaluate(f"() => document.querySelector('{ABOUT}').scrollIntoView({{ block: 'center' }})")
            page.wait_for_timeout(200)
            about.screenshot(path=os.path.join(shots, f"about-{name}-{theme}.png"))
        phone(page, name, theme, shots)
        check(not errors, f"{name}/{theme}: no page errors {errors}")
    finally:
        context.close()

    if name in FAILED_READ:
        index, want = FAILED_READ[name]
        context, page, errors, _ = open_about(browser, url, theme, reachable=False)
        try:
            page.wait_for_timeout(800)
            got = rows(page)
            check(got[index] == want, f"{name}/{theme}: unreadable version.json leaves that release blank {got}")
            if name == "next":
                text = page.get_by_role("note").inner_text().strip()
                check(text == BANNER_UNKNOWN, f"{name}/{theme}: banner without a firmware {text!r}")
        finally:
            context.close()

    if name == "next":
        # The banner on its own, with no side panel over it.
        context, page, _, _ = open_page(browser, url, theme, "demo=combos", width=1440)
        try:
            page.get_by_role("note").filter(has_text="firmware").wait_for(timeout=20000)
            page.wait_for_timeout(300)
            box = page.get_by_role("note").bounding_box()
            check(box["height"] <= 24, f"next/{theme}: the banner fits one line at 1440 px ({box['height']:.0f} px)")
            pad = 12
            if shots:
                page.screenshot(path=os.path.join(shots, f"banner-next-{theme}.png"),
                            clip={"x": box["x"] - pad, "y": 0, "width": box["width"] + 2 * pad, "height": box["y"] + box["height"] + pad})
        finally:
            context.close()

    if name == "production":
        unstable_keyboard(browser, url, theme, shots)


def unstable_keyboard(browser, url: str, theme: str, shots: str | None):
    """keybard.svalboard.com with a keyboard on Unstable firmware x4.4: a notice and an About sentence."""
    context, page, errors, _ = open_page(browser, url, theme, "fakeBoard&fwfake=1&running=x4.4&panel=about")
    try:
        notice = page.get_by_test_id("unstable-firmware-notice")
        expect(notice).to_be_visible(timeout=30000)
        check(notice.inner_text().strip() == NOTICE, f"production/{theme}: notice {notice.inner_text()!r}")
        check(notice.get_by_role("link").get_attribute("href") == "https://next.keybard.svalboard.com/", f"production/{theme}: notice links next")
        check(page.get_by_test_id("unstable-firmware-notice").count() == 1, f"production/{theme}: one notice line")
        check_contrast(page, notice, f"production/{theme}: notice")
        line = page.get_by_test_id("about-unstable-firmware")
        expect(line).to_be_visible(timeout=20000)
        check(line.inner_text().strip() == NOTICE, f"production/{theme}: About sentence {line.inner_text()!r}")
        check(not re.search(r"[()]", page.locator(ABOUT).inner_text()), f"production/{theme}: no parentheticals with the notice")
        check_contrast(page, page.locator(ABOUT_BODY), f"production/{theme}: About with the notice")
        if shots:
            page.wait_for_timeout(300)
            box = notice.bounding_box()
            page.screenshot(path=os.path.join(shots, f"notice-production-{theme}.png"),
                            clip={"x": max(0, box["x"] - 16), "y": max(0, box["y"] - 16), "width": box["width"] + 32, "height": box["height"] + 32})
            page.locator(ABOUT).screenshot(path=os.path.join(shots, f"about-production-unstable-keyboard-{theme}.png"))
        check(not errors, f"production/{theme}: no page errors with the notice {errors}")
    finally:
        context.close()


def main() -> int:
    if not os.environ.get("E2E_SKIP_BUILD"):
        for name, mode, tag, extra in BUILDS:
            build(name, mode, tag, extra)
    shots = os.environ.get("E2E_SHOTS")
    if shots:
        os.makedirs(shots, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for name, _, tag, _ in BUILDS:
                with serve(name) as url:
                    for theme in ("light", "dark"):
                        flow(browser, name, tag, url, theme, shots)
        finally:
            browser.close()
    print(f"\n{len(failures)} failure(s)" if failures else "\nAll checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
