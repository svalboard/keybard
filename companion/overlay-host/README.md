# Keybard Overlay

Keybard Overlay shows your Svalboard layout as a transparent overlay on your desktop. It follows the layer you're on, so you can glance at it while you type in any app. It runs in the system tray and only reads from the keyboard: it never changes your layout or flashes firmware.

You choose what the overlay looks like in the **Overlay** panel of [Keybard](https://keybard.svalboard.com).

## Install (Windows)

1. Download `KeybardOverlay-Windows.zip` from [Releases](https://github.com/svalboard/keybard/releases) and extract the whole ZIP to a folder you'll keep.
2. Run `Start-Windows.cmd`. The first launch downloads its own copy of Python and Qt, so you need to be online. No admin rights or system changes are needed.

Keybard Overlay is now in your system tray, and it opens Keybard's Overlay dialog on [keybard.svalboard.com](https://keybard.svalboard.com) in your browser.

## Install (Linux, test build)

Download `KeybardOverlay-x86_64.AppImage` (or `KeybardOverlay-Linux-x86_64.tar.gz`), `README-LINUX.md` and `install-udev-rule.sh` with `60-svalboard.rules` from [Releases](https://github.com/svalboard/keybard/releases). Run `sudo ./install-udev-rule.sh` once and replug the board, then start the AppImage (or `./keybard-overlay` in the extracted folder). It brings its own Python and Qt. It is a test build: see `README-LINUX.md` for the known limits and what to check, and `--diagnose` for the report to send back.

## Set up the overlay

1. In the Overlay dialog, click **Connect**. If the browser asks whether the site can access apps on this device, allow it. Next time it reconnects on its own.
2. With more than one Svalboard plugged in, the overlay reads them all and shows the one you're using (see below). Settings are saved on this computer.

Use Chrome or Edge. **Open Keybard** in the tray menu takes you back to the Overlay dialog. Offline, the overlay app's built-in copy of Keybard at `http://127.0.0.1:5178/` works the same way.

## Using it

- **Place it:** drag the move grip above the overlay's top-right corner. **Size it:** drag the resize grip next to it, up or right to grow, down or left to shrink. **Collapse it:** the collapse button beside the grips hides the overlay and leaves just the grips; click it again to bring it back. Clicks anywhere else, keys included, pass through to the window underneath.
- **Overlay menu** (⋯ beside the grips, and the same items in the tray menu): **Board** is **Follow the board in use** (the default), or one board to show only; **Style** picks a look (Dark, Subtle, Outline only, Light, High contrast); **Outline shadow** adds a contrasting shadow around legends and outlines (on by default); **Colors…** opens a small panel for every color, opacity, the outline width and the highlight colors; **Layer highlight** is Off, Flash or Fade; **Highlight held keys**; **Hands**; **Capital letters** shows letter keys in capitals; **Adaptive contrast** (Windows, off by default) restyles each key for the background behind it; **Place at bottom**; **Reload board layout**.
- **Tray menu:** show or hide the overlay, drag or place it at the bottom of the screen, reload the layout, open Keybard, or quit. Closing the browser leaves the overlay running.
- **Several Svalboards at once.** The overlay reads every Svalboard on the computer and shows the one in use: the last one with a held key, a rolled trackball or a finger on a touchpad. It moves to another board only once the board on show has been idle for a second, so using two boards together never makes it flicker. A board with a blank keymap, such as a touchpad with no keys, never replaces a board with keys: while you use it, its touchpads or trackballs are drawn in the layout on show, with your touches, and they go back three seconds after you stop or as soon as the shown board's own trackball moves. Boards plugged in, unplugged or restarted by a firmware update reconnect by themselves. To show one board only, choose it under **Board**. **Disconnect** lets go of every board until one is plugged in again or you choose one under **Board**.

- **Trackball balls**: **Pointing devices** > **Left trackball** and **Right trackball** choose the ball drawn for the board on show, from the same balls as Keybard. The choice is kept for that board. If Keybard later sends its own choice for the board, the newer one is used.

- **After you edit your layout in Keybard**, the overlay updates by itself about a second after the change reaches the keyboard, as long as Keybard is connected to Keybard Overlay (the Overlay dialog's **Connect**, once). For changes made elsewhere, choose **Reload layout** from the tray.
- **Held keys:** the keys you're holding are highlighted. Turn this off with **Highlight held keys** in the overlay's menu. Very short taps can be missed.
- **Keycap legends:** digit and punctuation keys show the shifted symbol top left and the base legend bottom left, for the keyboard language chosen under International keyboards in Keybard. With **AltGr Symbols** on in Keybard's Settings (German, French, Spanish, Italian, Brazilian, Danish and Swiss layouts; not on macOS), the AltGr character is bottom right. The overlay follows these settings (and the keyboard language) while Keybard's Overlay dialog is open; **Shifted Key Symbols** off in Keybard shows one legend per key. A key with no room for the extra legends keeps one centered legend.
- **Shift and Caps Lock** on your Svalboard change the letters and symbols shown, using the keyboard language chosen in Keybard. Firmware from vNext1 on reports them itself, so other keyboards on the computer don't change the legends. On older firmware the overlay follows the computer's Shift and Caps Lock instead, which doesn't work on Wayland.

## What it doesn't do

Keybard Overlay never writes to the keyboard, flashes firmware or records what you type. Its control page listens only on your own computer. It takes commands only from its built-in Keybard, keybard.svalboard.com and the preview site next.keybard.svalboard.com, and each change needs a per-session token.

## Updating

Quit Keybard Overlay from the tray, extract the new release to a new folder, and run `Start-Windows.cmd` there. Your settings are kept, because they're stored in your user profile rather than in the app folder. Keybard Overlay was called Keybard Host before; it uses the same settings, so updating from Keybard Host keeps them too.

## Paranoid mode

Paranoid mode is a separate way to run Keybard Overlay, for people who want Keybard to have no network access at all. `Start-Paranoid.cmd` starts the overlay app with Keybard Paranoid, a single-file build of Keybard that can't reach the network. It ignores all websites, keybard.svalboard.com included, and opens its own Keybard in a separate browser profile that can only reach your own computer. `Open-Paranoid.cmd` opens Keybard Paranoid on its own, without the overlay. See `docs/paranoid.md` for exactly what it protects.

## Linux and macOS

Linux: copy the web build to `companion/overlay-host/web`, then run `bash companion/overlay-host/start-linux.sh`. To build the self-contained Linux test package (an AppImage and a `.tar.gz` with their own Python and Qt), see `packaging/linux/build.sh`; the tester's instructions are `packaging/linux/README-LINUX.md`. On Wayland, placement, stacking and click-through depend on the compositor.

macOS: see [macOS](#macos) below.

### Linux setup

Qt's X11 plugin and Qt WebEngine need these libraries. A full Ubuntu desktop has most of them; minimal installs and WSL do not. Qt reports any missing X11 library as `xcb-cursor0`, so install the whole list:

```sh
sudo apt install python3-venv libnss3 libasound2t64 libxkbfile1 libxcb-cursor0 libxcb-icccm4 \
  libxcb-keysyms1 libxcb-image0 libxcb-render-util0 libxcb-shape0 libxkbcommon-x11-0
```

The overlay app reads the board through hidraw, which only root can open by default. Give the logged-in user access to Svalboard HID devices, then replug the board. The rule matches the USB IDs rather than the serial number, because current firmware no longer reports the serial that Vial's udev rule looks for. It covers every Svalboard product ID (0x4044-0x404D), so it keeps working after flashing a firmware file with a different ID. Keybard's own Linux access command writes the same rule.

```sh
sudo tee /etc/udev/rules.d/60-svalboard.rules > /dev/null <<'EOF'
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="303a", ATTRS{idProduct}=="404[4-9a-d]", MODE="0660", TAG+="uaccess"
EOF
sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=hidraw
```

Under WSL, attach the board with [usbipd-win](https://github.com/dorssel/usbipd-win) (`usbipd bind`, then `usbipd attach --wsl`); Windows loses the board until it is detached. If Wayland fails with `Failed to create wl_display`, set `XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir`. WSLg doesn't show the overlay under X11 (`QT_QPA_PLATFORM=xcb`), so use Wayland there. If Keybard Overlay on Windows already uses port 5178, start it on Linux with `--port 5179`. What works under WSLg says nothing about stacking, focus or click-through on native Ubuntu.

### macOS

> **Untested on real hardware.** The macOS support was written without a Mac. It needs a Mac tester before anyone calls it supported; please report what works and what doesn't in [svalboard/keybard#51](https://github.com/svalboard/keybard/issues/51).

You need macOS 13 (Ventura) or later, on Apple Silicon or Intel, and Python 3.10 or later. The `python3` that comes with Xcode's command line tools is 3.9, which is too old: install Python from [python.org](https://www.python.org/downloads/macos/) or with `brew install python@3.13`.

1. Download `KeybardOverlay-Windows.zip` from a [release](https://github.com/svalboard/keybard/releases) that includes `start-macos.sh`, and extract it. Despite the name it carries everything the Mac needs except Python and Qt; `start-macos.sh` downloads Qt into a `.venv` folder next to it on first launch.
2. In Terminal, `cd` into the extracted `KeybardOverlay` folder and run `bash start-macos.sh`.

From a source checkout instead, build the web assets into `companion/overlay-host/web` (see [Build](#build): `VITE_BASE_PATH=/ npm run build`, then copy `dist` there), and run `bash companion/overlay-host/start-macos.sh`. Paranoid mode is `bash start-macos.sh --paranoid`, which needs `web-paranoid/index.html`; it opens Keybard Paranoid in Google Chrome or Microsoft Edge from `/Applications` or `~/Applications`.

On macOS the overlay app:

- runs as a menu bar app: its icon is in the menu bar, with no Dock icon. Click it for the menu.
- keeps the overlay above other windows, on every Space and over full-screen apps, and doesn't take focus or clicks.
- stores its settings in `~/Library/Application Support/Keybard Host/`. The folder keeps the app's earlier name, so settings carry over.
- doesn't start at login. To have it start at login, add a login item for a script that runs `start-macos.sh`.

#### Permissions

The overlay app shouldn't need any privacy permission, but these are the ones to look at if something doesn't work (System Settings → Privacy & Security):

- **Input Monitoring:** the overlay app reads the board's layer, held keys, Shift and Caps Lock through the board's own Raw HID interface, not its keyboard interface, and never watches keystrokes. On firmware older than vNext1 it reads Shift and Caps Lock from the system's modifier flags instead. Neither should need Input Monitoring. If the overlay never finds the board, or Shift and Caps Lock never change the legends, check whether macOS has listed Terminal (or your Python) here, and allow it.
- **Accessibility:** not used. The overlay app doesn't move other apps' windows or send input.
- **Local Network:** the overlay app only listens on `127.0.0.1`, which macOS doesn't ask about.

Chrome needs the board too. Keybard and the overlay app should both be able to have it open at the same time, as on Windows, because hidapi opens it without exclusive access.

#### What a Mac tester should check

1. `bash start-macos.sh` installs and starts with no errors, and the menu bar icon appears with no Dock icon.
2. Keybard opens in your browser with the Overlay dialog, **Connect** works, and the overlay shows your layout.
3. The overlay is see-through between the keys, stays above other windows, and clicks pass through it to the window underneath.
4. Clicking the overlay or its controls doesn't take focus from the app you're typing in.
5. The move grip drags the overlay and the resize grip resizes it; the collapse button hides the overlay but keeps the grips, and brings it back; clicks anywhere else on the overlay, keys included, pass through.
6. The overlay stays visible after you click on another app, switch Spaces, and open an app in full screen.
7. Layer changes and, with **Held keys** on, held keys show up live. Shift and Caps Lock on the board change the legends.
8. Keybard in Chrome and the overlay app both stay connected to the board at the same time.
9. **Quit Keybard Overlay** from the menu bar quits it, and starting it again keeps your settings.
10. `bash start-macos.sh --paranoid` opens Keybard Paranoid in its own Chrome or Edge window.
11. Note your macOS version, Mac model (Apple Silicon or Intel), Python version and display setup (Retina, external monitors).

## For developers

### Build

From the repository root:

```sh
npm ci
VITE_BASE_PATH=/ npm run build
python3 companion/overlay-host/scripts/package.py
```

This makes `dist/KeybardOverlay-Windows.zip`, a local test build. It isn't signed, and it doesn't include downloaded runtimes or anyone's settings.

### Test

```sh
npm test
PYTHONPATH=companion/overlay-host python3 -m unittest discover -s companion/overlay-host/tests -v
```

These don't cover moving the window, focus, click-through, fullscreen, or live layer and held-key changes on real hardware. Check those by hand.

### Publish a release

Keybard Overlay is released with Keybard, under the same tag (see the release tags in the repository's `CLAUDE.md`): `x3`, `x3.1` are prereleases and `v3`, `v3.1` are full releases.

1. Update `RELEASE-NOTES.md`.
2. Run the tests above and a Windows smoke test.
3. For a full release, set `HOST_RELEASE_TAG` in `src/features/trainer/HostInstall.tsx` to the new `v` tag, so the Overlay dialog's download link finds it, and merge that to `main`. Link the tag itself, not GitHub's `latest` redirect.
4. Tag the commit on `main` and push the tag. The **Package Keybard Overlay release** workflow (`.github/workflows/keybard-overlay-release.yml`) runs on the push: it builds the ZIP, `keybard-paranoid.html` and `SHA256SUMS.txt`, and stamps the tag and the bundled Keybard commit into the host and the release notes.
   - An `x` tag becomes a published GitHub prerelease.
   - A `v` tag becomes a draft release. Test the ZIP on Windows, then publish it.
5. To package an existing tag again, delete its GitHub release, then run `gh workflow run keybard-overlay-release.yml -R svalboard/keybard -f tag=<tag>`.

To package by hand instead: build with `npm run build:svalboard`, run `python3 companion/overlay-host/scripts/package.py` with `KEYBARD_HOST_VERSION` set to the tag (so the host reports it), then run `sha256sum KeybardOverlay-Windows.zip > SHA256SUMS.txt` in `dist`.
