"""Read-only Sval v2/v3 client with the mandatory client wrapper.

It reads, and sends one thing only: which app is in front (APP_FOREGROUND, 0x40, SET or
CLEAR), to a board that advertises app rules. From APP_RULES (0x41) it sends only INFO and
READ, to learn the rules' sites (site rules); it never writes rules. That is runtime state the board forgets
after 15 s; it changes nothing stored on the board (see app_foreground below)."""
from dataclasses import dataclass, replace
from collections import namedtuple
import secrets
import sys
import time

from .board_layout import decode_definition, geometry_from_definition, keyless_instances
from .model import Profile, legend

USAGE_PAGE, USAGE = 0xFF61, 0x62
# Raw HID report length: 32 bytes on today's firmware, 64 on newer builds. It is
# read from the device's report descriptor (hidapi >= 0.14). When the binding
# can't give one, the first exchange probes: it writes 32 bytes, then 64 if that
# goes unanswered, and keeps the length of the first valid reply.
REPORT_SIZE = 32  # default, and the first size probed
SUPPORTED_REPORT_SIZES = (32, 64)
WRAPPER_OVERHEAD = 6  # [0xDD][client_id:4][protocol]
# Framing in front of a transfer's data, wrapper included: VIA keymap buffer
# [wrapper][cmd][offset:2][size] and Sval definition chunk [wrapper][cmd][offset:2][size].
CHUNK_HEADER = WRAPPER_OVERHEAD + 4
DEFAULT_LAYER_STATE_FLAG = 1 << 6
# Second feature byte: 0x16 appends the board's modifiers and Caps Word / Caps Lock.
MODIFIER_STATE_FLAG2 = 1 << 2
# Second feature byte, bit 3: the board answers POINTING_MOTION (0x2D), a read that
# returns and clears each hand's pointing motion since the last read.
POINTING_MOTION_FLAG2 = 1 << 3
POINTING_MOTION = 0x2D
# Second feature byte, bit 4: 0x2D keeps counts per reader id (the request's one
# argument byte) and reports each hand's CPI, so the Host and Keybard polling one
# board each see all of the motion. The Host reads as reader 2 (Keybard is 1);
# without the flag it sends 0, which every firmware treats as the one shared reader.
POINTING_MOTION_READERS_FLAG2 = 1 << 4
HOST_MOTION_READER = 2
# Second feature byte, bit 5: the board answers POINTING_CONTACTS (0x2F), a snapshot
# of every touch contact on its pad (native touchpad builds). Reading clears nothing.
POINTING_CONTACTS_FLAG2 = 1 << 5
POINTING_CONTACTS = 0x2F
# The most contacts a 0x2F reply carries: three fingers on each pad. The count byte says
# how many follow, so firmware that sends at most 5 reads the same.
MAX_CONTACTS = 6
PAD_COUNTS_X, PAD_COUNTS_Y = 2048, 1792
SHIFT_BITS = 0x22  # left and right Shift in the HID modifier byte
ALTGR_BIT = 0x40  # right Alt in the HID modifier byte: AltGr on layouts that have one
# Fifth feature byte (GET_INFO byte 22), bit 0: the board runs app rules and takes
# APP_FOREGROUND (0x40). Older firmware leaves it zero or sends a shorter reply.
APP_RULES_FLAG5 = 0x01
APP_FOREGROUND = 0x40
APP_STATUS, APP_SET, APP_CLEAR = 0x00, 0x01, 0x02
# APP_FOREGROUND status: the request reached the half without USB, which runs no rules.
APP_STATUS_NOT_USB_HALF = 2
# APP_RULES: only INFO and READ are ever sent from here.
APP_RULES = 0x41
APP_RULES_INFO, APP_RULES_READ = 0x00, 0x01
APP_RULES_HEADER, APP_RULES_MAX, APP_RULES_CHUNK = 4, 64, 48
# Format 2 (packed): header [2][count][flags][0], then per rule 12 bytes and its text:
# id u32, default, front, on u16, off u16, flags, text length, text (UTF-8).
APP_RULES_FORMAT, APP_RULE_HEAD, APP_RULES_RECORD = 2, 12, 1792
APP_RULES_OFF = 0x01       # header flags: App Layers off (no rule applies; the Host reads no addresses)
APP_RULE_OFF = 0x01        # rule flags: this rule is off
APP_RULE_SITE = 0x02       # rule flags: a website rule; its text is the site
# Format 1 (older test firmware): 24-byte rules with a 13-byte label at 11.
APP_RULES_FORMAT1, APP_RULE_BYTES1 = 1, 24
APP_RULE_LABEL = slice(11, 24)
AppRules = namedtuple("AppRules", "enabled rules")  # rules: [(app ID, text, flags)]
# Protocol -> command -> exact request argument length. No setter is expressible: the
# one request that isn't a read, APP_FOREGROUND, has its own fixed-shape methods.
READ_COMMANDS = {
    0xDF: {0x00: 0, 0x01: 2, 0x0D: 0, 0x0E: 3, 0x16: 0, 0x18: 0, 0x19: 0, 0x1B: 3, 0x2D: 1, 0x2F: 0},
    0xFE: {0x02: 2, 0x11: 0, 0x12: 3},
}


