/*
 * .zcf parser + byte-for-byte round-trip encoder + template-based generator.
 *
 * Port of czone-spec/tools/zcf_header.py + zcf_sections.py + zcf_encode.py
 * to TypeScript. Round-trip identity (parse -> encode == original bytes)
 * is locked in by the unit tests in test/zcf-encoder.test.mjs against three
 * real .zcf files: Test.zcf (781), config-6.zcf (1014), CompassRose.zcf
 * (6384). The Python reference encodes the same three files identically.
 *
 * Field meanings and section layouts come from czone-spec/spec/zcf-*.md.
 * Anything we don't understand on a parsed file is preserved by the encoder
 * verbatim (raw byte-arrays for the global-config sub-blocks, the per-circuit
 * flag fields, the trailing-section payloads, etc.).
 *
 * The `generate(spec, template)` entry point lets the plugin synthesise a
 * .zcf for the user to download and load via the CZone Configuration Tool:
 * starting from a known-good template, only the labelled "user-visible"
 * fields are mutated (config name, the emulated module's dipswitch + name,
 * and the circuits + circuit_ids list).
 */

const CRC8_TABLE_HEX =
  '00070e091c1b1215383f363124232a2d70777e796c6b6265484f464154535a5d' +
  'e0e7eee9fcfbf2f5d8dfd6d1c4c3cacd90979e998c8b8285a8afa6a1b4b3babd' +
  'c7c0c9cedbdcd5d2fff8f1f6e3e4edeab7b0b9beabaca5a28f88818693949d9a' +
  '2720292e3b3c35321f18111603040d0a5750595e4b4c45426f68616673747d7a' +
  '898e878095929b9cb1b6bfb8adaaa3a4f9fef7f0e5e2ebecc1c6cfc8dddad3d4' +
  '696e676075727b7c51565f584d4a4344191e171005020b0c21262f283d3a3334' +
  '4e49404752555c5b7671787f6a6d64633e39303722252c2b0601080f1a1d1413' +
  'aea9a0a7b2b5bcbb9691989f8a8d8483ded9d0d7c2c5cccbe6e1e8effafdf4f3'

const CRC8_TABLE = Buffer.from(CRC8_TABLE_HEX, 'hex')

export function crc8 (data: Buffer): number {
  let c = 0
  for (let i = 0; i < data.length; i++) {
    c = CRC8_TABLE[c ^ data[i]]
  }
  return c
}

// Standard zlib CRC32 (polynomial 0xEDB88320), low 20 bits returned.
const CRC32_TABLE: number[] = (() => {
  const t = new Array<number>(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[i] = c >>> 0
  }
  return t
})()

export function crc32Lo20 (data: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = (CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) & 0xfffff
}

// ------------------------------- structures -------------------------------

export interface ZcfHeader {
  version: number
  reservedByte9: number
  unknown_10_13: Buffer // 4 bytes; observed zero in our corpus
}

export interface ConfigName {
  length: number
  name: string
}

export interface ModuleRecord {
  dipswitch: number
  moduleSpecificValue: number // wire byte 1
  moduleSpecificValue2: number // wire byte 2
  nameFlag: number // bit 7 of byte 3
  name: string
  trailer: number
}

export interface ModulesSection {
  sectionTag: number // = 0x05
  records: ModuleRecord[]
}

export interface BacklightZoneRecord {
  name: string
  fieldA: number
  fieldB: number
  fieldC: number
}

export interface BacklightZonesSection {
  sectionTag: number // = 0x04
  records: BacklightZoneRecord[]
}

export interface GlobalConfigBlock {
  metadataTotalByteCount: number
  metadataStrings: string[] // always 5 entries
  flagsByte: number
  subBlocks: Buffer[] // 6 entries, each 33 bytes
}

export interface OutputRecord {
  channelAddress: number
  flagsBytes: Buffer // 5 bytes
  name: string
}

export interface DisplayRefRecord {
  displayAddress: number
  flagsA: number
  flagsB: number // bit 2 indicates transient
  transient: boolean
  extra: Buffer // 1 byte for normal, 10 bytes for transient
}

export interface CircuitRecord {
  circuitIndex: number
  flagsA: number
  flagsB: number
  field2a: number
  name: string
  outputs: OutputRecord[]
  displayRefs: DisplayRefRecord[]
}

export interface CircuitsSection {
  sectionTag: number // = 0x08
  formatHints: Buffer // 3 bytes, expected = 08 05 0E
  records: CircuitRecord[]
}

export interface CircuitIdRecord {
  channelAddress: number
  flags: Buffer // 11 bytes
  circuitId: number // u32 user-set ID
  name: string
}

export interface CircuitIdsSection {
  sectionTag: number // = 0x12
  records: CircuitIdRecord[]
}

export interface TrailingSection {
  sectionPayloadSize: number
  recordCount: number
  sectionTag: number
  payload: Buffer // bytes after the 7-byte header (size = sectionPayloadSize - 3)
}

export interface ZcfBody {
  configName: ConfigName
  modules: ModulesSection
  backlightZones: BacklightZonesSection
  globalConfig: GlobalConfigBlock
  circuits: CircuitsSection
  circuitIds: CircuitIdsSection
  trailingSections: TrailingSection[]
}

export interface ParsedZcf {
  header: ZcfHeader
  body: ZcfBody
}

// --------------------------------- constants ------------------------------

const HEADER_SIZE = 14
const CONFIG_NAME_OFFSET = 14
const MODULES_SECTION_TAG = 0x05
const BACKLIGHT_ZONES_SECTION_TAG = 0x04
const CIRCUITS_SECTION_TAG = 0x08
const CIRCUITS_FORMAT_HINTS = Buffer.from([0x08, 0x05, 0x0e])
const CIRCUIT_IDS_SECTION_TAG = 0x12

const GLOBAL_CONFIG_SUBBLOCK_COUNT = 6
const GLOBAL_CONFIG_SUBBLOCK_SIZE = 33
// Variable-length metadata-strings header + 1 flags byte + 6 fixed 33-byte sub-blocks.
// When all 5 metadata strings are empty the header is 6 bytes and the block totals 205;
// real-world configs with populated strings produce a larger block.
const GLOBAL_CONFIG_FIXED_TAIL_SIZE =
  1 + GLOBAL_CONFIG_SUBBLOCK_COUNT * GLOBAL_CONFIG_SUBBLOCK_SIZE // 199
