"""Validated, local host state. Trainer clients cannot emit HID commands."""
import copy
import json
import re
import secrets
import time
from threading import RLock
from pathlib import Path

# The overlay's styles, offered in the Host's menus (Keybard's src/features/trainer/core.ts has the same).
_DARK = dict(fill='#14202b', fillAlpha=80, outline='#51606a', outlineAlpha=100,
    legend='#f0f5f7', legendAlpha=100, width=1, halo=False, changed='#8ce4d3', pressed='#ffd27a')
PRESETS = {
    'Dark': _DARK,
    'Subtle': dict(_DARK, fillAlpha=20, outlineAlpha=40, legendAlpha=80, halo=True),
    'Outline only': dict(_DARK, fillAlpha=0, outline='#dce5ec', outlineAlpha=90, halo=True),
    'Light': dict(_DARK, fill='#f3f5f7', fillAlpha=90, outline='#56616b', legend='#15202b'),
    'High contrast': dict(_DARK, fill='#000000', fillAlpha=90, outline='#ffffff', width=2, halo=True),
}
# Layer-change highlight choices; each sets the effect and its duration together.
EFFECTS = {'Off': dict(effect='Off'), 'Flash': dict(effect='Quick flash', duration=150), 'Fade': dict(effect='Short fade', duration=400)}

DEFAULTS = dict(layoutId='us', appearance=dict(PRESETS['Outline only']),
    effect='Short fade', duration=150, scale=100, hands='Both', highlightPressed=True, manualDefault=1,
    capitalAlphas=False, adaptiveContrast=False,
    # Keybard's Shifted Key Symbols and AltGr Symbols settings (same defaults); Keybard sends them with layoutId.
    shiftedLegends=True, altgrLegends=False,
    # Pointing devices in the overlay: drawn devices off, the sniper and boost pills on.
    showPointing=False, pointingPills=True)
# Settings that earlier test builds saved and this Host no longer has; dropped when read.
RETIRED = frozenset({'cursorMultiplier'})

# The balls Keybard can draw, in its order and with its names (Keybard's
# src/components/pointing-viz/webgl/materials.ts: BALLS, MAT_ORDER, DEFAULT_BALL).
BALL_NAMES = {'silver': 'Silver sparkle', 'red': 'Glossy red', 'black': 'Black sparkle', 'pearl_blue': 'Pearl blue',
              'pearl_purple': 'Pearl purple', 'pearl_white': 'Pearl white', 'pearl_black': 'Pearl black'}
BALLS = frozenset(BALL_NAMES)
DEFAULT_BALL = 'silver'
# Keybard draws every ball at these (BALL_GLOSS, BALL_SPARKLE); looks saved by older Keybards
# with other values would draw the overlay's balls differently, so these are always sent.
BALL_GLOSS, BALL_SPARKLE = 1.0, 0.75
# Boards whose pointing look is kept; the oldest is dropped beyond this.
REMEMBERED_POINTING_BOARDS = 16


def validate_pointing_look(value):
    """A board's pointing look from Keybard: uid plus optional left/right ball, gloss, sparkle.

    Only how the overlay draws the devices; nothing here reaches the board."""
    if not isinstance(value, dict) or set(value) - {'op', 'uid', 'left', 'right', 'gloss', 'sparkle'}:
        raise ValueError('Unknown pointing look fields')
    uid = value.get('uid')
    if not isinstance(uid, str) or not re.fullmatch(r'[0-9]{1,20}', uid): raise ValueError('Invalid board uid')
    look = {}
    for side in ('left', 'right'):
        if side in value:
            if value[side] not in BALLS: raise ValueError('Unknown ball')
            look[side] = value[side]
    for key in ('gloss', 'sparkle'):
        if key in value:
            if type(value[key]) not in (int, float) or not 0 <= value[key] <= 1: raise ValueError('Invalid pointing look value')
            look[key] = float(value[key])
    return uid, look


def _highlight_held_keys(config):
    # Hosts before version 1 saved highlightPressed: false on every connect, so a saved false
    # isn't a choice the user made: start everyone on the new default once.
    config['highlightPressed'] = True


# PREFERENCES_MIGRATIONS[n] upgrades a preferences config saved at version n to n + 1.
PREFERENCES_MIGRATIONS = [_highlight_held_keys]
PREFERENCES_VERSION = len(PREFERENCES_MIGRATIONS)