@dataclass(frozen=True)
class LayerSnapshot:
    active: int
    default: int | None = None  # None means not advertised; zero is a valid mask.
    # The board's own Shift and Caps Lock, or None on firmware that doesn't report them.
    # Caps Word counts as Caps Lock: it capitalizes letters and leaves symbols alone.
    modifiers: dict | None = None


def parse_pointing_motion(data):
    """A POINTING_MOTION reply's payload (after the command echo) as a dict, or None.

    format(1) modes(1) ms(1) left(10) right(10) axis(1); each hand: flags(1) dx(2) dy(2)
    h(1) v(1) buttons(1) touch_x(1) touch_y(1). Counts are raw sensor counts. Newer
    firmware on 64-byte reports adds reader(1) left_cpi(2) right_cpi(2); a hand's
    'cpi' is set only when the board reports one (non-zero).
    """
    data = bytes(data or b"")
    if len(data) < 24 or data[0] != 1:
        return None

    def hand(offset):
        flags = data[offset]
        return dict(valid=bool(flags & 1), scrolling=bool(flags & 2), touchValid=bool(flags & 0x10),
                    fingers=(flags >> 5) & 3,
                    dx=int.from_bytes(data[offset + 1:offset + 3], "little", signed=True),
                    dy=int.from_bytes(data[offset + 3:offset + 5], "little", signed=True),
                    touchX=data[offset + 8], touchY=data[offset + 9])
    modes = data[1]
    left, right = hand(3), hand(13)
    if len(data) >= 29:
        for block, offset in ((left, 25), (right, 27)):
            cpi = int.from_bytes(data[offset:offset + 2], "little")
            if cpi:
                block['cpi'] = cpi
    motion = dict(sniper=bool(modes & 1), boost=bool(modes & 2), elapsedMs=data[2],
                  left=left, right=right)
    velocity = parse_velocity_scroll(data)
    if velocity is not None:
        motion['velocityScroll'] = velocity
    # The sniper divisor and boost multiplier in force: payload 53 is 'F', then 54 and 55.
    # Firmware without them leaves 53 zero (and a 32-byte report has no room): no factors sent.
    if len(data) > POINTING_FACTORS_OFF + 2 and data[POINTING_FACTORS_OFF] == 0x46:
        motion['factors'] = dict(sniperDivisor=max(1, data[POINTING_FACTORS_OFF + 1]),
                                 boostFactor=max(1, data[POINTING_FACTORS_OFF + 2]))
    return motion


# The sniper and boost factors in a 0x2D payload: 'F' at 53, then the divisor and the multiplier.
POINTING_FACTORS_OFF = 53


# Velocity Scroll's block in a 0x2D payload: offsets 29-52, marked by 0x56 at 29.
VELOCITY_SCROLL_OFF = 29
VELOCITY_SCROLL_LEN = 24
VELOCITY_SCROLL_MAGIC = 0x56


def parse_velocity_scroll(data):
    """Velocity Scroll's state and curves from a 0x2D payload, as Keybard's VelocityScrollState, or None.

    magic(1) flags(1) offset x, y (int16, 0.01 mm) speed h, v (int16, 0.01 notch/s, +up)
    max (uint16, 0.01 notch/s), then dead zone (0.01 mm), gain (0.01 notch/s) and exponent
    (0.001) for the trackball and for the touchpad. Older firmware leaves the magic zero.
    """
    o = VELOCITY_SCROLL_OFF
    if len(data) < o + VELOCITY_SCROLL_LEN or data[o] != VELOCITY_SCROLL_MAGIC:
        return None
    flags = data[o + 1]
    s16 = lambda k: int.from_bytes(data[o + k:o + k + 2], "little", signed=True)
    u16 = lambda k: int.from_bytes(data[o + k:o + k + 2], "little")
    top = u16(10) / 100
    curve = lambda k: dict(deadMm=u16(k) / 100, gain=u16(k + 2) / 100, exponent=u16(k + 4) / 1000, maxNps=top)
    lock = (flags >> 4) & 3
    return dict(held=bool(flags & 1),
                padHand=('right' if flags & 4 else 'left') if flags & 2 else None,
                axisLock=bool(flags & 8),
                lockedAxis={1: 'vertical', 2: 'horizontal'}.get(lock, 'none'),
                offsetMm=dict(x=s16(2) / 100, y=s16(4) / 100),
                speedNps=dict(h=s16(6) / 100, v=s16(8) / 100),
                ball=curve(12), pad=curve(18))


