/*
 * CZone proprietary helpers used to make a virtual switch bank appear as a
 * Navico CZone-compatible device on NMEA2000 so plotters such as Zeus, GO,
 * and Axiom discover and display the bank.
 *
 * All CZone proprietary PGNs share a 2-byte manufacturer-code/industry-code
 * header (mfg=295 = Navico/CZone, industry=4 = Marine), encoded as
 * little-endian bytes 0x27 0x99.
 *
 * Reference: github.com/negrusti/czone-emulator-cs (verified working with Axiom).
 */

const CZONE_HEADER_LO = 0x27
const CZONE_HEADER_HI = 0x99

export const CZONE_PGN_CIRCUIT_CONTROL = 65280 // inbound: MFD -> module commands
export const CZONE_PGN_CIRCUIT_BITMAP = 65284 // outbound: state bitmap; inbound: query
export const CZONE_PGN_ANNOUNCE = 65290 // outbound: one-shot announce
export const CZONE_PGN_LABEL_QUERY = 65299 // inbound: plotter asks for a label
export const CZONE_PGN_LABEL_REPLY = 130820 // outbound: label reply (fast packet)
export const CZONE_PGN_STATUS_EXTENDED = 130817 // outbound: extended status (fast packet)

export const CZONE_PGN_SWITCH_BANK_STATUS = 127501
export const CZONE_PGN_SWITCH_BANK_CONTROL = 127502

export const CZONE_FIRST_CIRCUIT_ID = 0x0d
export const CZONE_SUPPORTED_SWITCHES = 6

export const CZONE_COMMAND_ON = 0xf1
export const CZONE_COMMAND_OFF = 0xf2
export const CZONE_QUERY_CODE = 0xc8
export const CZONE_QUERY_SCOPE = 0x10

const CZONE_CIRCUIT_STATE_TYPE = 0x0f
const CZONE_EXTENDED_STATUS_PAGE = 0x01
const CZONE_EXTENDED_POSITIVE_FLAG = 0x04
const CZONE_ANALOG_BASE_OFFSET = 4
const CZONE_ANALOG_STRIDE = 3
const CZONE_EXTENDED_PAYLOAD_LEN = 22
const CZONE_BITS_PER_SWITCH = 2
const CZONE_SWITCHES_PER_STATUS_BYTE = 4

function header (): Buffer {
  return Buffer.from([CZONE_HEADER_LO, CZONE_HEADER_HI])
}

const CZONE_PRIORITY = 6

/**
 * Build a CZone proprietary frame as an Actisense-format string suitable
 * for emission via the SignalK `nmea2000out` event.
 *
 * Emitted as a string rather than a JSON PGN object because canboatjs's
 * `toPgn()` requires a registered PGN definition to serialize, and the
 * CZone proprietary PGNs (65280/65283/65284/65290/130817) are not part of
 * the standard canboat database; the raw `data` field on a JSON message
 * is ignored. The Actisense string path passes the bytes through unchanged.
 */
export function czoneFrame (pgn: number, payload: Buffer): string {
  const bytes = Buffer.concat([header(), payload])
  const hex = Array.from(bytes)
    .map(b =>
      b
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()
    )
    .join(',')
  return `${new Date().toISOString()},${CZONE_PRIORITY},${pgn},0,255,${
    bytes.length
  },${hex}`
}

/**
 * PGN 65290 announce payload (6 data bytes after the 2-byte CZone header):
 * carries an opaque module identifier and the dipswitch value the module
 * is claiming. Reference capture observed `3B B1 0D 00 00 18`.
 */
export function packAnnounce (uniqueSerial: number, dipswitch: number): Buffer {
  const buf = Buffer.alloc(6)
  buf[0] = uniqueSerial & 0xff
  buf[1] = (uniqueSerial >> 8) & 0xff
  buf[2] = (uniqueSerial >> 16) & 0x0f
  buf[5] = dipswitch & 0xff
  return buf
}

/**
 * Maximum bytes of `.zcf` data per PGN 130816 chunk. Per
 * czone-spec/spec/pgn-130816.md "Each non-terminal chunk carries
 * exactly 200 bytes of .zcf data."
 */
export const CZONE_ZCF_CHUNK_DATA_MAX = 200

/**
 * PGN 130816 (`.zcf` bus distribution) chunk payload after the 2-byte
 * CZone manufacturer header. Layout per czone-spec/spec/pgn-130816.md:
 *
 *   bytes 0..1  chunk_idx (u16 LE)
 *   byte 2      flag (observed = 0x01)
 *   bytes 3..20 reserved (18 zero bytes)
 *   bytes 21..  up to 200 bytes of .zcf data
 *
 * Returns a Buffer of length `21 + data.length`. The receiver
 * reassembles by concatenating the data slices in chunk_idx order.
 */