const GLOBAL_CONFIG_SUBBLOCK_MARKER = 0x20

// --------------------------------- parser ---------------------------------

export function parseHeader (data: Buffer): ZcfHeader {
  if (data.length < HEADER_SIZE + 1) {
    throw new Error(
      `file too short: ${data.length} bytes (need at least ${HEADER_SIZE + 1})`
    )
  }
  return {
    version: data[0],
    reservedByte9: data[9],
    unknown_10_13: data.slice(10, 14)
  }
}

function parseConfigName (
  data: Buffer,
  offset: number
): { value: ConfigName; next: number } {
  if (offset >= data.length) {
    throw new Error(
      `config name offset ${offset} past end of data (${data.length} bytes)`
    )
  }
  const length = data[offset]
  const end = offset + 1 + length
  if (end > data.length) {
    throw new Error(`config name length ${length} extends past end of data`)
  }
  return {
    value: { length, name: data.slice(offset + 1, end).toString('ascii') },
    next: end
  }
}

function parseModulesSection (
  data: Buffer,
  offset: number
): { value: ModulesSection; next: number } {
  if (offset + 7 > data.length) {
    throw new Error(`modules section header runs past end at offset ${offset}`)
  }
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== MODULES_SECTION_TAG) {
    throw new Error(
      `expected modules tag 0x05, got 0x${sectionTag.toString(16)}`
    )
  }
  const sectionEnd = offset + 4 + sectionPayloadSize
  if (sectionEnd > data.length) {
    throw new Error(
      `modules section claims to end at ${sectionEnd} but file is ${data.length} bytes`
    )
  }
  let o = offset + 7
  const records: ModuleRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 5 > sectionEnd)
      throw new Error(`module record ${i} header past section end`)
    const dipswitch = data[o]
    const b1 = data[o + 1]
    const b2 = data[o + 2]
    const b3 = data[o + 3]
    const nameLen = b3 & 0x7f
    const nameFlag = (b3 >> 7) & 1
    const nameEnd = o + 4 + nameLen
    if (nameEnd + 1 > sectionEnd)
      throw new Error(`module record ${i} runs past section end`)
    const name = data.slice(o + 4, nameEnd).toString('ascii')
    const trailer = data[nameEnd]
    records.push({
      dipswitch,
      moduleSpecificValue: b1,
      moduleSpecificValue2: b2,
      nameFlag,
      name,
      trailer
    })
    o = nameEnd + 1
  }
  if (o !== sectionEnd)
    throw new Error(
      `modules section size drift: parsed ${o}, ends at ${sectionEnd}`
    )
  return { value: { sectionTag, records }, next: sectionEnd }
}

function parseBacklightZonesSection (
  data: Buffer,
  offset: number
): { value: BacklightZonesSection; next: number } {
  if (offset + 7 > data.length)
    throw new Error(`backlight zones header past end at ${offset}`)
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== BACKLIGHT_ZONES_SECTION_TAG) {
    throw new Error(
      `expected backlight tag 0x04, got 0x${sectionTag.toString(16)}`
    )
  }
  const sectionEnd = offset + 4 + sectionPayloadSize
  let o = offset + 7
  const records: BacklightZoneRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 4 > sectionEnd) throw new Error(`bz record ${i} past section end`)
    const nameLen = data[o]
    const nameEnd = o + 1 + nameLen
    if (nameEnd + 3 > sectionEnd)
      throw new Error(`bz record ${i} runs past section end`)
    const name = data.slice(o + 1, nameEnd).toString('ascii')
    records.push({
      name,
      fieldA: data[nameEnd],
      fieldB: data[nameEnd + 1],
      fieldC: data[nameEnd + 2]
    })
    o = nameEnd + 3
  }
  if (o !== sectionEnd) throw new Error(`backlight section size drift`)
  return { value: { sectionTag, records }, next: sectionEnd }
}

function parseGlobalConfigBlock (
  data: Buffer,
  offset: number
): { value: GlobalConfigBlock; next: number } {
  if (offset + 1 > data.length)
    throw new Error(`global config block past end at ${offset}`)
  const metadataTotalByteCount = data[offset]
  if (metadataTotalByteCount < 6) {
    throw new Error(
      `metadata_total_byte_count ${metadataTotalByteCount} at offset ${offset}: ` +
        `must be >= 6 (count byte + 5 length bytes)`
    )
  }
  const metadataEnd = offset + metadataTotalByteCount
  let o = offset + 1
  const metadataStrings: string[] = []
  for (let i = 0; i < 5; i++) {
    if (o + 1 > metadataEnd)
      throw new Error(`metadata string ${i} length past metadata header end`)
    const ln = data[o]
    if (o + 1 + ln > metadataEnd) {
      throw new Error(
        `metadata string ${i} body (len ${ln}) past metadata header end ${metadataEnd}`
      )
    }
    metadataStrings.push(data.slice(o + 1, o + 1 + ln).toString('ascii'))
    o += 1 + ln
  }
  if (o !== metadataEnd) {
    throw new Error(
      `metadata strings under-consume header: at ${o}, header ends at ${metadataEnd}`
    )
  }
  const end = metadataEnd + GLOBAL_CONFIG_FIXED_TAIL_SIZE
  if (end > data.length) {
    throw new Error(
      `global config block fixed tail past end: needs ${end} bytes, file has ${data.length}`
    )
  }
  const flagsByte = data[o]
  o += 1
  const subBlocks: Buffer[] = []
  for (let i = 0; i < GLOBAL_CONFIG_SUBBLOCK_COUNT; i++) {
    const block = data.slice(o, o + GLOBAL_CONFIG_SUBBLOCK_SIZE)
    if (block.length !== GLOBAL_CONFIG_SUBBLOCK_SIZE)
      throw new Error(`sub-block ${i} truncated`)
    if (block[0] !== GLOBAL_CONFIG_SUBBLOCK_MARKER) {
      throw new Error(
        `sub-block ${i}: expected marker 0x20, got 0x${block[0].toString(16)}`
      )
    }
    subBlocks.push(block)
    o += GLOBAL_CONFIG_SUBBLOCK_SIZE
  }
  return {
    value: { metadataTotalByteCount, metadataStrings, flagsByte, subBlocks },
    next: end
  }
}

