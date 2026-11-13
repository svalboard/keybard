"""
Browser test for the overlay's key legends: every legend is painted inside its key, in
Chromium and in WebKit. Run with `npm run test:e2e:overlay-legends`.

The overlay (?hostOverlay) draws its keys as an SVG and its legends as HTML over it. The
legends were once HTML inside an SVG <foreignObject> on each key, which WebKit (Safari, and
the web views Keybard Overlay uses on macOS and Linux) paints at the SVG's corner, unscaled,
whenever that HTML has a filter, an opacity, clipping or positioning: every legend piled up in
the top-left corner over blank keys, while the layout still said each was in its key. So this
test looks at the picture, not the layout:

  1. Take a picture of the overlay page, then another with the legends taken off the page.
     Where the two differ is where the legends were painted.
  2. Nearly every key must have legend ink inside it, and next to none may be outside a key.
  3. The same in both engines, at two window sizes (the drawing scales to fit), and the
     legends must be the same size in both: key by key, the height of the ink in WebKit is
     within a quarter of its height in Chromium (the engines draw strokes and shadows a
     little differently, so the amount of ink is not compared).

It uses the pointing demo page (?hostOverlay=1&hostDemo=pointing), which draws the overlay
with the QWERTY Example and no Overlay app or board.

E2E_SHOTS=<dir> also saves the pictures. Needs Playwright's WebKit (`playwright install webkit`)
and Pillow. Builds the app like fake_board_e2e.py (E2E_URL and E2E_SKIP_BUILD work the same
way). Exits 1 when a check fails.
"""
import io
import os
import sys

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_board_e2e import app_url  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

SHOTS = os.environ.get("E2E_SHOTS")
SIZES = [(1050, 320), (700, 420)]
# The outline of every key that has a legend, by the legend layer's own bookkeeping.
KEYS = """() => [...document.querySelectorAll('.trainer-legends > div')].map(legend => {
    const key = document.querySelector(`.trainer-surface svg g[data-key-id="${legend.dataset.keyId}"] rect`).getBoundingClientRect();
    return [key.left, key.top, key.right, key.bottom];
})"""
HIDE = """() => {
    const style = document.createElement('style');
    style.textContent = '.trainer-legends, .trainer-surface svg text, .trainer-surface svg foreignObject { display: none !important; }';
    document.head.appendChild(style);
}"""


def ink(with_legends: bytes, without: bytes):
    """The pixels the legends painted: where the two pictures differ."""
    a, b = (Image.open(io.BytesIO(data)).convert("RGB") for data in (with_legends, without))
    difference = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
    width, _ = difference.size
    data = difference.tobytes()
    return [(i % width, i // width) for i in range(len(data)) if data[i]]


def measure(browser, url: str, size, name: str):
    page = browser.new_page(viewport={"width": size[0], "height": size[1]})
    # Keys only: no pointing devices or pills, whose motion would differ between the two pictures.
    page.goto(f"{url}?hostOverlay=1&hostDemo=pointing&showDevices=0&pills=0&motion=0")
    page.wait_for_function("document.querySelectorAll('.trainer-legends > div').length >= 40", timeout=30000)
    page.wait_for_timeout(500)
    keys = page.evaluate(KEYS)
    shot = page.screenshot()
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        with open(os.path.join(SHOTS, f"overlay-legends-{name}-{size[0]}x{size[1]}.png"), "wb") as f:
            f.write(shot)
    page.evaluate(HIDE)
    page.wait_for_timeout(300)
    bare = page.screenshot()
    page.close()
    inside, stray = [0] * len(keys), 0
    spans = [None] * len(keys)  # the top and bottom row of each key's ink
    for x, y in ink(shot, bare):
        for i, (left, top, right, bottom) in enumerate(keys):
            if left - 1 <= x <= right + 1 and top - 1 <= y <= bottom + 1:
                inside[i] += 1
                spans[i] = (y, y) if spans[i] is None else (min(spans[i][0], y), max(spans[i][1], y))
                break
        else:
            stray += 1
    heights = [span[1] - span[0] + 1 if span else 0 for span in spans]
    return keys, inside, stray, heights


def main() -> int:
    failures = []
    with app_url() as url, sync_playwright() as playwright:
        for size in SIZES:
            heights = {}
            for name in ("chromium", "webkit"):
                browser = getattr(playwright, name).launch()
                keys, inside, stray, heights[name] = measure(browser, url, size, name)
                browser.close()
                lettered, total = sum(1 for n in inside if n), sum(inside)
                print(f"{name} {size[0]}x{size[1]}: {len(keys)} keys with legends, ink in {lettered}; {total} legend pixels inside keys, {stray} outside")
                if len(keys) < 40: failures.append(f"{name} {size}: only {len(keys)} legends found")
                if lettered < len(keys) * 0.9: failures.append(f"{name} {size}: only {lettered} of {len(keys)} keys have their legend drawn inside them")
                if stray > max(20, total * 0.02): failures.append(f"{name} {size}: {stray} legend pixels are outside every key")
            pairs = [(c, w) for c, w in zip(heights["chromium"], heights["webkit"]) if c and w]
            off = [(c, w) for c, w in pairs if abs(w - c) > max(2, c * 0.25)]
            print(f"  legend heights compared on {len(pairs)} keys: {len(off)} differ by more than a quarter")
            if len(pairs) < 40 or len(off) > len(pairs) * 0.1:
                failures.append(f"{size}: legends are not the same size in WebKit and Chromium on {len(off)} of {len(pairs)} keys: {off[:6]}")
    for failure in failures: print("FAIL:", failure)
    print("PASS: legends are drawn inside their keys in Chromium and WebKit" if not failures else f"{len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