export function packZcfChunk (chunkIdx: number, data: Buffer): Buffer {
  if (data.length > CZONE_ZCF_CHUNK_DATA_MAX) {
    throw new Error(
      `zcf chunk data must be <= ${CZONE_ZCF_CHUNK_DATA_MAX} bytes (got ${data.length})`
    )
  }
  const payload = Buffer.alloc(21 + data.length)
  payload.writeUInt16LE(chunkIdx & 0xffff, 0)
  payload.writeUInt8(0x01, 2) // flag
  // bytes 3..20 are reserved zero (already zero from Buffer.alloc).
  data.copy(payload, 21)
  return payload
}

/**
 * Split a full `.zcf` file into the PGN 130816 chunks a Zeus 3S
 * broadcasts on the wire. czone-spec/captures/130816.log shows the
 * pattern: N full 200-byte chunks, optionally followed by one short
 * chunk, followed by an explicit zero-byte terminator chunk.
 *
 * Returns a list of `{ chunkIdx, payload }` objects ready to be wrapped
 * by `czoneFrame(130816, payload)` and emitted onto the bus.
 */
export function chunkZcf (
  zcf: Buffer,
  startChunkIdx: number = 0
): Array<{ chunkIdx: number; payload: Buffer }> {
  const chunks: Array<{ chunkIdx: number; payload: Buffer }> = []
  let offset = 0
  let chunkIdx = startChunkIdx & 0xffff
  while (offset + CZONE_ZCF_CHUNK_DATA_MAX <= zcf.length) {
    chunks.push({
      chunkIdx,
      payload: packZcfChunk(
        chunkIdx,
        zcf.slice(offset, offset + CZONE_ZCF_CHUNK_DATA_MAX)
      )
    })
    offset += CZONE_ZCF_CHUNK_DATA_MAX
    chunkIdx = (chunkIdx + 1) & 0xffff
  }
  if (offset < zcf.length) {
    chunks.push({
      chunkIdx,
      payload: packZcfChunk(chunkIdx, zcf.slice(offset))
    })
    chunkIdx = (chunkIdx + 1) & 0xffff
  }
  // Explicit zero-byte terminator chunk.
  chunks.push({ chunkIdx, payload: packZcfChunk(chunkIdx, Buffer.alloc(0)) })
  return chunks
}

/**
 * PGN 130817 (Status Extended) payload after the 2-byte CZone header. Per
 * `czone-spec/spec/pgn-130817.md`:
 *
 *   bytes 0-1: CZone manufacturer header (added by `czoneFrame`)
 *   byte 2:    `page` — observed `0x01` in our captures
 *   byte 3:    `dipswitch` — reporting module's dipswitch
 *   bytes 4..: per-circuit records, each 3 bytes:
 *     byte 0: `circuit_id` — matches the .zcf's circuit_id LSB (so the
 *             plotter can correlate this report back to the circuit
 *             declared in the modules section). Per the canonical
 *             bit-position rule (`spec/zcf-section-circuit-ids.md`
 *             "Rule 1"), this is `1 << i` for circuit index i < 8,
 *             else 0 (ambiguous; circuits 9-16 share circuit_id=0).
 *     byte 1: `value_low` — low byte of a signed 10-bit value
 *     byte 2: `value_high_and_sign` — bits 0..1 of value, bit 2 = sign
 *             (set = positive), bit 3 = primary alarm flag (kept clear
 *             so the plotter doesn't think we're asserting an alarm),
 *             bits 4..7 = additional flags (left clear)
 *
 * For switch banks (no current measurement), value is reported as
 * +0 (`value_low = 0`, `value_high_and_sign = 0x04` for "positive sign,
 * value=0"). The on/off state is conveyed via PGN 65284's bitmap, not
 * via PGN 130817.
 *
 * **Bug history**: a prior version of this function wrote the on/off
 * state into `byte 0` (the circuit_id slot) of every record. That made
 * every record claim circuit_id=0 or =1, which the plotter detected
 * as a configuration mismatch and surfaced as `eCZoneConfigState[12]`
 * "Configuration conflict detected on network" — the plotter would
 * refuse to leave its initial state. Fixed 2026-05-10 to put the
 * canonical circuit_id in byte 0.
 */