function parseOutputsSubsection (
  data: Buffer,
  offset: number,
  sectionEnd: number
): { records: OutputRecord[]; next: number } {
  if (offset + 6 > sectionEnd)
    throw new Error(`outputs subsec header past section end`)
  const payloadSize = data.readUInt32LE(offset)
  const count = data.readUInt16LE(offset + 4)
  const subEnd = offset + 4 + payloadSize
  if (subEnd > sectionEnd)
    throw new Error(`outputs subsec ends past section end`)
  let o = offset + 6
  const records: OutputRecord[] = []
  for (let i = 0; i < count; i++) {
    if (o + 8 > subEnd) throw new Error(`output ${i} header past subsec`)
    const channelAddress = data.readUInt16LE(o)
    const flagsBytes = data.slice(o + 2, o + 7)
    const nameLen = data[o + 7]
    if (o + 8 + nameLen > subEnd)
      throw new Error(`output ${i} name past subsec`)
    const name = data.slice(o + 8, o + 8 + nameLen).toString('ascii')
    records.push({ channelAddress, flagsBytes, name })
    o += 8 + nameLen
  }
  if (o !== subEnd) throw new Error(`outputs subsec size drift`)
  return { records, next: subEnd }
}

function parseDisplayRefsSubsection (
  data: Buffer,
  offset: number,
  sectionEnd: number
): { records: DisplayRefRecord[]; next: number } {
  if (offset + 6 > sectionEnd)
    throw new Error(`drefs subsec header past section end`)
  const payloadSize = data.readUInt32LE(offset)
  const count = data.readUInt16LE(offset + 4)
  const subEnd = offset + 4 + payloadSize
  if (subEnd > sectionEnd) throw new Error(`drefs subsec ends past section end`)
  let o = offset + 6
  const records: DisplayRefRecord[] = []
  for (let i = 0; i < count; i++) {
    if (o + 4 > subEnd) throw new Error(`dref ${i} header past subsec`)
    const displayAddress = data.readUInt16LE(o)
    const flagsA = data[o + 2]
    const flagsB = data[o + 3]
    const transient = (flagsB & 0x04) !== 0
    const recSize = transient ? 14 : 5
    if (o + recSize > subEnd) throw new Error(`dref ${i} runs past subsec`)
    const extra = data.slice(o + 4, o + recSize)
    records.push({ displayAddress, flagsA, flagsB, transient, extra })
    o += recSize
  }
  if (o !== subEnd) throw new Error(`drefs subsec size drift`)
  return { records, next: subEnd }
}

function parseCircuitsSection (
  data: Buffer,
  offset: number
): { value: CircuitsSection; next: number } {
  if (offset + 10 > data.length)
    throw new Error(`circuits section header past end`)
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== CIRCUITS_SECTION_TAG)
    throw new Error(`expected circuits tag 0x08`)
  const formatHints = data.slice(offset + 7, offset + 10)
  if (!formatHints.equals(CIRCUITS_FORMAT_HINTS)) {
    throw new Error(
      `unexpected circuits format_hints ${formatHints.toString('hex')}`
    )
  }
  const sectionEnd = offset + 4 + sectionPayloadSize
  let o = offset + 10
  const records: CircuitRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 8 > sectionEnd)
      throw new Error(`circuit ${i} header past section end`)
    const circuitIndex = data.readUInt16LE(o)
    const flagsA = data[o + 2]
    const flagsB = data.readUInt16LE(o + 3)
    const field2a = data.readUInt16LE(o + 5)
    const nameLen = data[o + 7]
    if (o + 8 + nameLen > sectionEnd)
      throw new Error(`circuit ${i} name past section`)
    const name = data.slice(o + 8, o + 8 + nameLen).toString('utf8')
    let cur = o + 8 + nameLen
    const outputsRes = parseOutputsSubsection(data, cur, sectionEnd)
    cur = outputsRes.next
    const drefsRes = parseDisplayRefsSubsection(data, cur, sectionEnd)
    cur = drefsRes.next
    records.push({
      circuitIndex,
      flagsA,
      flagsB,
      field2a,
      name,
      outputs: outputsRes.records,
      displayRefs: drefsRes.records
    })
    o = cur
  }
  if (o !== sectionEnd) throw new Error(`circuits section size drift`)
  return { value: { sectionTag, formatHints, records }, next: sectionEnd }
}

function parseCircuitIdsSection (
  data: Buffer,
  offset: number
): { value: CircuitIdsSection; next: number } {
  if (offset + 7 > data.length) throw new Error(`circuit_ids header past end`)
  const sectionPayloadSize = data.readUInt32LE(offset)
  const recordCount = data.readUInt16LE(offset + 4)
  const sectionTag = data[offset + 6]
  if (sectionTag !== CIRCUIT_IDS_SECTION_TAG)
    throw new Error(`expected circuit_ids tag 0x12`)
  const sectionEnd = offset + 4 + sectionPayloadSize
  let o = offset + 7
  const records: CircuitIdRecord[] = []
  for (let i = 0; i < recordCount; i++) {
    if (o + 18 > sectionEnd)
      throw new Error(`circuit_ids ${i} header past section`)
    const channelAddress = data.readUInt16LE(o)
    const flags = data.slice(o + 2, o + 13)
    const circuitId = data.readUInt32LE(o + 13)
    const nameLen = data[o + 17]
    if (o + 18 + nameLen > sectionEnd)
      throw new Error(`circuit_ids ${i} name past section`)
    const name = data.slice(o + 18, o + 18 + nameLen).toString('utf8')
    records.push({ channelAddress, flags, circuitId, name })
    o += 18 + nameLen
  }
  if (o !== sectionEnd) throw new Error(`circuit_ids section size drift`)
  return { value: { sectionTag, records }, next: sectionEnd }
}

function parseTrailingSections (
  data: Buffer,
  offset: number,
  end: number
): TrailingSection[] {
  const sections: TrailingSection[] = []
  let o = offset
  while (o + 7 <= end) {
    const sectionPayloadSize = data.readUInt32LE(o)
    const recordCount = data.readUInt16LE(o + 4)
    const sectionTag = data[o + 6]
    const sectionEnd = o + 4 + sectionPayloadSize
    if (sectionEnd > end) {
      throw new Error(
        `trailing section at ${o} (tag 0x${sectionTag.toString(
          16
        )}) past trailing area end ${end}`
      )
    }
    sections.push({
      sectionPayloadSize,
      recordCount,
      sectionTag,
      payload: data.slice(o + 7, sectionEnd)
    })
    o = sectionEnd
  }
  if (o !== end)
    throw new Error(`trailing sections did not consume entire range`)
  return sections
}

