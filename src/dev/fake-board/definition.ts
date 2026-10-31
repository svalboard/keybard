// The keyboard definition the simulated Svalboard sends, and the facts about it
// the firmware also compiles in (fragment instances, custom keycodes).
import LZMA from "js-lzma";
import { DEFINITION_LZMA_BASE64 } from "./definition.generated";

function fromBase64(text: string): Uint8Array {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

/** The compressed definition, byte for byte as DEFINITION_CHUNK sends it. */
export const DEFINITION_BYTES = fromBase64(DEFINITION_LZMA_BASE64);

export interface FakeDefinition {
    name: string;
    matrix: { rows: number; cols: number };
    customKeycodes?: { name: string; title: string; shortName?: string }[];
    fragments?: Record<string, { id: number }>;
    composition?: { instances: { id: string; hardware_detect?: boolean }[] };
}

function decompress(bytes: Uint8Array): string {
    let offset = 0;
    const out: number[] = [];
    LZMA.decompressFile(
        { readByte: () => (offset < bytes.length ? bytes[offset++] : -1) },
        { writeByte: (b: number) => { out.push(b); } },
    );
    return new TextDecoder().decode(new Uint8Array(out));
}

/** The definition as JSON (sval.json). */
export const DEFINITION: FakeDefinition = JSON.parse(decompress(DEFINITION_BYTES));

const instances = DEFINITION.composition?.instances ?? [];

/** sval_fragment_get_instance_count(): the composition's instances. */
export const FRAGMENT_INSTANCE_COUNT = instances.length;

/** Instances the board detects (the pointing slots, SVAL_FRAGMENT_IDX_*_POINTING). */
export const POINTING_FRAGMENT_INSTANCES = instances.flatMap((inst, i) => (inst.hardware_detect ? [i] : []));

/** SVAL_FRAGMENT_ID_POINTING_NONE: what a pointing slot with no module detects. */
export const POINTING_NONE_FRAGMENT_ID = DEFINITION.fragments?.pointing_none?.id ?? 0xff;

/** SVAL_FRAGMENT_ID_POINTING_TOUCHPAD_AZOTEQ: a pointing slot with an Azoteq pad. */
export const POINTING_AZOTEQ_FRAGMENT_ID = DEFINITION.fragments?.pointing_touchpad_azoteq?.id ?? 7;