export function packStatusExtended (
  dipswitch: number,
  switches: boolean[]
): Buffer {
  // Per spec/pgn-130817.md, real CZone modules consistently emit 8 records
  // per frame (the spec's max). Emitting fewer than 8 (or fewer than
  // expected for the loaded .zcf's module type) triggers the plotter's
  // configuration-conflict detection (eCZoneConfigState[12]). Always
  // emit 8 records, with canonical bit-position circuit_ids 1, 2, 4,
  // 8, 16, 32, 64, 128 — same as what the .zcf generator's circuit_ids
  // section produces (spec/zcf-section-circuit-ids.md "Rule 1").
  // Switches beyond index 7 don't get a unique circuit_id (they share
  // id=0 in the .zcf too) and are reported via the PGN 65284 bitmap.
  const RECORD_COUNT = 8
  // Payload layout: [page, dipswitch, ...3-byte records].
  const payload = Buffer.alloc(2 + RECORD_COUNT * CZONE_ANALOG_STRIDE)
  payload[0] = CZONE_EXTENDED_STATUS_PAGE
  payload[1] = dipswitch & 0xff
  for (let i = 0; i < RECORD_COUNT; i++) {
    const offset = 2 + i * CZONE_ANALOG_STRIDE
    // Canonical circuit_id per spec: 1<<i (always; we emit the full 8 records)
    payload[offset] = (1 << i) & 0xff
    // value_low = 0 (no measurement)
    payload[offset + 1] = 0
    // value_high_and_sign: bit 2 set = positive sign, bits 0..1 = magnitude=0,
    // bit 3 (alarm flag) = 0, bits 4..7 = 0.
    payload[offset + 2] = CZONE_EXTENDED_POSITIVE_FLAG
  }
  return payload
}

/**
 * PGN 65284 carries the bank's circuit-state bitmap.
 *   byte[0..1] = CZone header (filled by caller via czoneFrame)
 *   byte[2]    = dipswitch
 *   byte[3]    = circuit state type (0x0F)
 *   byte[4..7] = 32-bit bitmap of circuits that are ON
 */
export function packCircuitBitmap (
  dipswitch: number,
  switches: boolean[]
): Buffer {
  const buf = Buffer.alloc(6)
  buf[0] = dipswitch & 0xff
  buf[1] = CZONE_CIRCUIT_STATE_TYPE
  for (let i = 0; i < Math.min(switches.length, 32); i++) {
    if (switches[i]) {
      buf[2 + (i >> 3)] |= 1 << (i & 7)
    }
  }
  return buf
}

/**
 * Standard PGN 127501 Binary Switch Bank Status as the CZone module reports
 * it: 8-byte payload starting with the bank instance, followed by 6 switch
 * states packed at 2 bits per switch, 4 switches per byte (so byte[1] holds
 * switches 1-4, byte[2] holds switches 5-6).
 */
export function packBinaryStatusReport (
  instance: number,
  switches: boolean[]
): Buffer {
  // PGN 127501 (Binary Status Report) is 8 bytes total: instance + 7 bytes
  // packing 28 indicator slots at 2 bits per slot. We pack as many of the
  // bank's switches as fit. Iterating the array (not a hardcoded count)
  // means a 16-channel COI bank packs all 16 indicators; a 6-channel OI
  // bank packs 6.
  const buf = Buffer.alloc(8)
  buf[0] = instance & 0xff
  const maxSlots = (8 - 1) * CZONE_SWITCHES_PER_STATUS_BYTE // 28
  const count = Math.min(switches.length, maxSlots)
  for (let i = 0; i < count; i++) {
    if (switches[i]) {
      const byteIndex = 1 + Math.floor(i / CZONE_SWITCHES_PER_STATUS_BYTE)
      const slot = i % CZONE_SWITCHES_PER_STATUS_BYTE
      const shift = slot * CZONE_BITS_PER_SWITCH
      buf[byteIndex] = (buf[byteIndex] & ~(0x03 << shift)) | (0x01 << shift)
    }
  }
  return buf
}

/**
 * Parse PGN 65280 inbound. Returns the circuit id and on/off command if the
 * payload is a CZone circuit-control command, or undefined otherwise.
 *
 * Frame layout (czone-spec/spec/pgn-65280.md):
 *   bytes 0..1: CZone header (0x27 0x99)
 *   bytes 2..3: circuit_id (uint16 LE)
 *   bytes 4..5: field_b (uint16 LE, observed 0)
 *   byte 6:    bit-packed; low nibble 0x1=ON, 0x2=OFF; bit 5=command_active
 *   byte 7:    bit-packed flags (mostly unknown)
 */