export function parseZcfFull (data: Buffer): ParsedZcf {
  const header = parseHeader(data)
  let next = CONFIG_NAME_OFFSET
  const cn = parseConfigName(data, next)
  next = cn.next
  const mods = parseModulesSection(data, next)
  next = mods.next
  const bz = parseBacklightZonesSection(data, next)
  next = bz.next
  const gc = parseGlobalConfigBlock(data, next)
  next = gc.next
  const circ = parseCircuitsSection(data, next)
  next = circ.next
  const cids = parseCircuitIdsSection(data, next)
  next = cids.next
  const trailingEnd = data.length - 1 // last byte is trailing CRC8
  const trailing = parseTrailingSections(data, next, trailingEnd)
  return {
    header,
    body: {
      configName: cn.value,
      modules: mods.value,
      backlightZones: bz.value,
      globalConfig: gc.value,
      circuits: circ.value,
      circuitIds: cids.value,
      trailingSections: trailing
    }
  }
}

// --------------------------------- encoder --------------------------------

function encodeConfigName (cn: ConfigName): Buffer {
  const body = Buffer.from(cn.name, 'ascii')
  if (body.length !== cn.length)
    throw new Error(
      `config name length mismatch ${body.length} != ${cn.length}`
    )
  return Buffer.concat([Buffer.from([cn.length]), body])
}

