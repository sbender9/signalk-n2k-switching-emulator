// Validate CZone packers against reference capture bytes.
// Run with: node test/czone.test.mjs
import assert from 'node:assert/strict'
import {
  circuitIdToSwitchIndex,
  CZONE_FIRST_CIRCUIT_ID,
  CZONE_SUPPORTED_SWITCHES,
  czoneFrame,
  isCircuitStateQuery,
  packAnnounce,
  packBinaryStatusReport,
  packCircuitBitmap,
  packStatusExtended,
  parseCircuitControl,
  parseDipswitch
} from '../dist/czone.js'

// Dipswitch parsing follows the plotter UI convention: leftmost character
// is dipswitch position 1 (bit 0). "00011000" thus sets bits 3 and 4 = 0x18.
assert.equal(parseDipswitch('00011000'), 0x18)
assert.equal(parseDipswitch('00010000'), 0x08, 'position 4 only -> bit 3')
assert.equal(parseDipswitch('10000000'), 0x01, 'position 1 only -> bit 0')
assert.equal(parseDipswitch('00000001'), 0x80, 'position 8 only -> bit 7')
assert.equal(parseDipswitch('11111111'), 0xff)
assert.equal(parseDipswitch(24), 24, 'integers pass through unchanged')
assert.equal(parseDipswitch(undefined), 0x18)
assert.equal(parseDipswitch('not-a-pattern'), 0x18)

// czoneFrame returns an Actisense-format string for emission via nmea2000out.
// Format: timestamp,prio,pgn,src,dst,len,bb,bb,...
const f = czoneFrame(65290, packAnnounce(0xdb13b, 0x18))
assert.equal(typeof f, 'string', 'frame is an Actisense string')
const parts = f.split(',')
assert.equal(parts[1], '6', 'priority = 6')
assert.equal(parts[2], '65290', 'pgn')
assert.equal(parts[4], '255', 'broadcast dst')
assert.equal(parts[5], '8', 'length = 2 header + 6 payload')
const hex = parts.slice(6).join('').toLowerCase()
// Header (mfg=295, industry=4) + reference payload from working capture
assert.equal(
  hex,
  '2799' + '3bb10d000018',
  'header + PGN 65290 announce payload'
)

// PGN 65284 circuit bitmap: dipswitch + 0x0F type + bitmap
const bm = packCircuitBitmap(0x18, [true, false, true, false, false, false])
assert.equal(bm[0], 0x18, 'byte[0] = dipswitch')
assert.equal(bm[1], 0x0f, 'byte[1] = circuit state type')
assert.equal(bm[2], 0b00000101, 'switches 1 and 3 set in bitmap')

// PGN 127501 standard binary status: instance + 2-bit packed states
const bs = packBinaryStatusReport(0x17, [true, false, false, false, false, false])
assert.equal(bs[0], 0x17, 'byte[0] = instance')
assert.equal(bs[1] & 0x03, 0x01, 'switch 1 on')

const bs3 = packBinaryStatusReport(0x17, [false, false, true, false, false, false])
assert.equal((bs3[1] >> 4) & 0x03, 0x01, 'switch 3 on at bits 4-5')

// Inbound: PGN 65280 control parsing
const onCmd = Buffer.from([0x27, 0x99, 0x0d, 0, 0, 0, 0xf1, 0])
const parsed = parseCircuitControl(onCmd)
assert.deepEqual(parsed, { circuitId: 0x0d, on: true })

const offCmd = Buffer.from([0x27, 0x99, 0x0e, 0, 0, 0, 0xf2, 0])
assert.deepEqual(parseCircuitControl(offCmd), { circuitId: 0x0e, on: false })

// Wrong header rejected
const wrongHeader = Buffer.from([0x99, 0x27, 0x0d, 0, 0, 0, 0xf1, 0])
assert.equal(parseCircuitControl(wrongHeader), undefined)

// Unknown command code rejected
const unknownCmd = Buffer.from([0x27, 0x99, 0x0d, 0, 0, 0, 0xaa, 0])
assert.equal(parseCircuitControl(unknownCmd), undefined)

// circuit id mapping is relative to the bank's configured firstCircuitId
assert.equal(circuitIdToSwitchIndex(13, 13, 6), 0, 'YDAB default base')
assert.equal(circuitIdToSwitchIndex(18, 13, 6), 5, 'YDAB last circuit')
assert.equal(circuitIdToSwitchIndex(19, 13, 6), -1, 'past last circuit')
assert.equal(circuitIdToSwitchIndex(7, 7, 6), 0, 'custom base 7 -> switch 1')
assert.equal(circuitIdToSwitchIndex(12, 7, 6), 5, 'custom base 7 -> switch 6')
assert.equal(circuitIdToSwitchIndex(0, 7, 6), -1, 'below custom base')

// PGN 65284 query detection
assert.equal(isCircuitStateQuery(Buffer.from([0x27, 0x99, 0xc8, 0x10])), true)
assert.equal(isCircuitStateQuery(Buffer.from([0x27, 0x99, 0xc8, 0x11])), false)
assert.equal(isCircuitStateQuery(Buffer.from([0x27, 0x99, 0xc7, 0x10])), false)

// PGN 130817: header is added by czoneFrame; packStatusExtended returns the body.
// Per czone-spec/spec/pgn-130817.md, byte 0 of each per-circuit record is the
// circuit_id (NOT the on/off state). The on/off state is conveyed via PGN
// 65284's bitmap, not via PGN 130817. circuit_id follows the canonical
// bit-position rule from czone-spec/spec/zcf-section-circuit-ids.md "Rule 1":
// 1<<i for i<8, else 0.
const body = packStatusExtended(0x18, [true, false, true, false, false, false])
assert.equal(body[0], 0x01, 'state page')
assert.equal(body[1], 0x18, 'dipswitch')
// Circuit 0 (i=0): circuit_id = 1<<0 = 1
assert.equal(body[2], 0x01, 'circuit 0 id = 1')
assert.equal(body[3], 0x00, 'circuit 0 value_low = 0')
assert.equal(body[4], 0x04, 'circuit 0 value_high_and_sign = positive sign, value=0')
// Circuit 1 (i=1): circuit_id = 1<<1 = 2
assert.equal(body[5], 0x02, 'circuit 1 id = 2')
// Circuit 2 (i=2): circuit_id = 1<<2 = 4
assert.equal(body[8], 0x04, 'circuit 2 id = 4')

console.log('czone packer smoke test: PASS')