def pad_unit(count, counts):
    """A pad count as -1..1: 0 is one edge, counts - 1 the other (as Keybard's padUnit)."""
    count = max(0, min(counts - 1, count))
    return count / (counts - 1) * 2 - 1


def parse_pointing_contacts(data):
    """A POINTING_CONTACTS reply's payload (after the command echo) as a dict, or None.

    format(1) flags(1) age_ms(1) n(1), then n x 4 bytes: [0] bits 0-3 contact ID, bit 4
    tip, bit 5 confidence, bit 6 right pad, bit 7 a finger the touchpad left out (its ID is
    from a space of its own; it comes back with leftOut=True); [1..3] x | y << 12 little-endian, x 0..2047
    across that pad, y 0..1791 down it. n is at most MAX_CONTACTS; a reply must hold every
    contact it counts. Contacts lifting (tip clear) are left out; x and y come back as -1..1
    from the pad's left and top edges.
    """
    data = bytes(data or b"")
    if len(data) < 4 or data[0] != 1:
        return None
    n = min(MAX_CONTACTS, data[3])
    if len(data) < 4 + 4 * n:
        return None
    flags = data[1]
    out = dict(reporting=bool(flags & 1), pads=dict(left=bool(flags & 2), right=bool(flags & 4)), left=[], right=[])
    for i in range(n):
        b = data[4 + 4 * i]
        if not b & 0x10:
            continue
        w = int.from_bytes(data[5 + 4 * i:8 + 4 * i], "little")
        contact = dict(id=b & 15, x=round(pad_unit(w & 0xFFF, PAD_COUNTS_X), 4),
                       y=round(pad_unit((w >> 12) & 0xFFF, PAD_COUNTS_Y), 4), confident=bool(b & 0x20))
        if b & 0x80:  # a finger the touchpad left out: listed after the rest, IDs of its own
            contact['leftOut'] = True
        out['right' if b & 0x40 else 'left'].append(contact)
    return out


def with_pad_contacts(motion, contacts):
    """The motion dict with each touchpad hand's contacts (an empty list when no finger is down)."""
    if motion is None or not contacts or not contacts['reporting']:
        return motion
    for side in ('left', 'right'):
        if contacts['pads'][side]:
            motion[side]['contacts'] = contacts[side]
    return motion


def pointing_kinds(definition, hardware):
    """Each hand's pointing module ('trackball', 'touchpad', 'trackpoint') from the
    definition's widget fragments and the 0x18 hardware bytes; None where not known."""
    out = dict(left=None, right=None)
    fragments = definition.get("fragments") if isinstance(definition, dict) else None
    instances = ((definition.get("composition") or {}).get("instances") if isinstance(definition, dict) else None)
    if not isinstance(fragments, dict) or not isinstance(instances, list):
        return out
    for index, instance in enumerate(instances):
        if not isinstance(instance, dict) or index >= len(hardware) or hardware[index] == 255:
            continue
        side = "left" if str(instance.get("id", "")).startswith("left_") else "right" if str(instance.get("id", "")).startswith("right_") else None
        if side is None:
            continue
        options = [instance] if "fragment" in instance else instance.get("fragment_options") or []
        for option in options:
            fragment = fragments.get(option.get("fragment")) if isinstance(option, dict) else None
            widget = fragment.get("widget") if isinstance(fragment, dict) else None
            if isinstance(widget, dict) and fragment.get("id") == hardware[index]:
                module = widget.get("module")
                if module in ("trackball", "touchpad", "trackpoint"):
                    out[side] = module
    return out


def unsettled_pointing(definition, hardware):
    """Indices of pointing instances whose 0x18 byte is still 255 (unknown).

    The firmware reports the other half's pointing module as 255 until that half
    has said what it has, a second or two after power-up; a read that early must
    be repeated, or that hand's device never shows."""
    fragments = definition.get("fragments") if isinstance(definition, dict) else None
    instances = ((definition.get("composition") or {}).get("instances") if isinstance(definition, dict) else None)
    if not isinstance(fragments, dict) or not isinstance(instances, list):
        return ()
    out = []
    for index, instance in enumerate(instances):
        if not isinstance(instance, dict) or index >= len(hardware) or hardware[index] != 255:
            continue
        options = [instance] if "fragment" in instance else instance.get("fragment_options") or []
        if any(isinstance(o, dict) and isinstance(fragments.get(o.get("fragment")), dict)
               and isinstance(fragments[o.get("fragment")].get("widget"), dict) for o in options):
            out.append(index)
    return tuple(out)


class ProtocolError(Exception):
    pass


class ClientExpired(ProtocolError):
    pass


class UnsupportedCommand(ProtocolError):
    pass


class Cancelled(Exception):
    pass


