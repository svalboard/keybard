# Keybard Overlay — Windows, and Linux for testers

Keybard Overlay shows your Svalboard layout as a transparent overlay on your desktop. It follows the layer you're on, so you can glance at it while you type in any app. You set it up in the **Overlay** panel of [Keybard](https://keybard.svalboard.com).

This release is a portable ZIP for 64-bit Windows 10 and 11, not a signed installer, and a test build for Linux.

## New in x4.3.4

This prerelease bundles the Keybard that next.keybard.svalboard.com runs, and goes with Svalboard firmware x4.3.4. What changes for you since v4.3.3:

- **Touchpad clicks no longer get stuck.** On Macs and other computers that use the touchpad as a mouse, a tap or press and hold could leave a button held down. The button now always lets go.
- **Touchpad switches.** Tap to click, two-finger tap and press and hold each have their own switch. Press and hold starts after 300 ms by default.
- **Tune your touchpad.** A new touchpad tuning tool, opened from Settings or Pointing Devices, shows each pad live as you touch it and sets the dead zone, tap time, hold time and scroll start. The dead zone is now the same physical size on every build: 1.2 mm by default.
- **Mouse key wheel settings work.** The wheel delay and interval now change how the wheel keys repeat.
- **Settings stay in range.** A setting can no longer wrap around to a broken value: a value past its limit, typed in or stored before, is held at the limit.
- **Update the firmware from Keybard.** A keyboard that runs x4 or later can update to x4.3.4 from Keybard.

## New in v4.3.3

