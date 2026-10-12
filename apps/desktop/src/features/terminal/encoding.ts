// Character encodings for a session (TRM-05). xterm.js parses UTF-8 only, so for a legacy
// encoding the output bytes are decoded here (the browser's TextDecoder, streaming) and given to
// xterm as text; typed text is encoded with an exact inverse table built from the same decoder.
// A character the encoding cannot represent is not sent (never replaced with something else).
//
// Limits, stated plainly: snippets and pastes sent natively by the core stay UTF-8, and the
// choice applies to this session only (it is not saved per host).

export interface EncodingOption {
  id: string;
  label: string;
  /** Bytes per character: single-byte tables are built from 256 bytes, double-byte from lead/trail pairs. */
  kind: "utf8" | "single" | "double";
}

export const ENCODINGS: EncodingOption[] = [
  { id: "utf-8", label: "UTF-8", kind: "utf8" },
  // The web's decoders treat ISO-8859-1 as Windows-1252 (bytes 0x80-0x9F are printable
  // characters, not C1 controls), so the two are one honest choice here.
  { id: "windows-1252", label: "Western (Windows-1252 / ISO-8859-1)", kind: "single" },
  { id: "iso-8859-15", label: "Western (ISO-8859-15)", kind: "single" },
  { id: "iso-8859-2", label: "Central European (ISO-8859-2)", kind: "single" },
  { id: "windows-1251", label: "Cyrillic (Windows-1251)", kind: "single" },
  { id: "koi8-r", label: "Cyrillic (KOI8-R)", kind: "single" },
  { id: "iso-8859-7", label: "Greek (ISO-8859-7)", kind: "single" },
  { id: "shift_jis", label: "Japanese (Shift_JIS)", kind: "double" },
  { id: "euc-jp", label: "Japanese (EUC-JP)", kind: "double" },
  { id: "euc-kr", label: "Korean (EUC-KR)", kind: "double" },
  { id: "gbk", label: "Chinese Simplified (GBK)", kind: "double" },
  { id: "big5", label: "Chinese Traditional (Big5)", kind: "double" },
];

export function encodingById(id: string): EncodingOption {
  return ENCODINGS.find((e) => e.id === id) ?? (ENCODINGS[0] as EncodingOption);
}

const tables = new Map<string, Map<string, Uint8Array>>();

/** Character → bytes for `id`, built once by decoding every byte (or byte pair) the encoding has. */
function table(option: EncodingOption): Map<string, Uint8Array> {
  const cached = tables.get(option.id);
  if (cached) return cached;
  const decoder = new TextDecoder(option.id, { fatal: true });
  const map = new Map<string, Uint8Array>();
  const add = (bytes: Uint8Array) => {
    try {
      const ch = decoder.decode(bytes);
      // First mapping wins, so ASCII stays one byte; skip anything that is not one character.
      if ([...ch].length === 1 && !map.has(ch)) map.set(ch, bytes);
    } catch {
      // Not a valid sequence in this encoding.
    }
  };
  for (let b = 0; b < 0x80; b += 1) add(Uint8Array.of(b));
  if (option.kind === "single") {
    for (let b = 0x80; b < 0x100; b += 1) add(Uint8Array.of(b));
  } else {
    for (let b = 0x80; b < 0x100; b += 1) add(Uint8Array.of(b));
    for (let lead = 0x81; lead < 0xff; lead += 1) {
      for (let trail = 0x40; trail < 0xff; trail += 1) add(Uint8Array.of(lead, trail));
    }
  }
  tables.set(option.id, map);
  return map;
}

export class SessionEncoding {
  readonly option: EncodingOption;
  private readonly decoder: TextDecoder | null;
  private readonly utf8 = new TextEncoder();

  constructor(id: string) {
    this.option = encodingById(id);
    this.decoder = this.option.kind === "utf8" ? null : new TextDecoder(this.option.id);
  }

  get isUtf8(): boolean {
    return this.decoder === null;
  }

  /** Output bytes as xterm input: unchanged for UTF-8, decoded text otherwise (stream-safe). */
  decode(bytes: Uint8Array): Uint8Array | string {
    return this.decoder ? this.decoder.decode(bytes, { stream: true }) : bytes;
  }

  /** Typed text as bytes for the session, and the characters that could not be represented. */
  encode(text: string): { bytes: Uint8Array; unsupported: string[] } {
    if (!this.decoder) return { bytes: this.utf8.encode(text), unsupported: [] };
    const map = table(this.option);
    const out: number[] = [];
    const unsupported: string[] = [];
    for (const ch of text) {
      const bytes = map.get(ch);
      if (bytes) out.push(...bytes);
      else unsupported.push(ch);
    }
    return { bytes: Uint8Array.from(out), unsupported };
  }
}