def report_size_from_descriptor(descriptor):
    """Bytes in the first output report of a HID report descriptor, or None.

    Walks the short items, tracking Report Size, Report Count and Report ID
    (with Push/Pop), and sums the Output items of the first report ID seen.
    """
    data = bytes(descriptor or b"")
    state = {"size": 0, "count": 0, "id": 0}
    stack, bits, first_id = [], {}, None
    i = 0
    while i < len(data):
        prefix = data[i]
        if prefix == 0xFE:  # long item: [0xFE][data size][tag][data]
            if i + 1 >= len(data):
                break
            i += 3 + data[i + 1]
            continue
        length = (0, 1, 2, 4)[prefix & 3]
        value = int.from_bytes(data[i + 1:i + 1 + length], "little")
        kind, tag = (prefix >> 2) & 3, prefix >> 4
        i += 1 + length
        if kind == 1:  # global
            if tag == 7:
                state["size"] = value
            elif tag == 8:
                state["id"] = value
            elif tag == 9:
                state["count"] = value
            elif tag == 10:
                stack.append(dict(state))
            elif tag == 11 and stack:
                state = stack.pop()
        elif kind == 0 and tag == 9:  # main: Output
            if first_id is None:
                first_id = state["id"]
            bits[state["id"]] = bits.get(state["id"], 0) + state["size"] * state["count"]
    if first_id is None:
        return None
    size = bits[first_id] // 8
    return size if size >= REPORT_SIZE else None


def device_report_size(device):
    """The device's raw HID report length from its descriptor, or None if unreadable."""
    get_descriptor = getattr(device, "get_report_descriptor", None)
    if get_descriptor is None:
        return None
    try:
        return report_size_from_descriptor(get_descriptor())
    except Exception:  # binding or OS can't read it: fall back to probing
        return None


def hid_backend(platform=sys.platform):
    # The hidapi wheel's default Linux backend is libusb, which reports no usage
    # pages and can detach the kernel keyboard driver. Use hidraw there.
    if platform.startswith("linux"):
        import hidraw
        return hidraw
    import hid
    return hid


def candidates(hid_module):
    # Product IDs vary across Svalboards and firmware builds. Match the dedicated
    # Sval collection, as Keybard does; never probe keyboard or pointer collections.
    result, seen = [], set()
    for device in hid_module.enumerate():
        if device.get("usage_page") != USAGE_PAGE or device.get("usage") != USAGE:
            continue
        path = device.get("path")
        if path is None or path in seen:
            continue
        seen.add(path)
        result.append(device)
    return result


def none_pointing(definition, hardware):
    """Indices of pointing instances whose 0x18 byte says "no pointing module".

    The firmware probes for a module again up to 30 s after power-on, so "none"
    early on can still turn into a module; see POINTING_NONE_WATCH."""
    fragments = definition.get("fragments") if isinstance(definition, dict) else None
    instances = ((definition.get("composition") or {}).get("instances") if isinstance(definition, dict) else None)
    if not isinstance(fragments, dict) or not isinstance(instances, list):
        return ()
    out = []
    for index, instance in enumerate(instances):
        if not isinstance(instance, dict) or index >= len(hardware) or hardware[index] == 255:
            continue
        options = [instance] if "fragment" in instance else instance.get("fragment_options") or []
        for option in options:
            fragment = fragments.get(option.get("fragment")) if isinstance(option, dict) else None
            widget = fragment.get("widget") if isinstance(fragment, dict) else None
            if isinstance(widget, dict) and fragment.get("id") == hardware[index] and widget.get("module") == "none":
                out.append(index)
                break
    return tuple(out)


# How long after the first profile read a hand that showed "no pointing module"
# is still re-read: the firmware's last probe is 30 s after power-on.
POINTING_NONE_WATCH = 35.0


