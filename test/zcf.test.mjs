// Validate the live .zcf reassembler and parser against the reference
// capture (czone-config.txt) and the known-good config-6.zcf.
//
// Run: node test/zcf.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ZcfReassembler } from '../dist/zcfReassembler.js'
import { parseZcf } from '../dist/zcfParser.js'

const captureDir = '/home/dirk/dev/czone'
const captureFile = path.join(captureDir, 'czone-config.txt')
const zcfFile = path.join(captureDir, 'config-6.zcf')

if (!fs.existsSync(captureFile) || !fs.existsSync(zcfFile)) {
  console.log(`zcf reassembly test: SKIP (capture or zcf not present)`)
  process.exit(0)
}

// --- Reassemble fast-packet PGN 130816 frames from the candump capture ---

const lines = fs.readFileSync(captureFile, 'utf8').split('\n')

// CAN ID -> PGN (PDU2 broadcast: PF >= 240 -> PGN = (DP<<16) | (PF<<8) | PS)
function decodeCanId (idHex) {
  const id = parseInt(idHex, 16)
  const src = id & 0xff
  const ps = (id >> 8) & 0xff
  const pf = (id >> 16) & 0xff
  const dp = (id >> 24) & 0x1
  const pgn = pf >= 240 ? (dp << 16) | (pf << 8) | ps : (dp << 16) | (pf << 8)
  return { src, pgn }
}

// Walk frames, track fast-packet sequences per (src, pgn)
const sequences = new Map() // key: `${src}:${seq}` -> { totalLen, payload, idx }
const reassembled = []

for (const line of lines) {
  const m = line.match(/\([\d.]+\) \S+ ([0-9A-F]+)#([0-9A-F]+)/)
  if (!m) continue
  const idHex = m[1]
  if (idHex.length !== 8) continue
  const { src, pgn } = decodeCanId(idHex)
  if (pgn !== 130816) continue
  const data = Buffer.from(m[2], 'hex')
  const seq = data[0] >> 5
  const idx = data[0] & 0x1f
  const key = `${src}:${seq}`
  if (idx === 0) {
    sequences.set(key, {
      src,
      totalLen: data[1],
      payload: Buffer.from(data.slice(2, 8))
    })
  } else {
    const cur = sequences.get(key)
    if (!cur) continue
    cur.payload = Buffer.concat([cur.payload, data.slice(1, 8)])
    if (cur.payload.length >= cur.totalLen) {
      const finalPayload = cur.payload.slice(0, cur.totalLen)
      reassembled.push({ src: cur.src, payload: finalPayload })
      sequences.delete(key)
    }
  }
}

console.log(
  `parsed ${reassembled.length} fast-packet 130816 sequences from capture`
)

// --- Feed those into ZcfReassembler and capture the completed .zcf ---

const completions = []
const reassembler = new ZcfReassembler((src, zcf) => {
  completions.push({ src, zcf })
})

for (const { src, payload } of reassembled) {
  reassembler.ingest(src, payload)
}

assert.ok(
  completions.length >= 1,
  `expected at least one completed .zcf (got ${completions.length})`
)

const expected = fs.readFileSync(zcfFile)
const got = completions[completions.length - 1].zcf

assert.equal(got.length, expected.length, 'reassembled .zcf length matches')
assert.equal(
  got.compare(expected),
  0,
  'reassembled .zcf bytes match config-6.zcf exactly'
)
console.log(`reassembled ${got.length} bytes, byte-perfect match: OK`)

// --- Parse the assembled .zcf and verify circuit extraction ---

const summary = parseZcf(got)
console.log(`parser found ${summary.circuits.length} circuits`)
for (const c of summary.circuits) {
  console.log(`  circuit ${c.circuitId}  ${c.name}`)
}

// config-6.zcf is Scott's setup. Check that we get a sensible result.
assert.ok(summary.circuits.length > 0, 'parser found at least one circuit')

console.log('\nzcf reassembly + parse test: PASS')