export function parseCircuitControl (
  payload: Buffer | number[] | undefined
): { circuitId: number; on: boolean } | undefined {
  if (!payload || payload.length < 8) return undefined
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (p[0] !== CZONE_HEADER_LO || p[1] !== CZONE_HEADER_HI) return undefined
  const circuitId = p[2] | (p[3] << 8)
  const lowNibble = p[6] & 0x0f
  if (lowNibble !== 0x01 && lowNibble !== 0x02) return undefined
  return { circuitId, on: lowNibble === 0x01 }
}

/**
 * Parse PGN 65299 inbound — a label-enumeration query from the plotter.
 * Frame layout (czone-spec/spec/pgn-65299.md):
 *   bytes 0..1: CZone header
 *   byte 2:    dipswitch of the target module
 *   bytes 3..4: (instance, sub_instance) — present when query_type == 0
 *   byte 5:    query_type byte (0x80 = controller label, 0x87 = system name)
 *   bytes 6..7: padding (typically 0xff)
 *
 * The byte-position interpretation here matches the spec's inferred layout;
 * see the open question at the end of pgn-65299.md.
 */
export function parseLabelQuery (
  payload: Buffer | number[] | undefined
):
  | {
      dipswitch: number
      instance: number
      subInstance: number
      queryType: number
    }
  | undefined {
  if (!payload || payload.length < 8) return undefined
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (p[0] !== CZONE_HEADER_LO || p[1] !== CZONE_HEADER_HI) return undefined
  return {
    dipswitch: p[2],
    instance: p[3],
    subInstance: p[4],
    queryType: p[5]
  }
}

/**
 * Pack a PGN 130820 label reply payload (after the 2-byte CZone header).
 * Frame layout (czone-spec/spec/pgn-130820.md):
 *   byte 0:    query_type echoed from the 65299 that triggered the reply
 *   bytes 1..2: index echoed from the 65299
 *   bytes 3..N-1: ASCII label (no NUL terminator on the wire — the unpacker
 *                  writes one after the loop)
 *   byte N:    trailing 0x00
 *
 * The packer caps the label at 217 bytes.
 */
export function packLabelReply (
  queryType: number,
  index: number,
  label: string
): Buffer {
  const labelBytes = Buffer.from(label, 'ascii').slice(0, 217)
  const buf = Buffer.alloc(3 + labelBytes.length + 1)
  buf[0] = queryType & 0xff
  buf.writeUInt16LE(index & 0xffff, 1)
  labelBytes.copy(buf, 3)
  // trailing NUL (already zero from Buffer.alloc)
  return buf
}

/**
 * Detect the CZone "bitmap query" form of inbound PGN 65284.
 */
export function isCircuitStateQuery (
  payload: Buffer | number[] | undefined
): boolean {
  if (!payload || payload.length < 4) return false
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  return (
    p[0] === CZONE_HEADER_LO &&
    p[1] === CZONE_HEADER_HI &&
    p[2] === CZONE_QUERY_CODE &&
    p[3] === CZONE_QUERY_SCOPE
  )
}

/**
 * Map a CZone circuitId to a 0-based switch index given the first circuit id
 * the bank's .zcf assigned. The Yacht Devices YDAB-01 uses 13 (= 0x0D); other
 * configurations can start anywhere.
 */
export function circuitIdToSwitchIndex (
  circuitId: number,
  firstCircuitId: number,
  switchCount: number = CZONE_SUPPORTED_SWITCHES
): number {
  const i = circuitId - firstCircuitId
  return i >= 0 && i < switchCount ? i : -1
}

/**
 * Parse a CZone dipswitch setting. Accepts the eight-position binary string
 * users enter on the plotter's CZone settings page, e.g. "00011000".
 *
 * The plotter renders dipswitches with switch 1 on the left, so the leftmost
 * character of the binary string is dipswitch position 1 (= bit 0). The byte
 * sent on the wire is therefore the bit-reversed numeric value of the string
 * read MSB-first.
 *
 * A number is accepted unchanged (its low 8 bits become the dipswitch byte).
 */
export function parseDipswitch (input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input & 0xff
  }
  if (typeof input === 'string') {
    const cleaned = input.trim()
    if (/^[01]{8}$/.test(cleaned)) {
      let out = 0
      for (let i = 0; i < 8; i++) {
        if (cleaned[i] === '1') out |= 1 << i
      }
      return out
    }
  }
  return 0x18
}

/**
 * Derive a stable 20-bit unique serial from a seed string.
 */
export function deriveUniqueSerial (seed: string | undefined): number {
  const s = String(seed ?? 'signalk')
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h & 0xfffff
}