def validate_config(value):
    if isinstance(value, dict): value = {k: v for k, v in value.items() if k not in RETIRED}
    if not isinstance(value, dict) or set(value) - set(DEFAULTS):
        raise ValueError('Unknown host configuration fields')
    result = copy.deepcopy(DEFAULTS)
    for key, val in value.items():
        if key == 'appearance':
            if not isinstance(val, dict) or set(val) - set(DEFAULTS['appearance']):
                raise ValueError('Invalid appearance')
            for name, color in val.items():
                if name in ('fill', 'outline', 'legend', 'changed', 'pressed'):
                    if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color): raise ValueError('Invalid color')
                elif name == 'halo':
                    if type(color) is not bool: raise ValueError('Invalid halo')
                elif type(color) not in (float, int) or not 0 <= color <= (4 if name == 'width' else 100):
                    raise ValueError('Invalid opacity/width')
                result['appearance'][name] = color
        elif key in ('duration', 'scale', 'manualDefault'):
            lo, hi = dict(duration=(50, 750), scale=(50, 150), manualDefault=(0, 0xffffffff))[key]
            if type(val) is not int or not lo <= val <= hi: raise ValueError('Invalid numeric preference')
            result[key] = val
        elif key == 'layoutId':
            if not isinstance(val, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,32}', val): raise ValueError('Invalid keyboard language')
            result[key] = val
        elif key in ('highlightPressed', 'capitalAlphas', 'adaptiveContrast', 'showPointing', 'pointingPills', 'shiftedLegends', 'altgrLegends'):
            if type(val) is not bool: raise ValueError('Invalid on/off preference')
            result[key] = val
        elif val not in dict(effect=('Off', 'Quick flash', 'Short fade'), hands=('Both', 'Left', 'Right'))[key]:
            raise ValueError('Invalid option')
        else:
            result[key] = val
    return result


def remembered_board(value):
    """The remembered board from preferences, or None unless it has a string serial and uid.

    Earlier versions followed only this board. Now every board is followed, and this is
    just the one shown last: shown first at start, until a board is used."""
    if isinstance(value, dict) and isinstance(value.get('serial'), str) and isinstance(value.get('uid'), str):
        return value
    return None


def pinned_board(value):
    """The board chosen with "Show this board only" (its serial, or its id when it has none), or None."""
    if isinstance(value, str) and 1 <= len(value) <= 128 and value.isprintable():
        return value
    return None


