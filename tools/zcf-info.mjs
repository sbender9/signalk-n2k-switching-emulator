#!/usr/bin/env node
// zcf-info.mjs — extract circuit info from a CZone .zcf file.
//
// Usage:
//   node tools/zcf-info.mjs path/to/your.zcf [--strings] [--dipswitch=N]
//
// By default uses the full structural parser to print the modules, the
// circuits sliced by dipswitch, the circuit_ids table, and the labelled
// entities. Falls back to the heuristic scanner if the structural
// parser fails (e.g. on a .zcf format version we haven't seen).
//
// --strings        also dumps every length-prefixed string in the file
// --dipswitch=N    only print the slice owned by module dipswitch N
//                  (decimal or 0x.. hex). Useful when more than one
//                  module is present.

import fs from 'node:fs'
import path from 'node:path'

import { parseZcfFull } from '../dist/zcfEncoder.js'
import { parseZcf } from '../dist/zcfParser.js'

const args = process.argv.slice(2)
const showStrings = args.includes('--strings')
const dipswitchArg = args.find((a) => a.startsWith('--dipswitch='))
const filterDipswitch = dipswitchArg
  ? Number(dipswitchArg.split('=')[1])
  : undefined
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('Usage: node tools/zcf-info.mjs path/to/your.zcf [--strings] [--dipswitch=N]')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`)
  process.exit(1)
}

const data = fs.readFileSync(file)

console.log(`zcf:    ${path.resolve(file)}`)
console.log(`size:   ${data.length} bytes`)
console.log()

// flags_b -> sub-category name. All 16 low-half bits documented from
// the Configuration Tool's m_CheckBoxes array (verified against
// real .zcf samples). The high 16 bits of the 32-bit display-categories
// bitmap (Favourites/DC/AC/UserCategories/Entertainment/etc.) live in
// a section we haven't decoded yet, so they don't appear in flags_b.
const SUB_CATS = [
  [0x0001, 'House/Habitat'],
  [0x0002, 'Vessel Critical'],
  [0x0004, 'Navigation'],
  [0x0008, 'Electronics'],
  [0x0010, '24-Hour'],
  [0x0020, 'Communications'],
  [0x0040, 'Accessories'],
  [0x0080, 'Indicators and Alarms'],
  [0x0100, 'Engine Management'],
  [0x0200, 'Fans/Ventilation'],
  [0x0400, 'Lighting'],
  [0x0800, 'Vessel Management'],
  [0x1000, 'Pumps'],
  [0x2000, 'Propulsion Management'],
  [0x4000, 'Power'],
  [0x8000, 'Refrigeration']
]
function describeSubCategories (flagsB) {
  if (!flagsB) return '(none)'
  const matched = SUB_CATS.filter(([bit]) => (flagsB & bit) !== 0).map(([, n]) => n)
  const knownMask = SUB_CATS.reduce((m, [b]) => m | b, 0)
  const unknown = flagsB & ~knownMask
  if (unknown) matched.push(`0x${unknown.toString(16).padStart(4, '0')} (unknown bits)`)
  return matched.join(', ') || '(none)'
}

let parsed
try {
  parsed = parseZcfFull(data)
} catch (e) {
  console.log(`structural parser failed: ${e.message}`)
  console.log('falling back to heuristic scanner ...')
  console.log()
  printHeuristic()
  process.exit(0)
}

console.log(`format version byte: 0x${parsed.header.version.toString(16).padStart(2, '0')}`)
console.log(`config name:         ${JSON.stringify(parsed.body.configName.name)}`)
console.log()

console.log(`modules (${parsed.body.modules.records.length}):`)
for (const m of parsed.body.modules.records) {
  console.log(
    `  dipswitch=0x${m.dipswitch.toString(16).padStart(2, '0')}  ${JSON.stringify(m.name)}`
  )
}
console.log()

// Group circuits by the dipswitch their first output addresses.
const circuitsByDip = new Map()
for (const c of parsed.body.circuits.records) {
  const dip = c.outputs[0]?.channelAddress != null
    ? (c.outputs[0].channelAddress >> 8) & 0xff
    : -1
  if (!circuitsByDip.has(dip)) circuitsByDip.set(dip, [])
  circuitsByDip.get(dip).push(c)
}

const cidByChan = new Map()
for (const r of parsed.body.circuitIds.records) {
  cidByChan.set(r.channelAddress, r)
}

console.log(`circuits sliced by dipswitch:`)
for (const dip of [...circuitsByDip.keys()].sort((a, b) => a - b)) {
  if (filterDipswitch !== undefined && dip !== filterDipswitch) continue
  const list = circuitsByDip.get(dip)
  const moduleName = parsed.body.modules.records.find(m => m.dipswitch === dip)?.name ?? '(no module)'
  const dipStr = dip < 0 ? '(invalid)' : `0x${dip.toString(16).padStart(2, '0')}`
  console.log(`  dipswitch=${dipStr}  module=${JSON.stringify(moduleName)}  circuits=${list.length}`)
  for (const c of list) {
    const drefAddr = c.displayRefs[0]?.displayAddress
    const cid = drefAddr != null ? cidByChan.get(drefAddr) : undefined
    const cidStr = cid ? `cid=${cid.circuitId}` : 'cid=(no matching circuit_id)'
    console.log(
      `    [idx=${c.circuitIndex}] ${cidStr}  flags_a=0x${c.flagsA.toString(16).padStart(2, '0')}  flags_b=0x${c.flagsB.toString(16).padStart(4, '0')} (${describeSubCategories(c.flagsB)})  ${JSON.stringify(c.name)}`
    )
  }
}
console.log()

if (filterDipswitch === undefined) {
  console.log(`circuit_ids table (${parsed.body.circuitIds.records.length}):`)
  for (const r of parsed.body.circuitIds.records) {
    const dip = (r.channelAddress >> 8) & 0xff
    const cidStr = r.circuitId === 0 ? '(unset)' : `0x${r.circuitId.toString(16).padStart(8, '0')}`
    console.log(
      `  cid=${cidStr.padStart(10)}  chan=0x${r.channelAddress.toString(16).padStart(4, '0')} (dip=0x${dip.toString(16).padStart(2, '0')})  ${JSON.stringify(r.name)}`
    )
  }
  console.log()

  // Configuration suggestions: if every dipswitch has a contiguous
  // circuit_id run, suggest the plugin's czoneFirstCircuitId per dipswitch.
  console.log('plugin config suggestions per dipswitch:')
  for (const dip of [...circuitsByDip.keys()].sort((a, b) => a - b)) {
    if (dip < 0) continue
    const list = circuitsByDip.get(dip)
    const cids = []
    for (const c of list) {
      const drefAddr = c.displayRefs[0]?.displayAddress
      const cid = drefAddr != null ? cidByChan.get(drefAddr)?.circuitId : undefined
      if (cid !== undefined && cid !== 0) cids.push(cid & 0xffff)
    }
    cids.sort((a, b) => a - b)
    if (cids.length === 0) {
      console.log(`  dip=0x${dip.toString(16).padStart(2, '0')}: no controllable circuits`)
      continue
    }
    const contiguous = cids[cids.length - 1] - cids[0] === cids.length - 1
    const dipBin = dip.toString(2).padStart(8, '0').split('').reverse().join('')
    if (contiguous) {
      console.log(`  dip=0x${dip.toString(16).padStart(2, '0')} (czoneDipswitch="${dipBin}") czoneFirstCircuitId=${cids[0]} (${cids.length} circuits, contiguous)`)
    } else {
      console.log(`  dip=0x${dip.toString(16).padStart(2, '0')} (czoneDipswitch="${dipBin}") circuits ${cids.join(',')} (NON-contiguous)`)
    }
  }
  console.log()
}

// Config notes (trailing[32], tag 0x02) — free-text installer/owner notes.
// Layout: uint16 LE length-prefix followed by the UTF-8 note bytes.
const CONFIG_NOTES_TRAILING_INDEX = 32
const CONFIG_NOTES_SECTION_TAG = 0x02
const cn = parsed.body.trailingSections[CONFIG_NOTES_TRAILING_INDEX]
if (cn && cn.sectionTag === CONFIG_NOTES_SECTION_TAG && cn.payload.length >= 2) {
  const noteLen = cn.payload.readUInt16LE(0)
  if (noteLen > 0 && cn.payload.length >= 2 + noteLen) {
    const note = cn.payload.slice(2, 2 + noteLen).toString('utf8')
    console.log('config notes:')
    console.log('  ' + note.split(/\r?\n/).join('\n  '))
    console.log()
  }
}

if (showStrings) {
  // Use the heuristic scanner for string dump only.
  const heur = parseZcf(data)
  console.log('strings found in file (offset, length, text):')
  for (const s of heur.strings) {
    console.log(
      `  0x${s.offset.toString(16).padStart(4, '0')}  len=${String(s.length).padStart(2)}  ${s.text}`
    )
  }
  console.log()
}

function printHeuristic () {
  const summary = parseZcf(data)
  console.log(`format version byte: 0x${summary.versionByte.toString(16).padStart(2, '0')}`)
  console.log()
  if (summary.circuits.length === 0) {
    console.log('No circuits found by the heuristic scanner.')
    return
  }
  console.log('circuit_id  name')
  for (const c of summary.circuits) {
    console.log(`  ${String(c.circuitId).padStart(8)}  ${c.name}`)
  }
  console.log()
  console.log(`first circuit id: ${summary.firstCircuitId}`)
  if (summary.contiguous) {
    console.log(`circuit ids contiguous — czoneFirstCircuitId: ${summary.firstCircuitId}`)
  } else {
    console.log('circuit ids are NOT contiguous; configure the plugin manually.')
  }
}
