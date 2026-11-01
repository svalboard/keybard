(slop warning from claussen:  These release notes are AI-generated, with occasional human edits)

# Keybard guide

Keybard configures your Svalboard from the browser. The keyboard stores and runs your setup itself, so you can close Keybard and keep typing.

## Get started

1. Open [keybard.svalboard.com](https://keybard.svalboard.com) in **Chrome or Edge**. Firefox and Safari can't connect to the keyboard.
2. Click **Connect Keyboard** and choose your Svalboard. Your layout and settings load from the board.
3. Edit. With **Live Updating** on, changes go to the board as you make them. With it off, changes queue up: **Update** applies them and **Revert** discards them.

You can also open a layout file without a board connected to edit it offline.

## Edit your layout

- **Assign keys:** drag a key from a palette onto a position, or select a position and type the key or shortcut you want.
- **Work with layers:** compare layers side by side in flat or 3D view, and see what transparent keys fall through to. Rename layers, choose their colors, and copy, paste or clear them from the layer menu.
- **Match your setup:** pick the palette for your operating system's keyboard layout, and choose the finger and thumb clusters installed on your board.

## Behaviors

You have 256 slots for each of these:

- **Tap dances:** different actions for tap, hold, double-tap and tap-then-hold.
- **Combos:** press up to four keys together for another action.
- **Macros:** text, key presses and delays.
- **Key overrides:** replace a key when certain modifiers or layers are active.
- **Alternate repeat:** give a repeated key an alternate action.
- **Leader sequences:** a sequence of up to five keys triggers an action.

The mod-tap and one-shot composer builds modifier keys and tap/hold keys without remembering their codes. Name macros, tap dances and layers so you can tell them apart; the names are saved on the board.

## Typing feel

Timing settings apply as soon as you save them:
- tapping term
- Permissive Hold and Hold on Other Key Press
- Retro Tapping and Quick Tap
- **Chordal Hold** (on by default)
- **Flow Tap**
- combo and one-shot timing

## Pointing

The **Pointing Devices** panel tunes each side separately:
- DPI and scroll mode
- natural scrolling
- which pointer turns on the mouse layer, and how quickly it turns off

Add **Sniper** keys to slow the cursor and **Boost** keys to speed it up. Either kind can be held or toggled.

**Touchpads:** on Windows and Linux the pads are a touchpad (Touchpad mode), set up with the system's own touchpad settings. On a Mac, and in a BIOS, the pads make their own taps and scrolling (built-in gestures), tuned in **Settings → Touchpad tuning**. **Touchpad mode** at the top of that dialog can keep the built-in gestures on Windows and Linux too. It's saved on the board, not in layout files.

## Backups and layout files

- **Automatic backups:** while your board is connected, Keybard keeps snapshots of it. Find them in **Settings → Backups**. From there you can restore one (you review it before anything is written) or download it. You can also choose a folder where Keybard keeps a plain copy you can see.
- **Export and import:** a `.svil` file holds your whole setup. Export one before big changes, and import one to restore it or move it to another board.
- **Coming from Vial:** import the `.vil` file you exported from Vial. Your layout, macros, tap dances, combos, key overrides and QMK settings come across. Set DPI, scrolling, automouse and layer colors again.
- **Layouts library:** save layers you like, then drag a whole layer or a single key into any layout.
- **Print:** print your layers or save them as a PDF for a desk reference.

## Learn your layout

**Trainer** shows your own layout for the layer you're on. The separate **Keybard Overlay** app (Windows preview) shows it as a desktop overlay that follows your layers while you work.

## Board name

Give each board a name in **Settings**, then restart it so your computer shows the new name.

## If something's not right

- **Matrix Tester** lights up each key as you press it.
- After a configuration reset, restart the board before making new edits.
- Touchpad gestures stopped working on Windows or Linux? Set **Settings → Touchpad tuning → Touchpad mode** back to **Automatic**. A settings reset returns it to Automatic too.
- Release a tap-dance key before changing what it does.
- Alternate-repeat modifier matching has known problems; check custom mappings before relying on them.