class HostState:
    def __init__(self, path):
        self.lock = RLock()
        self.path = Path(path)
        self.token = secrets.token_urlsafe(32)
        self.config = copy.deepcopy(DEFAULTS)
        self.remembered = None
        # Automatic (None): the overlay follows the board in use. Else the one board to show.
        self.pinned = None
        self.revision = 0
        self.layout_revision = 0
        self.board = None
        self.status = 'Waiting for a Svalboard'
        self.devices = []
        self.selected_device = None  # the board on show
        self.boards = []             # every connected board: id, name, serial, status, ready, keys, pointing
        self.pointing_device = None  # a keyless board whose devices are drawn in the shown layout
        self.follow = 'auto'          # 'auto', or the id of the pinned board
        self.paused = False
        self.modifiers = None
        self.active = 0
        self.default = None
        self.valid = False
        self.pressed = []
        self.matrix_available = None
        self.practice_hidden = []
        self.practice_target = None
        self.practice_at = 0
        self.visible = True
        # When a page drawing the overlay (Keybard's ?hostOverlay page, e.g. a stream capture) last
        # polled /api/host/state with overlay=1. Keybard's Overlay dialog shows neither and doesn't send it.
        self.polled_at = 0.0
        self.session = secrets.token_hex(12)
        self.pointing_looks = {}
        # When Keybard last sent each uid's look, and the balls chosen in the Overlay per board
        # (serial): {serial: {'left': id, 'right': id, 'at': time}}. The most recent choice wins.
        self.look_times = {}
        self.board_balls = {}
        self.shown_serial = None  # the board on show, set by the Host
        try:
            saved = json.loads(self.path.read_text())
        except (OSError, ValueError):
            saved = {}
        if not isinstance(saved, dict): saved = {}
        try: self.config = validate_config(saved.get('config', {}))
        except (ValueError, TypeError, KeyError): pass
        self.remembered = remembered_board(saved.get('remembered'))
        self.pinned = pinned_board(saved.get('pinned'))
        looks = saved.get('pointingLooks')
        if isinstance(looks, dict):
            for uid, look in list(looks.items())[-REMEMBERED_POINTING_BOARDS:]:
                try:
                    key, checked = validate_pointing_look(dict(look, uid=uid))
                    self.pointing_looks[key] = checked
                except (ValueError, TypeError): pass
        times = saved.get('pointingLookTimes')
        if isinstance(times, dict):
            self.look_times = {k: float(v) for k, v in times.items() if k in self.pointing_looks and type(v) in (int, float)}
        balls = saved.get('boardBalls')
        if isinstance(balls, dict):
            for serial, choice in list(balls.items())[-REMEMBERED_POINTING_BOARDS:]:
                if not isinstance(serial, str) or not 1 <= len(serial) <= 128 or not isinstance(choice, dict): continue
                kept = {side: choice[side] for side in ('left', 'right') if choice.get(side) in BALLS}
                if kept and type(choice.get('at')) in (int, float): self.board_balls[serial] = dict(kept, at=float(choice['at']))
        version = saved.get('version', 0)
        if 'config' in saved and type(version) is int and 0 <= version < PREFERENCES_VERSION:
            for migrate in PREFERENCES_MIGRATIONS[version:]: migrate(self.config)
            try: self.save()
            except OSError: pass  # migrated in memory; saved with the next change

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(dict(version=PREFERENCES_VERSION, config=self.config, remembered=self.remembered, pinned=self.pinned, pointingLooks=self.pointing_looks,
            pointingLookTimes=self.look_times, boardBalls=self.board_balls)))
        temporary.replace(self.path)

    def configure(self, config, revision):
        checked = validate_config(config)
        with self.lock:
            if type(revision) is not int or revision != self.revision: raise RuntimeError('Configuration changed; refresh and try again')
            old = self.config
            self.config = checked
            try: self.save()
            except OSError:
                self.config = old
                raise
            self.revision += 1
            return self.revision

    def set_pointing_look(self, value):
        """Keep a board's pointing look (validated); saved with the preferences."""
        uid, look = validate_pointing_look(value)
        with self.lock:
            self.pointing_looks.pop(uid, None)
            self.pointing_looks[uid] = look
            self.look_times[uid] = time.time()
            while len(self.pointing_looks) > REMEMBERED_POINTING_BOARDS:
                self.pointing_looks.pop(next(iter(self.pointing_looks)))
            self.look_times = {k: v for k, v in self.look_times.items() if k in self.pointing_looks}
            try: self.save()
            except OSError: pass  # still used this session

    def set_board_ball(self, serial, side, ball):
        """The ball chosen in the Overlay for one hand of one board (by serial); saved."""
        if side not in ('left', 'right') or ball not in BALLS or not isinstance(serial, str) or not serial:
            raise ValueError('Unknown ball or hand')
        with self.lock:
            choice = self.board_balls.pop(serial, {})
            self.board_balls[serial] = dict(choice, **{side: ball}, at=time.time())
            while len(self.board_balls) > REMEMBERED_POINTING_BOARDS:
                self.board_balls.pop(next(iter(self.board_balls)))
            try: self.save()
            except OSError: pass  # still used this session

    def pointing_look(self, board=None, serial=None):
        """The balls the overlay draws for a board: per hand, the Overlay's choice for this board
        or Keybard's look for its uid, whichever was made last; always Keybard's gloss and sparkle."""
        board = self.board if board is None else board
        if not board: return {}
        serial = self.shown_serial if serial is None else serial
        uid = board.get('uid')
        keybard, sent = self.pointing_looks.get(uid, {}), self.look_times.get(uid, 0.0)
        mine = self.board_balls.get(serial, {}) if serial else {}
        look = {}
        for side in ('left', 'right'):
            ball = mine.get(side) if side in mine and mine['at'] >= sent else keybard.get(side, mine.get(side))
            if ball: look[side] = ball
        return dict(look, gloss=BALL_GLOSS, sparkle=BALL_SPARKLE)

    def snapshot(self, known_layout=None):
        with self.lock:
            return copy.deepcopy(dict(apiVersion=1, config=self.config, revision=self.revision,
                layoutRevision=self.layout_revision, board=self.board if known_layout != self.layout_revision else None,
                status=self.status, devices=self.devices, selectedDevice=self.selected_device,
                boards=self.boards, follow=self.follow, pointingDevice=self.pointing_device, paused=self.paused, active=self.active, default=self.default, valid=self.valid,
                modifiers=self.modifiers, pointingLook=self.pointing_look(), practiceHidden=self.practice_hidden, practiceTarget=self.practice_target, pressed=self.pressed, matrixAvailable=self.matrix_available, visible=self.visible, session=self.session))


def serialize_profile(profile):
    # String UIDs retain all 64 bits across JSON/JavaScript.
    return dict(name=profile.name, uid=str(profile.uid), fingerprint=profile.fingerprint, rows=10, cols=6,
        keymap=[[code for row in layer for code in row] for layer in profile.layers],
        keylayout={str(k.row * 6 + k.col): dict(row=k.row, col=k.col, x=k.x, y=k.y, w=k.w, h=k.h) for k in profile.keys},
        cosmetic=dict(layer={str(i): profile.layer_name(i) for i in range(len(profile.layers))}),
        trainerLabels={str(code): profile.label(code) for layer in profile.layers for row in layer for code in row},
        pointing=dict(getattr(profile, 'pointing', ()) or ()))