function encodeModulesSection (s: ModulesSection): Buffer {
  const parts: Buffer[] = []
  for (const r of s.records) {
    const nameBytes = Buffer.from(r.name, 'ascii')
    const nameLen = nameBytes.length
    const b3 = (nameLen & 0x7f) | ((r.nameFlag & 1) << 7)
    parts.push(
      Buffer.from([
        r.dipswitch,
        r.moduleSpecificValue,
        r.moduleSpecificValue2,
        b3
      ])
    )
    parts.push(nameBytes)
    parts.push(Buffer.from([r.trailer]))
  }
  const body = Buffer.concat(parts)
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeBacklightZonesSection (s: BacklightZonesSection): Buffer {
  const parts: Buffer[] = []
  for (const r of s.records) {
    const nameBytes = Buffer.from(r.name, 'ascii')
    parts.push(Buffer.from([nameBytes.length]))
    parts.push(nameBytes)
    parts.push(Buffer.from([r.fieldA, r.fieldB, r.fieldC]))
  }
  const body = Buffer.concat(parts)
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeGlobalConfigBlock (g: GlobalConfigBlock): Buffer {
  if (g.metadataStrings.length !== 5) {
    throw new Error(
      `expected 5 metadata strings, got ${g.metadataStrings.length}`
    )
  }
  const parts: Buffer[] = []
  parts.push(Buffer.from([g.metadataTotalByteCount]))
  let metadataConsumed = 1
  for (const s of g.metadataStrings) {
    const sb = Buffer.from(s, 'ascii')
    parts.push(Buffer.from([sb.length]))
    parts.push(sb)
    metadataConsumed += 1 + sb.length
  }
  if (metadataConsumed !== g.metadataTotalByteCount) {
    throw new Error(
      `metadata strings encoded to ${metadataConsumed} bytes, ` +
        `metadataTotalByteCount says ${g.metadataTotalByteCount}`
    )
  }
  parts.push(Buffer.from([g.flagsByte]))
  for (const sb of g.subBlocks) {
    if (sb.length !== GLOBAL_CONFIG_SUBBLOCK_SIZE)
      throw new Error('sub-block wrong size')
    parts.push(sb)
  }
  const out = Buffer.concat(parts)
  const expected = g.metadataTotalByteCount + GLOBAL_CONFIG_FIXED_TAIL_SIZE
  if (out.length !== expected) {
    throw new Error(
      `global config block encoded to ${out.length}, expected ${expected}`
    )
  }
  return out
}

function encodeOutputsSubsection (outs: OutputRecord[]): Buffer {
  const body = Buffer.concat(
    outs.map(o => {
      const nameBytes = Buffer.from(o.name, 'ascii')
      if (o.flagsBytes.length !== 5)
        throw new Error('output flags must be 5 bytes')
      const head = Buffer.alloc(2)
      head.writeUInt16LE(o.channelAddress, 0)
      return Buffer.concat([
        head,
        o.flagsBytes,
        Buffer.from([nameBytes.length]),
        nameBytes
      ])
    })
  )
  const payloadSize = 2 + body.length
  const header = Buffer.alloc(6)
  header.writeUInt32LE(payloadSize, 0)
  header.writeUInt16LE(outs.length, 4)
  return Buffer.concat([header, body])
}

function encodeDisplayRefsSubsection (drefs: DisplayRefRecord[]): Buffer {
  const body = Buffer.concat(
    drefs.map(d => {
      const head = Buffer.alloc(4)
      head.writeUInt16LE(d.displayAddress, 0)
      head[2] = d.flagsA
      head[3] = d.flagsB
      const expectedExtra = d.transient ? 10 : 1
      if (d.extra.length !== expectedExtra) {
        throw new Error(
          `dref extra must be ${expectedExtra} bytes (got ${d.extra.length})`
        )
      }
      return Buffer.concat([head, d.extra])
    })
  )
  const payloadSize = 2 + body.length
  const header = Buffer.alloc(6)
  header.writeUInt32LE(payloadSize, 0)
  header.writeUInt16LE(drefs.length, 4)
  return Buffer.concat([header, body])
}

function encodeCircuitRecord (r: CircuitRecord): Buffer {
  const nameBytes = Buffer.from(r.name, 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt16LE(r.circuitIndex, 0)
  head[2] = r.flagsA
  head.writeUInt16LE(r.flagsB, 3)
  head.writeUInt16LE(r.field2a, 5)
  head[7] = nameBytes.length
  return Buffer.concat([
    head,
    nameBytes,
    encodeOutputsSubsection(r.outputs),
    encodeDisplayRefsSubsection(r.displayRefs)
  ])
}

function encodeCircuitsSection (s: CircuitsSection): Buffer {
  const body = Buffer.concat([
    s.formatHints,
    ...s.records.map(encodeCircuitRecord)
  ])
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeCircuitIdsSection (s: CircuitIdsSection): Buffer {
  const body = Buffer.concat(
    s.records.map(r => {
      const nameBytes = Buffer.from(r.name, 'utf8')
      if (r.flags.length !== 11)
        throw new Error('circuit_id flags must be 11 bytes')
      const head = Buffer.alloc(2)
      head.writeUInt16LE(r.channelAddress, 0)
      const cid = Buffer.alloc(4)
      cid.writeUInt32LE(r.circuitId, 0)
      return Buffer.concat([
        head,
        r.flags,
        cid,
        Buffer.from([nameBytes.length]),
        nameBytes
      ])
    })
  )
  const sectionPayloadSize = 3 + body.length
  const header = Buffer.alloc(7)
  header.writeUInt32LE(sectionPayloadSize, 0)
  header.writeUInt16LE(s.records.length, 4)
  header[6] = s.sectionTag
  return Buffer.concat([header, body])
}

function encodeTrailingSection (s: TrailingSection): Buffer {
  const head = Buffer.alloc(7)
  head.writeUInt32LE(s.sectionPayloadSize, 0)
  head.writeUInt16LE(s.recordCount, 4)
  head[6] = s.sectionTag
  return Buffer.concat([head, s.payload])
}

export function encodeZcf (parsed: ParsedZcf): Buffer {
  const { header, body } = parsed
  const bodyParts: Buffer[] = []
  // Body bytes 0..3 (file offsets 10..13) are the four "unknown" bytes
  // carried in the header struct.
  bodyParts.push(header.unknown_10_13)
  bodyParts.push(encodeConfigName(body.configName))
  bodyParts.push(encodeModulesSection(body.modules))
  bodyParts.push(encodeBacklightZonesSection(body.backlightZones))
  bodyParts.push(encodeGlobalConfigBlock(body.globalConfig))
  bodyParts.push(encodeCircuitsSection(body.circuits))
  bodyParts.push(encodeCircuitIdsSection(body.circuitIds))
  for (const ts of body.trailingSections)
    bodyParts.push(encodeTrailingSection(ts))
  const bodyBytes = Buffer.concat(bodyParts)

  // File layout (matches Python encoder):
  //   bytes 0..5  = version + body_size(4) + header_crc8 (placeholder)
  //   bytes 6..8  = body_crc32 low 20 bits (placeholder)
  //   byte 9      = reserved_byte9
  //   bytes 10..N = body_bytes
  //   last byte   = trailing CRC8 over bytes 6..end-1
  const fileNoTrailer = Buffer.alloc(10 + bodyBytes.length)
  fileNoTrailer[0] = header.version
  // body_size = file_size_no_trailer + 1 (trailing CRC) - 7
  const fileSizeNoTrailer = fileNoTrailer.length
  const fileSize = fileSizeNoTrailer + 1
  const bodySize = fileSize - 7
  fileNoTrailer.writeUInt32LE(bodySize, 1)
  // body_crc32 over bodyBytes (file bytes 10..end-1)
  const bodyCrc32 = crc32Lo20(bodyBytes)
  fileNoTrailer[6] = bodyCrc32 & 0xff
  fileNoTrailer[7] = (bodyCrc32 >> 8) & 0xff
  fileNoTrailer[8] = (bodyCrc32 >> 16) & 0x0f
  fileNoTrailer[9] = header.reservedByte9
  bodyBytes.copy(fileNoTrailer, 10)
  // header CRC8 over bytes 0..4
  fileNoTrailer[5] = crc8(fileNoTrailer.slice(0, 5))
  // trailing CRC8 over bytes 6..end-1 (of fileNoTrailer)
  const trailingCrc = crc8(fileNoTrailer.slice(6))
  return Buffer.concat([fileNoTrailer, Buffer.from([trailingCrc])])
}

// --------------------------------- generator ------------------------------

export interface ZcfGenSpec {
  configName: string // user-visible config label
  module: {
    dipswitch: number // 0..255
    name: string // module label as shown in CZone tool
    /**
     * Module-type code (the modules-section record's
     * `module_specific_value` byte). Selects how the Configuration
     * Tool labels the module's physical outputs:
     *   0x09 = COI / C6 module (outputs labelled C1..C6)
     *   0x0f = Output Interface (outputs labelled DC1..DC6)
     *   0x36 = CXP load module (13 outputs)
     * If omitted, inherits whatever the template's first module
     * record has (typically 0x0f = Output Interface).
     */
    typeCode?: number
  }
  /**
   * Switch Bank Instance, encoded into labelled_entities[0].field_b.
   * Drives the "Switch Bank PGN config -> Switch Bank Instance" value
   * the CZone Configuration Tool displays for this module. Defaults
   * to 0 if omitted.
   *
   * (Note: this is independent of the underlying canboatjs PGN 127501
   * Indicator-Bank-Instance value, which the plugin's runtime emits
   * separately based on the bank's `instance` setting.)
   */
  bankInstance?: number
  /**
   * Dipswitch the generated .zcf assigns to the Display Interface
   * (m1=0x10) module record — i.e. the dipswitch the plotter expects
   * to recognise as "itself" when it loads this .zcf. Must match the
   * real MFD's CZone-side dipswitch (look it up in the plotter's CZone
   * settings page) AND must differ from `module.dipswitch`.
   *
   * If omitted, the generator picks the lowest dipswitch not equal to
   * `module.dipswitch` — which works only by coincidence; the plotter
   * stays stuck in state 0 ("Starting configuration claim") whenever
   * the picked value doesn't match the real MFD's dipswitch. See
   * czone-spec/spec/czone-config-state-machine.md state-0 transition.
   */
  mfdDipswitch?: number
  circuits: Array<{
    name: string
    circuitId: number // user-set id (matches plugin's czoneFirstCircuitId+offset)
    /**
     * Sub-category bitmap encoded into the circuits-section record's
     * `flags_b` field (uint16 LE). Each bit drives one of the
     * Configuration Tool's "Circuit Menu Sub-Categories" checkboxes
     * (per czone-spec/spec/zcf-section-circuits.md). Use the
     * SUB_CATEGORY_BIT enum below to construct values.
     * If omitted, the template's `flags_b` is preserved.
     */
    subCategory?: number
  }>
}

/**
 * Module-type code (the modules-section record's `module_specific_value`
 * byte, called `m1` in the spec) -> number of physical outputs the
 * Configuration Tool expects. When fewer circuits are defined than
 * outputs declared, the tool synthesises "DC{n} - Paralleled with DC1"
 * placeholder rows for unused outputs. To suppress those, the
 * generator pads its circuit list up to the expected output count
 * with non-empty placeholder circuits.
 *
 * Values verified by importing generated files in the CZone
 * Configuration Tool and reading the Modules tree label:
 *   m1=0x0f (15) = "Output Interface". 6 outputs DC1..DC6.
 *                  Parts 80-911-0009-00 / -0010-00.
 *   m1=0x10 (16) = "Display Interface" / MFD / Chartplotter. No outputs.
 *   m1=0x1c (28) = "Control 1". 16 outputs DC1..DC16.
 *                  Part 80-911-0122-00.
 *   m1=0x1f (31) = "Combination Output Interface". 16 outputs DC1..DC16
 *                  (modern hardware has 4 x 25A high-current DC1..DC4 +
 *                  12 x 10A dimmable DC5..DC16, 150A max). Parts
 *                  80-911-0119-00 (modern) / 80-911-0120-00 (legacy).
 *
 * Additional codes documented in czone-spec/spec/zcf-section-modules.md
 * but not yet empirically verified by Windows import (0x09 / 0x36 / etc.)
 * are deliberately kept out of this runtime map.
 */
const MODULE_TYPE_OUTPUT_COUNT: { [key: number]: number } = {
  0x0f: 6, // Output Interface (DC1..DC6)
  0x1c: 16, // Control 1 (DC1..DC16)
  0x1f: 16 // Combination Output Interface (DC1..DC16)
}

// Module-type code for "Display Interface" — the MFD/chartplotter itself.
// The .zcf must declare exactly one such module (D6 in czone-spec/spec/
// zcf-validation.md), and its dipswitch must match the real plotter's
// CZone-side dipswitch — otherwise the plotter stays stuck in state 0
// ("Starting configuration claim") at cold-start.
const DISPLAY_INTERFACE_M1 = 0x10

/**
 * Sub-category bit positions for `ZcfGenSpec.circuits[].subCategory`.
 * The full 32-bit bitmap is held in tCircuitConfig in memory; only the
 * low 16 bits are stored in the wire-format `flags_b` field (the high
 * 16 bits, including the master Favourites/DC/AC checkboxes and the
 * five user-definable slots, live in a section we have not yet
 * decoded). All sixteen low-half bits are exposed here.
 */
export const SUB_CATEGORY_BIT = {
  HOUSE_HABITAT: 0x0001,
  VESSEL_CRITICAL: 0x0002,
  NAVIGATION: 0x0004,
  ELECTRONICS: 0x0008,
  TWENTY_FOUR_HOUR: 0x0010,
  COMMUNICATIONS: 0x0020,
  ACCESSORIES: 0x0040,
  INDICATORS_AND_ALARMS: 0x0080,
  ENGINE_MANAGEMENT: 0x0100,
  FANS_VENTILATION: 0x0200,
  LIGHTING: 0x0400,
  VESSEL_MANAGEMENT: 0x0800,
  PUMPS: 0x1000,
  PROPULSION_MANAGEMENT: 0x2000,
  POWER: 0x4000,
  REFRIGERATION: 0x8000
}

// Trailing-section index of the labelled_entities section (tag 0x05) per
// czone-spec/tools/zcf_sections.py LABELLED_ENTITIES_TRAILING_INDEX.
const LABELLED_ENTITIES_TRAILING_INDEX = 21
const LABELLED_ENTITIES_SECTION_TAG = 0x05

/**
 * Rewrite the first record of the labelled_entities section so that:
 *   - byte 0 (type) matches the user's dipswitch (the CZone Configuration
 *     Tool's Circuit Controls binds against this; mismatch = "Unknown
 *     Switch" in the UI)
 *   - byte 2 (field_b) carries the supplied bankInstance (drives the
 *     "Switch Bank Instance" value the tool displays in Switch Bank
 *     PGN config; verified against config-6.zcf where this byte = 5
 *     paired with name 'SW Bank 5')
 *   - the name becomes the supplied moduleName
 * field_a/c are preserved from the template. The section's outer
 * record_count and section_payload_size are recomputed.
 */
function clearLabelledEntities (trailing: TrailingSection[]): void {
  // Empty the labelled_entities section. Verified 2026-05-10 against
  // Scott's working Gannet-nosb_Scott_works.zcf, which has zero
  // labelled_entity records. Earlier generator versions wrote one
  // entry (type=module_dipswitch, b=bankInstance, c=0x01,
  // name=moduleName) on the speculation that this was needed to
  // populate the "Switch Bank Instance" UI in the CZone Configuration
  // Tool. That speculation isn't supported by working real-world files
  // — Gannet has the section empty and loads cleanly. The previous
  // generator's labelled-entity output was the most distinctive
  // structural difference between our hung-plotter file and Gannet's
  // working file (per the byte-diff in czone-spec commits 9dceaa9 /
  // 307ca08). Match Gannet — clear the section. If a future user
  // needs the Switch Bank Instance binding, restore via an explicit
  // opt-in flag once we understand its real role.
  if (trailing.length <= LABELLED_ENTITIES_TRAILING_INDEX) return
  const ts = trailing[LABELLED_ENTITIES_TRAILING_INDEX]
  if (ts.sectionTag !== LABELLED_ENTITIES_SECTION_TAG) return
  trailing[LABELLED_ENTITIES_TRAILING_INDEX] = {
    sectionPayloadSize: 3, // 4-byte size + 2-byte count + 1-byte tag = 7 bytes header,
    // but section_payload_size is "size starting after the size
    // field itself" = count(2) + tag(1) + payload(0) = 3
    recordCount: 0,
    sectionTag: ts.sectionTag,
    payload: Buffer.alloc(0)
  }
}

/**
 * Generate a .zcf from a small user-supplied spec, starting from a
 * known-good template (typically templates/template.zcf). The template's
 * header, global-config sub-blocks, backlight-zones, circuit/output
 * flag bytes and trailing-section payloads are preserved verbatim;
 * only the spec's labelled fields are mutated.
 *
 * The template MUST contain at least one module record and at least
 * one circuit (it serves as the structural prototype for those records).
 * The resulting bytes pass parseZcfFull(generate(...)) byte-for-byte
 * (locked in by test/zcf-encoder.test.mjs).
 */
export function generateZcf (spec: ZcfGenSpec, template: Buffer): Buffer {
  const parsed = parseZcfFull(template)

  if (parsed.body.modules.records.length < 1) {
    throw new Error('template must contain at least one module record')
  }
  if (parsed.body.circuits.records.length < 1) {
    throw new Error('template must contain at least one circuit record')
  }
  if (spec.circuits.length < 1) {
    throw new Error('spec must contain at least one circuit')
  }

  // Mutate config name.
  const cnBytes = Buffer.from(spec.configName, 'ascii')
  parsed.body.configName = { length: cnBytes.length, name: spec.configName }

  // Mutate the first module record to be the emulated module. KEEP any
  // additional modules from the template -- in particular the
  // "Display Interface" record (`module_specific_value` byte = 0x10),
  // which is what the Configuration Tool uses to populate the
  // "Display Interface" dropdown in Switch Bank PGN config and to
  // bind the per-circuit wildcard control "All Display Interfaces"
  // (verified against config-6.zcf, which has both a Signal-K-named
  // Output Interface module at m1=0x0f AND a Zeus-named Display
  // Interface module at m1=0x10; without the second module the
  // Configuration Tool's Module Configuration tree shows only
  // "Output Interface" and the "All Display Interfaces" Circuit
  // Control row is missing).
  const moduleProto = parsed.body.modules.records[0]
  const userDipswitch = spec.module.dipswitch & 0xff
  const mfdDipswitch =
    spec.mfdDipswitch !== undefined ? spec.mfdDipswitch & 0xff : undefined
  if (mfdDipswitch !== undefined && mfdDipswitch === userDipswitch) {
    throw new Error(
      `mfdDipswitch (${mfdDipswitch}) must differ from module.dipswitch (${userDipswitch})`
    )
  }
  // For each non-first template module: if it's the Display Interface
  // (m1=0x10) and the caller supplied an mfdDipswitch, use that exact
  // value (so the plotter recognises itself in the .zcf and can claim
  // authority during state-0 cold-start — see czone-spec/spec/czone-
  // config-state-machine.md). Otherwise, if the template's dipswitch
  // collides with the user's bank dipswitch, fall back to picking the
  // lowest unused value (legacy behaviour, works only by coincidence;
  // the Display Interface case is the one that matters in practice).
  const usedDipswitches = new Set<number>([userDipswitch])
  if (mfdDipswitch !== undefined) usedDipswitches.add(mfdDipswitch)
  const remainingModules = parsed.body.modules.records.slice(1).map(m => {
    if (
      mfdDipswitch !== undefined &&
      m.moduleSpecificValue === DISPLAY_INTERFACE_M1
    ) {
      return { ...m, dipswitch: mfdDipswitch }
    }
    if (m.dipswitch === userDipswitch || usedDipswitches.has(m.dipswitch)) {
      let alt = 1
      while (usedDipswitches.has(alt) && alt < 0xff) alt++
      usedDipswitches.add(alt)
      return { ...m, dipswitch: alt }
    }
    usedDipswitches.add(m.dipswitch)
    return m
  })
  parsed.body.modules.records = [
    {
      ...moduleProto,
      dipswitch: userDipswitch,
      name: spec.module.name,
      moduleSpecificValue:
        spec.module.typeCode ?? moduleProto.moduleSpecificValue
    },
    ...remainingModules
    // Sort modules by dipswitch ascending. Verified canonical 2026-05-10
    // against czone-spec/spec/zcf-section-modules.md ("Emission order:
    // dipswitch ascending"). Every real-world working .zcf has its
    // modules in dipswitch ascending order; the Windows tool roundtrip
    // re-orders them this way too. The library's Serialize iterates the
    // modules vector linearly, so the order originates upstream — most
    // likely from a sorted-insertion AddModule. Match the canonical
    // shape by sorting at emit time.
  ].sort((a, b) => a.dipswitch - b.dipswitch)

  // Pad the spec circuits up to the module type's output count so the
  // Configuration Tool doesn't synthesise "DC{n} - Paralleled with DC1"
  // placeholder rows for unused outputs. The padding circuits get
  // distinct circuit ids extending past the user's last id, names like
  // "Spare DC2"/"Spare DC3", and no sub-category. Users who want fewer
  // visible outputs should switch to a smaller module type, but we
  // don't know enough types yet to expose that choice.
  const effectiveTypeCode =
    spec.module.typeCode ?? moduleProto.moduleSpecificValue
  const expectedOutputs = MODULE_TYPE_OUTPUT_COUNT[effectiveTypeCode]
  let circuitsForGen = spec.circuits
  if (expectedOutputs !== undefined && spec.circuits.length < expectedOutputs) {
    const pad: ZcfGenSpec['circuits'] = []
    const lastId = spec.circuits[spec.circuits.length - 1].circuitId
    for (let i = spec.circuits.length; i < expectedOutputs; i++) {
      // The tool labels physical outputs DC1, DC2, ... DC{expectedOutputs}.
      // Our user-defined circuits map to DC1..DC{spec.circuits.length}; the
      // padding fills DC{spec.circuits.length + 1}..DC{expectedOutputs}.
      pad.push({
        name: `Spare DC${i + 1}`,
        circuitId: lastId + 1 + (i - spec.circuits.length)
      })
    }
    circuitsForGen = [...spec.circuits, ...pad]
  }

  // Build the circuit list by cloning the template's first circuit
  // record per spec entry. Each clone gets:
  //   - a unique circuit_index (starting at the template's value)
  //   - the spec's name
  //   - a unique output channel_address (spaced 1 apart, starting from
  //     the template's first output's channel_address)
  //   - a unique display_ref display_address (spaced 1 apart, starting
  //     from the template's first dref's display_address)
  // The matching circuit_ids record uses the same display_address as
  // its channel_address so the firmware links circuit -> circuit_id.
  //
  // **Critical:** both `output.channelAddress` and `dref.displayAddress`
  // (and the matching `circuit_id.channelAddress`) are dipswitch-namespaced:
  // their HIGH byte is the dipswitch of the module that owns the channel
  // (verified against Test.zcf: module dipswitch 0x01 owns outputs
  // 0x011e..0x0120 and drefs 0x0100..0x0102; config-6.zcf: module dipswitch
  // 0x02 owns outputs 0x021e..0x0222 and drefs 0x0200..0x0204). When we
  // change the module's dipswitch to whatever the user picked we MUST
  // rewrite the high byte of every channel address to match -- otherwise
  // the CZone Configuration Tool's GetChannelString() lookup fails and the
  // tool crashes with a NullReferenceException when the user clicks the
  // circuit (observed: bank-16 download with dipswitch=0x08 produced
  // outputs at 0x011e which the tool tried to resolve against dipswitch
  // 0x01, found no module, and crashed in UpdateLvCircuitOutputs).
  const circuitProto = parsed.body.circuits.records[0]
  const cidProto = parsed.body.circuitIds.records[0]
  const protoDrefAddr = circuitProto.displayRefs[0]?.displayAddress ?? 0x0100
  // Re-namespace the low byte of the template's display-ref range under the
  // user's chosen dipswitch. The display_refs and circuit_ids both reference
  // module-physical channel positions and need to be in the same namespace
  // as the module's dipswitch so the firmware's GetChannelString lookup
  // resolves cleanly. (We no longer emit a per-circuit physical-output
  // binding — see the wildcard-only output below — so we don't need the
  // matching `outBaseChan` for the outputs sub-section anymore.)
  const dipHi = (spec.module.dipswitch & 0xff) << 8
  const drefBaseAddr = (dipHi | (protoDrefAddr & 0xff)) & 0xffff
  const indexBase = circuitProto.circuitIndex

  // Leading wildcard output (`channel_address = 0x0000`) — the Configuration
  // Tool renders this as the "All Display Interfaces" Circuit Control,
  // which is what makes a circuit visible on every Display Interface
  // module on the bus rather than just the one it's wired to. Verified
  // against config-6.zcf: every circuit there carries a `chan=0x0000`
  // entry first, then the real physical-output `chan=(dipswitch<<8)|N`.
  // Compass Rose's Autopilot etc. likewise carries `chan=0x0000`.
  // Without this leading entry the side-bar control on Navico displays
  // doesn't bind (mister nui's note via Scott).
  const wildcardFlagsBytes =
    circuitProto.outputs.find(o => o.channelAddress === 0)?.flagsBytes ??
    Buffer.from('0101010000', 'hex')

  parsed.body.circuits.records = circuitsForGen.map((c, i) => ({
    circuitIndex: indexBase + i,
    flagsA: circuitProto.flagsA,
    // Sub-Category bitmap: when the spec carries a per-circuit
    // subCategory, that overrides the template's flags_b. The Configuration
    // Tool reads this to drive its "Circuit Menu Sub-Categories"
    // checkboxes.
    flagsB:
      typeof c.subCategory === 'number'
        ? c.subCategory & 0xffff
        : circuitProto.flagsB,
    field2a: circuitProto.field2a,
    name: c.name,
    // Wildcard "All Display Interfaces" entry only — no second
    // physical-output binding. Verified 2026-05-10 against Scott's
    // working Gannet-nosb_Scott_works.zcf, which has exactly one
    // output (the wildcard) per circuit. An earlier generator path
    // emitted a second output bound to (dipswitch<<8 | template_chan+i),
    // intended to provide a real physical-output binding alongside
    // the wildcard. That path produced channel addresses outside the
    // module's actual output range (e.g. channel 30..45 for a COI
    // module that only has DC1..DC16) — MFDApp appears to reject
    // such .zcf files silently, leaving the plotter stuck on
    // "Starting configuration claim" (eCZoneConfigState = 0). Falling
    // back to wildcard-only output matches Gannet and resolves the
    // hang on Scott's Zeus3S.
    outputs: [
      {
        channelAddress: 0x0000,
        flagsBytes: Buffer.from(wildcardFlagsBytes),
        name: ''
      }
    ],
    displayRefs: [
      {
        displayAddress: (drefBaseAddr + i) & 0xffff,
        flagsA: circuitProto.displayRefs[0].flagsA,
        flagsB: circuitProto.displayRefs[0].flagsB,
        transient: circuitProto.displayRefs[0].transient,
        extra: Buffer.from(circuitProto.displayRefs[0].extra)
      }
    ]
  }))

  // Per-circuit canonical-emission rules decoded from win_CZoneCore.dll's
  // tCZCD::Serialize (czone-spec/spec/zcf-section-circuit-ids.md):
  //
  //   - circuit_id LSB = 1 << chan_low for chan_low < 8, else 0.
  //     Empirical: every working .zcf assigns 1, 2, 4, 8, 16, 32, 64, 128
  //     to the first 8 circuits and 0 to circuits 9+. Sequential values
  //     like 13..28 (our prior generator output) diverge from canonical
  //     and probably trip plotter-side validation we haven't fully
  //     decoded.
  //
  //   - flags blob byte 6 (template inherits 0xe8) and byte 7 (template
  //     0x03) are cleared to 0x00 in the canonical emission. The
  //     non-zero values in the Windows tool's roundtrip-saved file
  //     correspond to user-set extended-attribute bits we don't model.
  //     Default-canonical = 0x00 in both bytes.
  //
  // The user-supplied `c.circuitId` from `spec.circuits[].circuitId` is
  // intentionally IGNORED here for the canonical bit-position scheme.
  // (It's still threaded through `spec.circuits[].circuitId` for the
  // bankFirstCircuitId-driven side-bar binding the runtime uses for
  // PGN 65280 routing — and that side keeps its own non-canonical
  // sequential mapping.)
  const cidFlagsCanonical = Buffer.from(cidProto.flags)
  cidFlagsCanonical[6] = 0x00
  cidFlagsCanonical[7] = 0x00
  parsed.body.circuitIds.records = circuitsForGen.map((c, i) => ({
    channelAddress: (drefBaseAddr + i) & 0xffff,
    flags: Buffer.from(cidFlagsCanonical),
    circuitId: i < 8 ? 1 << i : 0,
    name: c.name
  }))

  // Rewrite the labelled_entities record (trailing[21], tag 0x05) so its
  // first byte (`type`) matches the user's dipswitch. Without this the
  // CZone Configuration Tool's Circuit Controls panel binds against the
  // template's dipswitch (0x01 in Test.zcf) instead of ours and shows
  // "Unknown Switch" / "On/Off" with no name. Format per
  // czone-spec/spec/zcf-trailing-labelled-entities.md:
  //   byte 0:  type    (= module dipswitch in observed files)
  //   byte 1:  field_a
  //   byte 2:  field_b
  //   byte 3:  field_c
  //   byte 4:  name_length
  //   bytes 5..: name (UTF-8)
  clearLabelledEntities(parsed.body.trailingSections)

  return encodeZcf(parsed)
}