- **Test your keys without typing into other apps.** While Keybard's key tester is open, nothing you press reaches the computer. Typing comes back as soon as you close it. The key tester also responds faster. This needs firmware v4.3.3.
- **See every flicker.** The key tester shows each time a switch changes, even a bounce too short to type, with a count per key you can reset.
- **Debounce switch in Scan Lab.** It is on by default, so typing is unchanged unless you turn it off.
- **Scan timing in microseconds.** Your board keeps the timing it runs now.
- **Auto mouse and idle settings in milliseconds.** The mouse layer timeout is set in milliseconds, up to 2 seconds. The idle settings are listed in the order they happen, each in milliseconds.
- **The leader key works out of the box.** The leader timeout is 300 ms, restarting after each key of a sequence. A timeout of 0, left by an older settings reset or an older layout, becomes 300 ms. The combo term, tapping term, Auto Shift timeout and mouse key interval are never set to 0 either. Settings you chose are kept.
- **Backups has its own section in Settings.**
- **Older layouts and backups load cleanly.** Settings that newer firmware replaced are converted automatically when you load them, and Keybard lists each one.
- **Japanese and other international keys.** Henkan, Muhenkan, Kana, Yen and the other International and Language keys are under **Special Keys > International**.
- **Menus are readable in dark mode.**
- **Manual opens the online docs** at [docs.svalboard.com/keybard](https://docs.svalboard.com/keybard/).
- **The firmware update steps describe the lights as the keyboard shows them.**
- **Update the firmware from Keybard.** A keyboard that runs x4 or later can update to v4.3.3 from Keybard.

## Also new since vLaunch2.3

- **Linux, for testers.** Keybard Overlay for 64-bit Linux comes as `KeybardOverlay-x86_64.AppImage` and `KeybardOverlay-Linux-x86_64.tar.gz`, each with its own Python and Qt, so it needs no installs or admin rights to run. It is a test build that hasn't yet been confirmed on many Linux desktops: `README-LINUX.md` says how to run it, the one-time udev rule (`60-svalboard.rules`) that lets it read the board, and what to check. It needs glibc 2.34 or later (Ubuntu 22.04, Debian 12, Fedora 35 or later). On Wayland it runs through XWayland, so it can stay on top; plain GNOME shows no tray icon without the AppIndicator extension; X11 without a compositor shows a black box behind the keys. Checksums are in `SHA256SUMS-Linux.txt`.

## New in vLaunch2.3

- **Works with bleeding-edge firmware vNext1.** That firmware uses 64-byte reports and shows each hand's pointing module in its layout; Keybard Overlay reads both. Boards on vNext1 need Keybard Overlay vLaunch2.3 or later, and Keybard vLaunch2.3 or later.
- **Trainer is now called Overlay.** The page in Keybard's left panel that sets up the overlay is now **Overlay**.
- **Practice is hidden for now.** The Overlay page no longer shows the Practice tab.
- **Settings live in Keybard Overlay.** The overlay's ⋯ menu and the tray icon now hold its settings: **Board**, **Style**, **Outline shadow**, **Colors…** (a small panel for every color and opacity), **Layer highlight** (Off, Flash, Fade), **Highlight held keys**, **Hands**, **Capital letters**, **Adaptive contrast**, **Place at bottom** and **Reload board layout**. Keybard's Overlay item is now a small dialog: the download and **Connect** (which lets the overlay refresh after edits), or once connected, the board it follows and **Disconnect**.
- **Steadier overlay on Windows.** The overlay could leave a key lit, or patches blank, until the next keypress. It now renders in software, which fixes that with no noticeable cost.
- **Smooth trackballs in the overlay.** Rolling trackballs redraw at the screen's full rate, as in Keybard in the browser.
- **Shift comes from your Svalboard.** Shifted legends follow Shift, Caps Lock and Caps Word on the board the overlay follows, as the board reports them. Shift on another keyboard no longer changes the overlay. This needs firmware vNext1 or later; on older firmware the overlay follows the computer's Shift and Caps Lock, as before.
- **Held keys are highlighted.** **Highlight held keys** is now on by default, and this update turns it on once for everyone, since earlier versions saved it as off on their own. Turn it off with **Highlight held keys** in the overlay's menu; that choice is kept.
- **The Svalboard icon matches your taskbar.** In the tray and taskbar it is a black glyph on a light taskbar and a white one on a dark taskbar, and switches when you change the Windows theme.
- **Resize the overlay where it is.** Drag the new resize grip, between the move grip and the menu above the overlay's corner: up or right makes the overlay bigger, down or left smaller. Its bottom-left corner stays put, and the size is saved.
- **Collapse the overlay out of the way.** The new collapse button, beside the grips above the overlay's corner, hides the overlay and leaves just the grips. Click it again to bring the overlay back; no trip to the tray needed. The move grip still moves it while it's collapsed. It replaces **Hide overlay** in the overlay's menu; the tray's **Show overlay** still hides it completely.
- **Bigger letters and numbers.** Keys that show a single letter or digit draw it half again as large, at every overlay size.
- **Adaptive contrast (Windows).** Turn on **Adaptive contrast** in the overlay's menu and each key restyles itself for the background around it, about twice a second: dark legends over light windows, light ones over dark windows, and a backing plate that gets more opaque the busier the background is. The overlay still shows in screenshots and recordings.
- **Capital letters, if you prefer.** Turn on **Capital letters** in the overlay's menu to show letter keys in capitals.
- **Only the grip moves the overlay.** **Drag by keys** is gone from the Overlay page, the overlay's menu and the tray, so every click on the overlay, keys included, reaches the window underneath.
- **The overlay stays on top.** Windows could leave the overlay, or its grips, underneath other windows; the overlay app now puts them back within a second.
- **Overlay menu changes stick.** A setting saved shortly after you changed Capital letters, adaptive contrast or the overlay size no longer undoes that change.
- **Size changes keep the overlay on screen.** Changing the size from the Overlay page keeps the overlay's bottom edge where it is instead of growing it off the bottom of the screen.
- **A damaged settings file no longer stops the overlay app from starting**; it falls back to the default settings.
- **macOS, for testers.** The ZIP now includes `start-macos.sh`, which runs Keybard Overlay on macOS 13 or later with Python 3.10 or later. Nobody has tried it on a Mac yet; see "macOS" in `README.md` for what to check.

## New in vLaunch2.2

- **Clicks go through the overlay.** The overlay no longer catches clicks anywhere in its rectangle: everything you click reaches the window underneath. Move it with the grip above its top-right corner.
- **Drag by keys, if you want it.** Turn on **Drag by keys** in Trainer, the overlay's menu or the tray to drag the overlay by its keys as well. Only the keys themselves take the click; the space between them still passes through.
- **Trainer's settings stick after the overlay app restarts.** Changing the overlay size or another setting in a Trainer tab opened before Keybard Overlay restarted used to snap back. Trainer now reconnects and saves the change. The Hide overlay button is gone from Trainer: hide the overlay from its handle menu or the tray.

## New in vLaunch2.1

- **Works with Keybard's preview site.** Trainer on [next.keybard.svalboard.com](https://next.keybard.svalboard.com), the bleeding-edge Keybard built from every change, can now connect to Keybard Overlay, as keybard.svalboard.com can.

## New in vLaunch2

- **The overlay keeps up with your edits.** When Keybard saves a change to the keyboard, the overlay updates about a second later, without going blank. Before, you had to choose **Reload layout** from the tray.
- **The bundled Keybard is current:** it can reorder layers by dragging their tabs, shows and sets the default layer, and warns when the keyboard couldn't save a setting.
- **Shows which version you have.** Trainer says which Keybard Overlay is connected and which Keybard it bundles, and points to a newer release when there is one. The tray icon's tooltip shows the same.
- **Made for Svalboard firmware vLaunch2.** It works with older firmware too, but moving or setting the default layer needs vLaunch2.

## Get started

1. Download **KeybardOverlay-Windows.zip** and extract the whole ZIP to a folder you'll keep.
2. Run **Start-Windows.cmd**. The first launch downloads its own copy of Python and Qt, so you need to be online. No admin rights or system changes are needed. Keybard Overlay then sits in your system tray and opens [keybard.svalboard.com](https://keybard.svalboard.com).
3. In Keybard (Chrome or Edge), connect your keyboard, open **Overlay** and click **Connect**. If the browser asks whether the site can access apps on this device, allow it.
4. Set up the overlay from its ⋯ menu or the tray icon. The tray icon also shows, moves or hides it, and quits the overlay app.

## What it does

- Shows your board's layout and follows your active layer, and your default layer on firmware that reports it.
- Keeps up with edits: when Keybard saves a change to the keyboard, the overlay re-reads the layout by itself, showing the old one until the new one is read.
- Uses Keybard's key icons. Shift and Caps Lock change the letters shown.
- Stays on top and lets clicks pass through. Move it with its grip.
- Adjustable color, outline, opacity and halo.
- Highlights layer changes and, optionally, the keys you're holding.

## Paranoid mode

Paranoid mode is a separate way to run Keybard Overlay, for people who want Keybard to have no network access at all.

- **Start-Paranoid.cmd** starts the overlay app with Keybard Paranoid, a single-file build of Keybard that can't reach the network. It ignores all websites, keybard.svalboard.com included, and opens Keybard in a separate browser profile that can only reach your own computer. The overlay works as usual.
- **Open-Paranoid.cmd** opens Keybard Paranoid on its own, without the overlay.

`docs/paranoid.md` in the source explains exactly what it protects.

## Limits

- **Read-only:** Keybard Overlay never changes your layout or flashes firmware. For layout changes made outside Keybard, choose **Reload board layout** from the tray.
- **Unsigned:** Windows may warn you about it. Only run a ZIP you downloaded from this release page.
- **Windows only for now:** macOS is untested, and Wayland has limits.
- **No automatic updates:** to update, quit from the tray, extract the new release to a new folder, and run it. Your settings carry over.

`SHA256SUMS.txt` has the ZIP's checksum.
