/*
 * Heuristic .zcf parser. Extracts circuit (id, name) pairs from a CZone
 * configuration file. The .zcf format is proprietary; this scanner locates
 * circuit records by finding length-prefixed ASCII names rather than
 * implementing the full record schema. It works on files produced by the
 * CZone Configuration Tool for typical small switching configurations.
 *
 * The same scanner powers the bundled `tools/zcf-info.mjs` CLI and the
 * runtime PGN 130816 reassembler in the plugin.
 */

export interface ZcfString {
  offset: number
  length: number
  text: string
}

export interface ZcfCircuit {
  name: string
  circuitId: number
}

export interface ZcfSummary {
  versionByte: number
  strings: ZcfString[]
  circuits: ZcfCircuit[]
  firstCircuitId: number | undefined
  contiguous: boolean
}

/**
 * Find length-prefixed printable-ASCII runs in a buffer. Each run is
 * preceded by a single byte equal to its length and is at least 3 chars.
 */
export function findLengthPrefixedStrings (buf: Buffer): ZcfString[] {
  const out: ZcfString[] = []
  for (let i = 1; i < buf.length; i++) {
    const len = buf[i - 1]
    if (len < 3 || len > 64) continue
    if (i + len > buf.length) continue
    let printable = true
    for (let j = i; j < i + len; j++) {
      const b = buf[j]
      if (b < 32 || b > 126) {
        printable = false
        break
      }
    }
    if (!printable) continue
    out.push({
      offset: i - 1,
      length: len,
      text: buf.slice(i, i + len).toString('ascii')
    })
  }
  return out
}

/**
 * Parse a .zcf buffer and return its circuit list plus a contiguity hint
 * suitable for `czoneFirstCircuitId`.
 */
export function parseZcf (buf: Buffer): ZcfSummary {
  const versionByte = buf.length > 0 ? buf[0] : 0
  const strings = findLengthPrefixedStrings(buf)

  // Circuits are the names that appear twice (once in outputChannels,
  // once in circuits). Single-occurrence names are config names, module
  // names, switch-bank labels, and the like.
  const counts: { [name: string]: number } = {}
  for (const s of strings) {
    counts[s.text] = (counts[s.text] || 0) + 1
  }
  const repeatedNames: string[] = []
  for (const name in counts) {
    if (counts[name] >= 2) repeatedNames.push(name)
  }

  const circuits: ZcfCircuit[] = []
  for (const name of repeatedNames) {
    const occurrences = strings.filter(s => s.text === name)
    if (occurrences.length < 2) continue
    // The second occurrence (in the circuits section) carries a 32-bit LE
    // circuit id immediately before its length prefix.
    const circuit = occurrences[1]
    if (circuit.offset < 4) continue
    const circuitId = buf.readUInt32LE(circuit.offset - 4)
    circuits.push({ name, circuitId })
  }

  circuits.sort((a, b) => a.circuitId - b.circuitId)

  let contiguous = false
  let firstCircuitId: number | undefined
  if (circuits.length > 0) {
    firstCircuitId = circuits[0].circuitId
    const last = circuits[circuits.length - 1].circuitId
    contiguous = last - firstCircuitId === circuits.length - 1
  }

  return { versionByte, strings, circuits, firstCircuitId, contiguous }
}