class SvalReader:
    def __init__(self, device, clock=time.monotonic, cancelled=lambda: False, report_size=None):
        self.device = device
        # None until known: then the first exchange probes 32, then 64
        self.report_size = report_size or device_report_size(device)
        self.clock = clock
        self.cancelled = cancelled
        self.client_id = 0
        self.renew_at = 0
        self.feature_flags = 0
        self.feature_flags2 = 0
        self.feature_flags5 = 0
        self.load_deadline = None
        # The last board definition read: it only changes with new firmware, so a refresh reuses it.
        self.cached_definition = None
        # The 0x18 hardware bytes of the last profile read, and its pointing instances still unknown.
        self.profile_hardware = ()
        self.pointing_unsettled = ()
        # Pointing instances that read "no module", re-read until pointing_none_until
        # (the clock time POINTING_NONE_WATCH after this connection's first profile read).
        self.pointing_none = ()
        self.pointing_none_until = None

    def checkpoint(self):
        if self.cancelled():
            raise Cancelled()
        if self.load_deadline is not None and self.clock() > self.load_deadline:
            raise ProtocolError("Loading the board layout timed out")

    def _exchange(self, request, accept):
        self.checkpoint()
        sizes = (self.report_size,) if self.report_size else SUPPORTED_REPORT_SIZES
        sent = False
        for size in sizes:
            if len(request) > size:
                raise ProtocolError("Oversized request")
            packet = b"\0" + request.ljust(size, b"\0")
            written = self.device.write(packet)
            # Windows hidapi pads a short write to the device's report length and
            # returns that count, so more than asked is a complete write. While the
            # size is unknown, any other count means this is not the device's size.
            if self.report_size:
                if written < len(packet):
                    raise ProtocolError("Incomplete HID write")
            elif written != len(packet):
                continue
            sent = True
            deadline = self.clock() + .25
            while self.clock() < deadline:
                self.checkpoint()
                reply = bytes(self.device.read(self.report_size or max(SUPPORTED_REPORT_SIZES), 30))
                if not reply:
                    continue
                if (len(reply) != self.report_size if self.report_size
                        else len(reply) not in SUPPORTED_REPORT_SIZES):
                    raise ProtocolError("Malformed HID report length")
                result = accept(reply)
                if result is not None:
                    self.report_size = self.report_size or len(reply)
                    return result
        if not sent:
            raise ProtocolError("Incomplete HID write")
        raise ProtocolError("Svalboard response timed out")

    def chunk_size(self):
        """Data bytes per keymap or definition chunk: 22 at 32 bytes, 54 at 64."""
        return (self.report_size or REPORT_SIZE) - CHUNK_HEADER

    def bootstrap(self):
        nonce = secrets.token_bytes(20)
        prefix = b"\xdd\0\0\0\0" + nonce

        def accept(reply):
            if reply[:25] != prefix:
                return None
            client = int.from_bytes(reply[25:29], "little")
            ttl = int.from_bytes(reply[29:31], "little")
            if client in (0, 0xFFFFFFFF) or ttl < 66:
                raise ProtocolError("Invalid Sval client lease")
            return client, ttl

        self.client_id, ttl = self._exchange(prefix, accept)
        self.renew_at = self.clock() + min(50, (ttl - 65.536) / 2)

    def _read(self, command, args=b"", protocol=0xDF):
        allowed = READ_COMMANDS.get(protocol, {})
        if command not in allowed or len(args) != allowed[command]:
            raise ValueError("Command or argument length is outside the trainer read allowlist")
        if protocol == 0xFE and command == 0x02 and args != b"\x03\x00":
            raise ValueError("Only the read-only switch matrix at row zero is allowed")
        return self._transact(command, args, protocol)

    def _transact(self, command, args, protocol):
        for attempt in range(2):
            self.checkpoint()
            if not self.client_id or self.clock() >= self.renew_at:
                self.bootstrap()
            prefix = b"\xdd" + self.client_id.to_bytes(4, "little")

            def accept(reply):
                if reply[:5] != prefix:
                    return None
                if reply[5] == 0xFF:
                    if reply[6] == 1:
                        raise ClientExpired("Sval client lease expired")
                    raise ProtocolError(f"Sval wrapper error {reply[6]}")
                if reply[5] != protocol:
                    return None
                if reply[6] == 0xFF:
                    raise UnsupportedCommand(f"Board does not support read command {protocol:02X}:{command:02X}")
                if reply[6] != command:
                    return None
                data = reply[7:]
                echo_length = (3 if protocol == 0xFE and command == 0x12 else
                               2 if (protocol == 0xDF and command in (0x01, 0x0E)) or (protocol == 0xFE and command == 0x02) else
                               1 if protocol == 0xDF and command in (0x1B, APP_FOREGROUND, APP_RULES) else 0)
                if data[:echo_length] != args[:echo_length]:
                    return None
                return data

            try:
                return self._exchange(prefix + bytes((protocol, command)) + args, accept)
            except ClientExpired:
                self.client_id = 0
                if attempt:
                    raise
        raise ProtocolError("Unable to obtain client lease")

    def info(self):
        data = self._read(0x00)
        version = int.from_bytes(data[:4], "little")
        if version not in (2, 3):
            raise ProtocolError(f"Sval protocol {version} is not supported")
        self.feature_flags = data[12]
        self.feature_flags2 = data[17] if len(data) > 17 else 0
        self.feature_flags5 = data[20] if len(data) > 20 else 0
        return version, int.from_bytes(data[4:12], "little")

    def app_rules(self):
        """Whether the board takes APP_FOREGROUND (known after info())."""
        return bool(self.feature_flags5 & APP_RULES_FLAG5)

    def app_foreground(self, app_id, lifetime=0):
        """SET: the app in front (0: none). Lifetime 0 is the board's 15 s. Returns the reply's
        (status, rule index or 0xFF, flags). Never sent to a board without app rules."""
        if not self.app_rules():
            raise UnsupportedCommand("Board does not advertise app rules")
        if type(app_id) is not int or not 0 <= app_id <= 0xFFFFFFFF or type(lifetime) is not int or not 0 <= lifetime <= 60:
            raise ValueError("App ID must be a u32 and the lifetime 0-60 s")
        data = self._transact(APP_FOREGROUND, bytes((APP_SET,)) + app_id.to_bytes(4, "little") + bytes((lifetime,)), 0xDF)
        return data[1], data[2], data[3]

    def app_clear(self):
        """CLEAR: the Host is leaving, so no app is in front now. Returns the status."""
        if not self.app_rules():
            raise UnsupportedCommand("Board does not advertise app rules")
        return self._transact(APP_FOREGROUND, bytes((APP_CLEAR,)), 0xDF)[1]

    def app_rules_read(self):
        """The rules in use, from APP_RULES INFO and READ (never a write): AppRules(enabled,
        [(app ID, text, flags)]). enabled is False while App Layers is off on the board. Raises
        ProtocolError on a reply that doesn't fit; no rules for a board that stored none."""
        if not self.app_rules():
            raise UnsupportedCommand("Board does not advertise app rules")
        info = self._transact(APP_RULES, bytes((APP_RULES_INFO,)), 0xDF)
        if info is None or len(info) < 10 or info[1] != 0:
            raise ProtocolError("App rules INFO failed")
        count = min(info[5], APP_RULES_MAX)
        if info[2] == APP_RULES_FORMAT and info[4] == APP_RULE_HEAD and len(info) >= 13:
            total = min(int.from_bytes(info[10:12], "little"), APP_RULES_RECORD)
        elif info[2] == APP_RULES_FORMAT1 and info[4] == APP_RULE_BYTES1:
            total = APP_RULES_HEADER + count * APP_RULE_BYTES1
        else:
            raise ProtocolError(f"Unknown app rules format {info[2]}")
        record = self._app_rules_bytes(max(total, APP_RULES_HEADER), info[8])
        if record[0] == 0 and record[1] == 0: return AppRules(True, [])
        if record[0] == APP_RULES_FORMAT1:
            out = []
            for i in range(min(record[1], count)):
                rule = record[APP_RULES_HEADER + i * APP_RULE_BYTES1:APP_RULES_HEADER + (i + 1) * APP_RULE_BYTES1]
                label = bytes(rule[APP_RULE_LABEL]).split(b"\0", 1)[0].decode("utf-8", "replace")
                out.append((int.from_bytes(rule[:4], "little"), label, 0))
            return AppRules(True, out)
        if record[0] != APP_RULES_FORMAT: raise ProtocolError(f"Unknown app rules record format {record[0]}")
        out, at = [], APP_RULES_HEADER
        for _ in range(min(record[1], APP_RULES_MAX)):
            if at + APP_RULE_HEAD > len(record): raise ProtocolError("App rules record ends inside a rule")
            n = record[at + 11]
            if at + APP_RULE_HEAD + n > len(record): raise ProtocolError("App rules record ends inside a rule's text")
            text = bytes(record[at + APP_RULE_HEAD:at + APP_RULE_HEAD + n]).decode("utf-8", "replace")
            out.append((int.from_bytes(record[at:at + 4], "little"), text, record[at + 10]))
            at += APP_RULE_HEAD + n
        return AppRules(not record[2] & APP_RULES_OFF, out)

    def _app_rules_bytes(self, total, board_chunk):
        """READ the first total bytes of the record, in chunks that fit the report."""
        # Reply data: [op][status][offset:2][len][bytes], after the 7-byte wrapper and command.
        chunk = max(1, min(board_chunk or APP_RULES_CHUNK, APP_RULES_CHUNK, (self.report_size or 32) - 12))
        record = bytearray()
        for offset in range(0, total, chunk):
            length = min(chunk, total - offset)
            data = self._transact(APP_RULES, bytes((APP_RULES_READ,)) + offset.to_bytes(2, "little") + bytes((length,)), 0xDF)
            if (data is None or len(data) < 5 + length or data[1] != 0
                    or int.from_bytes(data[2:4], "little") != offset or data[4] != length):
                raise ProtocolError("App rules READ failed")
            record += data[5:5 + length]
        return record

    def app_layers(self):
        """With app rules, the layers keys use now and the default layer state, from
        APP_FOREGROUND STATUS: a rule changes layers without touching the user's own state
        (0x16). None on other firmware or when the read fails, so callers use 0x16."""
        if not self.app_rules():
            return None
        data = self._transact(APP_FOREGROUND, bytes((APP_STATUS,)), 0xDF)
        if data is None or len(data) < 31 or data[1] != 0:
            return None
        return int.from_bytes(data[26:30], "little"), int.from_bytes(data[18:22], "little")

    def layer_state(self):
        shown = self.app_layers()
        return shown[0] if shown else int.from_bytes(self._read(0x16)[:4], "little")

    def layer_snapshot(self):
        """The layers to show (the rule's, with app rules), the default layer and the modifiers."""
        data = self._read(0x16)
        default = (int.from_bytes(data[4:8], "little")
                   if self.feature_flags & DEFAULT_LAYER_STATE_FLAG else None)
        active = int.from_bytes(data[:4], "little")
        shown = self.app_layers()
        if shown:
            active, default = shown
        modifiers = None
        if self.feature_flags2 & MODIFIER_STATE_FLAG2:
            mods, status = data[8], data[9]
            modifiers = dict(shift=bool(mods & SHIFT_BITS), capsLock=bool(status & 2) != bool(status & 1), altgr=bool(mods & ALTGR_BIT))
        return LayerSnapshot(active, default, modifiers)

    def pointing_motion(self):
        """Each hand's motion since the last read, or None on firmware without 0x2D (never sent there)."""
        if not self.feature_flags2 & POINTING_MOTION_FLAG2:
            return None
        reader = HOST_MOTION_READER if self.feature_flags2 & POINTING_MOTION_READERS_FLAG2 else 0
        motion = parse_pointing_motion(self._read(POINTING_MOTION, bytes((reader,))))
        if motion is not None and self.feature_flags2 & POINTING_CONTACTS_FLAG2:
            motion = with_pad_contacts(motion, self.pointing_contacts())
        return motion

    def pointing_contacts(self):
        """Every touch contact on its pad, or None on firmware without 0x2F (never sent there)."""
        if not self.feature_flags2 & POINTING_CONTACTS_FLAG2:
            return None
        return parse_pointing_contacts(self._read(POINTING_CONTACTS))

    def pressed_keys(self):
        # VIA GET_KEYBOARD_VALUE / SWITCH_MATRIX_STATE, row offset zero.
        # Svalboard's 10 rows × 6 columns fit in ten bytes after the two echoes.
        data = self._read(0x02, b"\x03\x00", protocol=0xFE)
        rows = data[2:12]
        if any(row & 0xC0 for row in rows):
            raise ProtocolError("Invalid Svalboard matrix column bits")
        return frozenset((row, col) for row, bits in enumerate(rows)
                         for col in range(6) if bits & (1 << col))

    def definition(self):
        size = int.from_bytes(self._read(0x0D)[:4], "little")
        if not 1 <= size <= 65536:
            raise ProtocolError("Board definition exceeds the 16-bit transfer range")
        payload = bytearray()
        while len(payload) < size:
            count = min(self.chunk_size(), size - len(payload))
            args = len(payload).to_bytes(2, "little") + bytes((count,))
            data = self._read(0x0E, args)
            # The firmware may send less than asked (it caps chunks at 22 bytes), never none
            got = data[2]
            if not 1 <= got <= count:
                raise ProtocolError("Truncated board definition chunk")
            payload.extend(data[3:3 + got])
        return decode_definition(payload)

    def fragment_state(self, command):
        if command not in (0x18, 0x19):
            raise ValueError("Not a fragment read")
        data = self._read(command)
        if data[0] > 21:
            raise ProtocolError("Invalid fragment state count")
        return tuple(data[1:1 + data[0]])

    def pointing_none_watched(self):
        """The "no module" instances still worth re-reading (none after POINTING_NONE_WATCH)."""
        if not self.pointing_none or self.pointing_none_until is None or self.clock() >= self.pointing_none_until:
            return ()
        return self.pointing_none

    def pointing_watching(self):
        """True while a pointing instance may still change: unknown, or "no module" early on."""
        return bool(self.pointing_unsettled or self.pointing_none_watched())

    def pointing_settled(self):
        """True once a pointing module unknown at the last profile read is known, or one that
        read "no module" now reads something else (one 0x18 read)."""
        none = self.pointing_none_watched()
        if not self.pointing_unsettled and not none:
            return False
        hardware = self.fragment_state(0x18)
        if any(i < len(hardware) and hardware[i] != 255 for i in self.pointing_unsettled):
            return True
        return any(i < len(hardware) and hardware[i] not in (255, self.profile_hardware[i]) for i in none)

    def keymap(self):
        count = self._read(0x11, protocol=0xFE)[0]
        if not 1 <= count <= 32:
            raise ProtocolError("Board layer count must be 1–32")
        size = count * 10 * 6 * 2
        raw = bytearray()
        while len(raw) < size:
            amount = min(self.chunk_size(), size - len(raw))
            args = len(raw).to_bytes(2, "big") + bytes((amount,))
            data = self._read(0x12, args, protocol=0xFE)
            raw.extend(data[3:3 + amount])
        return count, bytes(raw)

    def labels(self, kind, limit):
        """Read sparse v2/v3 UTF-8 labels, requiring strictly advancing indices."""
        labels = {}
        start = 0
        while start < limit:
            data = self._read(0x1B, bytes((kind,)) + start.to_bytes(2, "little"))
            found, index = data[1], int.from_bytes(data[2:4], "little")
            if found not in (0, 1):
                raise ProtocolError("Invalid label lookup response")
            if not found:
                break
            if not start <= index < limit:
                raise ProtocolError("Invalid label lookup index")
            try:
                label = data[4:20].split(b"\0", 1)[0].decode("utf-8")
            except UnicodeError as exc:
                raise ProtocolError("Invalid UTF-8 board label") from exc
            labels[index] = "".join(c for c in label if c.isprintable())
            start = index + 1
        return labels

    def read_profile(self, uid, progress=lambda message: None, reuse_definition=False):
        """Publishable only after all reads succeed; no partial layout escapes.

        reuse_definition skips re-reading the board definition (about a third of the
        transfer) when one was read on this connection; everything else is read again.
        """
        self.load_deadline = self.clock() + 60
        try:
            if reuse_definition and self.cached_definition is not None:
                definition = self.cached_definition
            else:
                progress("Reading board definition…")
                definition = self.cached_definition = self.definition()
            has_fragments = "fragments" in definition or "fragment_schema_version" in definition
            hardware = self.fragment_state(0x18) if has_fragments else ()
            selections = self.fragment_state(0x19) if has_fragments else ()
            keys = geometry_from_definition(definition, hardware, selections)
            progress("Reading keymap from board…")
            previous = self.keymap()
            for _ in range(3):
                self.checkpoint()
                current = self.keymap()
                if current == previous:
                    break
                previous = current
            else:
                raise ProtocolError("Keymap changed during loading; finish editing and reload")
            count, raw = current
            layers = [[[int.from_bytes(raw[2 * ((layer * 10 + row) * 6 + col):
                                           2 * ((layer * 10 + row) * 6 + col) + 2], "big")
                        for col in range(6)] for row in range(10)] for layer in range(count)]
            name = definition.get("name", "Svalboard")
            if not isinstance(name, str) or not name or len(name) > 128 or not name.isprintable():
                name = "Svalboard"
            profile = Profile.parse({"uid": uid, "layout": layers}, name + " · board")
            progress("Reading layer and behavior labels…")
            layer_names = self.labels(0, count)
            td_names = self.labels(1, 256)
            macro_names = self.labels(2, 256)
            code_labels = {}
            custom = definition.get("customKeycodes", [])
            if not isinstance(custom, list) or len(custom) > 64:
                raise ValueError("Invalid custom keycode definitions")
            for index, item in enumerate(custom):
                if not isinstance(item, dict):
                    raise ValueError("Invalid custom keycode definition")
                label = item.get("shortName") or item.get("name")
                if not isinstance(label, str) or not 1 <= len(label) <= 128 or any(not c.isprintable() and c != "\n" for c in label):
                    raise ValueError("Invalid custom keycode label")
                code_labels[0x7E00 + index] = label
                if index < 32:
                    code_labels[0x7E40 + index] = label
            used_codes = {code for layer in layers for row in layer for code in row}
            for code in sorted(used_codes):
                if 0x5700 <= code <= 0x57FF:
                    index = code - 0x5700
                    data = self._read(0x01, index.to_bytes(2, "little"))
                    values = [int.from_bytes(data[i:i + 2], "little") for i in (2, 4, 6, 8)]
                    # Keep TD references explicit to avoid recursive definitions.
                    actions = [f"{name}: {legend(value)}" for name, value in zip(
                        ("tap", "hold", "double", "tap-hold"), values) if value]
                    title = td_names.get(index, f"TD({index})")
                    code_labels[code] = title + ("\n" + " / ".join(actions) if actions else "")
                index = code - 0x7700 if 0x7700 <= code <= 0x777F else code - 0x7680 + 128
                if (0x7700 <= code <= 0x777F or 0x7680 <= code <= 0x76FF) and index in macro_names:
                    code_labels[code] = f"Macro {index}\n{macro_names[index]}"
            # Recheck identity and geometry selection around the transfer.
            if self.info()[1] != uid:
                raise ProtocolError("Board identity changed during loading")
            if has_fragments:
                keyless = keyless_instances(definition)
                def keyed(state):
                    return tuple(v for i, v in enumerate(state) if i not in keyless)
                if (keyed(hardware) != keyed(self.fragment_state(0x18))
                        or keyed(selections) != keyed(self.fragment_state(0x19))):
                    raise ProtocolError("Cluster selection changed during loading; reload")
            pointing = tuple(pointing_kinds(definition, hardware).items()) if has_fragments else ()
            self.profile_hardware = tuple(hardware)
            self.pointing_unsettled = unsettled_pointing(definition, hardware) if has_fragments else ()
            self.pointing_none = none_pointing(definition, hardware) if has_fragments else ()
            if self.pointing_none_until is None:
                self.pointing_none_until = self.clock() + POINTING_NONE_WATCH
            return replace(profile, keys=keys, layer_names=tuple(layer_names.items()),
                           code_labels=tuple(code_labels.items()), from_board=True, pointing=pointing)
        finally:
            self.load_deadline = None
