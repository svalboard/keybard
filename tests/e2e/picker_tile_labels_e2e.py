"""
Browser check: no key tile in the app clips its label. Every surface that draws a key
tile or legend (SURFACES below: every picker panel with its More keys groups, the
same pickers in the bottom bar, the keymap at each key size, the combo, tap dance,
macro, override, leader and alt-repeat panels and editors, the binding editor, and
the Overlay page) is rendered at each key size the app uses (Normal 60px, Medium
45px, Small 30px) on a simulated board that has every SV_ key, and every glyph of
every label is measured against its tile. A label fails when any glyph lies outside
the tile, or when a line break falls inside a word. Prints a coverage table: surface,
tiles measured, clipped (and clipped before, when BEFORE_JSON names an earlier
TILE_REPORT run's summary). Run with `npm run test:e2e:tile-labels`.

  E2E_URL / E2E_SKIP_BUILD work as in fake_board_e2e.py.
  TILE_SIZES=small,medium,default and TILE_THEMES=light,dark choose the runs.
  TILE_ONLY=<text> keeps only the surfaces whose name contains the text.
  SHOTS_DIR=<dir> also saves a screenshot of each picker panel per size and theme.
  TILE_REPORT=<file> writes every clipped label and the coverage summary as JSON.
  BEFORE_JSON=<file> is a TILE_REPORT of the build to compare with.

A surface that shows no tile counts as unreached and fails the run, so a surface
cannot go unchecked without being noticed. Needs Python Playwright with Chromium.
Exits 1 when any label clips or any surface is unreached.
"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url, wait_connected  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

SIZES = os.environ.get("TILE_SIZES", "small,medium,default").split(",")
THEMES = os.environ.get("TILE_THEMES", "light").split(",")
SHOTS = os.environ.get("SHOTS_DIR")
ONLY = os.environ.get("TILE_ONLY", "")

# Every picker tile outside the keyboard canvas: each text glyph must lie inside the tile's
# padding box, and a line may only break between words.
MEASURE_JS = r"""
(mode) => {
  const inCanvas = el => !!el.closest('[aria-label="Keyboard canvas"]');
  const root = mode === 'aside' ? (document.querySelector('aside[data-placement]') || document.body) : document.body;
  // The Overlay draws its keys as SVG groups, not as picker tiles; each key's outline is its first rect,
  // and its legend is HTML laid over the drawing (.trainer-legends), found by the same key id.
  const caps = mode === 'overlay'
    ? [...document.querySelectorAll('svg g[data-key-id]')].filter(g => g.getClientRects().length > 0)
    : [...root.querySelectorAll('[data-keycap]')].filter(el =>
        (mode === 'canvas' ? inCanvas(el) : !inCanvas(el)) && el.getClientRects().length > 0 &&
        (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true, opacityProperty: true })));
  const bad = [], short = [];
  for (const cap of caps) {
    const sh = cap.querySelector('[data-tile-label="short"]');
    if (sh) short.push({ name: cap.getAttribute('title') || '', shown: [...sh.querySelectorAll('span > span')].map(l => l.textContent).join(' / ') });
    const overlay = mode === 'overlay';
    const box = (overlay ? cap.querySelector('rect') : cap).getBoundingClientRect();
    const cs = getComputedStyle(cap);
    const bw = side => (overlay ? 0 : parseFloat(cs['border' + side + 'Width']) || 0);
    const inner = {
      l: box.left + bw('Left') - 0.5,
      r: box.right - bw('Right') + 0.5,
      t: box.top + bw('Top') - 0.5,
      b: box.bottom - bw('Bottom') + 0.5,
    };
    const legend = overlay ? document.querySelector(`.trainer-legends > [data-key-id="${cap.dataset.keyId}"]`) : null;
    let reason = null, text = '';
    for (const part of [cap, legend]) {
    if (!part) continue;
    const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // A key's hover title is not drawn on it.
      if (n.parentElement && n.parentElement.closest('title')) continue;
      const s = n.textContent;
      text += s + ' ';
      let prev = null;
      for (let i = 0; i < s.length; i++) {
        if (/\s/.test(s[i])) { prev = null; continue; }
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + 1);
        const rect = r.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        // A glyph's box is the font's whole ascent and descent, taller than its ink: allow a
        // quarter of the font size above and below.
        const slack = 0.25 * parseFloat(getComputedStyle(n.parentElement).fontSize);
        if (rect.left < inner.l || rect.right > inner.r || rect.top < inner.t - slack || rect.bottom > inner.b + slack) {
          reason = reason || 'outside';
        }
        // Two letters of one word on different lines: a break inside a word.
        if (prev && /[\p{L}\p{N}]/u.test(s[i]) && /[\p{L}\p{N}]/u.test(s[i - 1]) && rect.top > prev.bottom - 1) {
          reason = reason || 'mid-word break';
        }
        prev = rect;
      }
    }
    }
    if (cap.querySelector('[data-tile-label="broken"]')) reason = reason || 'broken word';
    if (reason) bad.push({
      keycode: cap.getAttribute('title') || '',
      text: text.trim().replace(/\s+/g, ' '),
      shown: (legend || cap).innerText.replace(/\s+/g, ' / ').trim(),
      reason,
    });
  }
  return { tiles: caps.length, bad, short };
}
"""


SURFACES = [
    # (name, query, mode, panel position, action)
    # Picker panels in the side panel, with every More keys group open.
    *[(f"picker {n}", f"?fakeBoard&panel={n}&moreKeys", "aside", "sidebar", None)
      for n in ("keyboard", "special", "mouse", "layers", "more", "macros", "tapdances", "qmk", "oneshot")],
    ("picker pointing", "?fakeBoard=pointing&panel=pointing-automouse&moreKeys", "aside", "sidebar", None),
    # The same pickers in the bottom bar tray.
    *[(f"bottom bar {n}", f"?fakeBoard&panel={n}&moreKeys", "aside", "bottombar", None)
      for n in ("keyboard", "special", "mouse", "layers", "more")],
    ("bottom bar pointing", "?fakeBoard=pointing&panel=pointing-automouse&moreKeys", "aside", "bottombar", None),
    # Panels and editors that list or show key tiles.
    *[(f"panel {n}", f"?fakeBoard&panel={n}", "aside", "sidebar", None)
      for n in ("combos", "overrides", "leaders", "tapdances", "macros", "layers")],
    ("panel altrepeat", "?fakeBoard=altrepeat&panel=altrepeat", "aside", "sidebar", None),
    ("editor combo", "?fakeBoard&edit=combo:0", "page", "sidebar", None),
    ("editor tap dance", "?demo=combos&edit=tapdance:0", "page", "sidebar", None),
    ("editor macro", "?demo=combos&edit=macro:1", "page", "sidebar", None),
    ("editor altrepeat", "?fakeBoard=altrepeat&panel=altrepeat", "page", "sidebar", "first-row"),
    ("editor override", "?fakeBoard&panel=overrides", "page", "sidebar", "first-row"),
    ("editor leader", "?fakeBoard&panel=leaders", "page", "sidebar", "first-row"),
    # The keymap, and the binding editor opened by selecting a key.
    ("keymap", "?fakeBoard=legends", "canvas", "sidebar", None),
    ("binding editor", "?fakeBoard=legends&panel=special&moreKeys", "page", "sidebar", "select-key"),
    ("binding editor, bottom bar", "?fakeBoard=legends&panel=special&moreKeys", "page", "bottombar", "select-key"),
    # The Overlay page (the desktop overlay's keys).
    ("overlay", "?hostOverlay=1&hostDemo=pointing", "overlay", "sidebar", None),
]


# Surfaces that draw no key tile by design (the More panel is a list of tools): they are
# opened and listed in the coverage table but are not required to show tiles.
NO_TILES = {"picker more", "bottom bar more"}


def run_action(page, action):
    if action == "select-key":
        # A key with no combo, so a click opens the binding editor rather than pinning a combo.
        page.locator('[aria-label="Keyboard canvas"] [data-keycode="KC_Q"]').first.click()
    elif action == "first-row":
        row = page.locator("[data-binding-row]").first
        if row.count():
            row.click()
    page.wait_for_timeout(500)


def open_surface(page, url, query, action):
    page.goto(url + query)
    if "hostOverlay" in query:
        page.locator("[data-key-id]").first.wait_for(timeout=30000)
        page.wait_for_timeout(800)
        return
    if "fakeBoard" in query:
        wait_connected(page)
    else:
        page.locator("[data-keycap]:visible").first.wait_for(timeout=30000)
    page.wait_for_timeout(1200)
    if action:
        run_action(page, action)


def main():
    report = []
    summary = {}
    with app_url() as url, sync_playwright() as p:
        browser = p.chromium.launch()
        for theme in THEMES:
            for size in SIZES:
                for name, query, mode, position, action in SURFACES:
                    if ONLY not in name:
                        continue
                    ctx = browser.new_context(viewport={"width": 1500, "height": 4400 if SHOTS and mode == "aside" else 950}, color_scheme=theme, reduced_motion="reduce")
                    prefs = json.dumps({"theme": theme, "key-size": size, "panel-position": position})
                    ctx.add_init_script(f"try {{ localStorage.setItem('keyboard-settings', {json.dumps(prefs)}); }} catch {{}}")
                    page = ctx.new_page()
                    try:
                        open_surface(page, url, query, action)
                        page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true")
                        res = page.evaluate(MEASURE_JS, mode)
                        # A label is re-fitted when web fonts or the layout settle; on a busy machine that
                        # can lag the first look, so a clip must still be there a moment later to count.
                        for _ in range(2):
                            if not res["bad"]:
                                break
                            page.wait_for_timeout(1500)
                            res = page.evaluate(MEASURE_JS, mode)
                    except Exception as e:  # unreachable: counted below
                        print(f"    could not open {name!r}: {str(e).splitlines()[0]}")
                        res = {"tiles": 0, "bad": [], "short": []}
                    row = summary.setdefault(name, {"tiles": 0, "clipped": 0, "unreached": 0})
                    row["tiles"] += res["tiles"]
                    row["clipped"] += len(res["bad"])
                    row["unreached"] += 1 if res["tiles"] == 0 and name not in NO_TILES else 0
                    print(f"{theme:5} {size:7} {name:28} tiles={res['tiles']:4} clipped={len(res['bad'])}")
                    for sh in res["short"]:
                        print(f"    short           {sh['name']!r} -> {sh['shown']!r}")
                    for b in res["bad"]:
                        print(f"    {b['reason']:15} {b['keycode']:24} {b['text']!r}")
                        report.append({"theme": theme, "size": size, "surface": name, **b})
                    if SHOTS and mode == "aside":
                        os.makedirs(SHOTS, exist_ok=True)
                        side = page.locator("aside[data-placement]").first
                        target = side if side.count() else page
                        safe = name.replace(" ", "-").replace(",", "")
                        target.screenshot(path=os.path.join(SHOTS, f"{safe}-{size}-{theme}.png"))
                    ctx.close()
        browser.close()
    before = {}
    if os.environ.get("BEFORE_JSON"):
        with open(os.environ["BEFORE_JSON"], encoding="utf-8") as f:
            before = json.load(f).get("summary", {})
    print()
    print(f"{'surface':30} {'tiles':>6} {'clipped before':>15} {'clipped after':>14}  reached")
    for name, row in summary.items():
        b = before.get(name)
        print(f"{name:30} {row['tiles']:6} {(str(b['clipped']) if b else '-'):>15} {row['clipped']:14}  {'NO' if row['unreached'] else ('no tiles by design' if name in NO_TILES else 'yes')}")
    total_tiles = sum(r["tiles"] for r in summary.values())
    total_bad = sum(r["clipped"] for r in summary.values())
    unreached = [n for n, r in summary.items() if r["unreached"]]
    if os.environ.get("TILE_REPORT"):
        with open(os.environ["TILE_REPORT"], "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "clipped": report}, f, ensure_ascii=False, indent=1)
    print(f"{total_tiles} tiles measured, {total_bad} clipped, {len(unreached)} surfaces unreached {unreached}")
    sys.exit(1 if total_bad or unreached else 0)


if __name__ == "__main__":
    main()
