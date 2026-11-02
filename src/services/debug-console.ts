// Sval DEBUG_CONSOLE (0x3E): turns the board's debug flag on or off, and reads
// it (keyboards/svalboard/docs/protocol.md, "Debug console"). The firmware
// prints key events on its debug console only while the flag is on, and any
// program on the computer can read that console. The board never saves the
// flag: it is off again whenever the board starts.
//
//   [0x3E][op]  op 0 off, 1 on, 2 read
//   -> [0x3E][op][status][flag]   status 0 done, 1 unknown op, 2 no console, 3 too short

/** GET_INFO byte 21 (the fourth feature byte), bit 2. */
export const SVIL_FLAG4_DEBUG_CONSOLE = 0x04;
export const CMD_SVIL_DEBUG_CONSOLE = 0x3e;

export const DEBUG_CONSOLE_OFF = 0;
export const DEBUG_CONSOLE_ON = 1;
export const DEBUG_CONSOLE_READ = 2;

export interface DebugConsoleReply {
    /** The board did what was asked (status 0). */
    ok: boolean;
    /** The flag after the request. */
    on: boolean;
}

export const hasDebugConsole = (featureFlags4: number | undefined | null): boolean =>
    ((featureFlags4 ?? 0) & SVIL_FLAG4_DEBUG_CONSOLE) !== 0;

/** The reply after the wrapper (it starts at the command echo); null if it isn't one. */
export function parseDebugConsoleReply(reply: Uint8Array | null | undefined, op: number): DebugConsoleReply | null {
    if (!reply || reply.length < 4 || reply[0] !== CMD_SVIL_DEBUG_CONSOLE || reply[1] !== op) return null;
    return { ok: reply[2] === 0, on: reply[3] === 1 };
}
