/*
 * Reassemble a CZone .zcf file from PGN 130816 traffic on the bus.
 *
 * Wire layout per CZone module firmware (PackBEP130816PGN):
 *
 *   byte[0..1]   = 0x27 0x99      CZone manufacturer/industry header
 *   byte[2..3]   = chunk_idx       uint16 LE
 *   byte[4]      = flag            observed = 0x01
 *   byte[5..22]  = reserved        18 zero/filler bytes
 *   byte[23..]   = up to 200 bytes of .zcf body
 *
 * Each chunk carries 200 bytes of .zcf data. The .zcf reassembles by
 * concatenating chunks in chunk_idx order; the final chunk is short
 * (< 200 bytes) and ends the transfer. Multiple plotters may broadcast
 * the same .zcf simultaneously; we keep one buffer per source address.
 */

const CZONE_HEADER_LO = 0x27
const CZONE_HEADER_HI = 0x99
const ZCF_HEADER_LEN = 23
const ZCF_MAX_CHUNK_DATA = 200

interface PendingTransfer {
  chunks: Map<number, Buffer>
  lastChunkSeen: number
  lastUpdatedAt: number
}

export class ZcfReassembler {
  private readonly bySrc = new Map<number, PendingTransfer>()
  private readonly onComplete: (src: number, zcf: Buffer) => void

  constructor (onComplete: (src: number, zcf: Buffer) => void) {
    this.onComplete = onComplete
  }

  /**
   * Feed a single PGN 130816 frame (the full reassembled fast-packet
   * payload, not the individual 8-byte CAN frames). Returns true if the
   * frame was a CZone 130816 chunk; false otherwise.
   */
  ingest (src: number, payload: Buffer): boolean {
    if (payload.length < ZCF_HEADER_LEN) return false
    if (payload[0] !== CZONE_HEADER_LO || payload[1] !== CZONE_HEADER_HI) {
      return false
    }
    const chunkIdx = payload.readUInt16LE(2)
    const data = payload.slice(ZCF_HEADER_LEN)

    let pending = this.bySrc.get(src)
    if (!pending || (chunkIdx === 0 && pending.lastChunkSeen > 0)) {
      // Fresh transfer. Either the first time we've seen this src, or
      // a new transfer started (chunk 0 again after we'd accumulated some).
      pending = {
        chunks: new Map<number, Buffer>(),
        lastChunkSeen: -1,
        lastUpdatedAt: Date.now()
      }
      this.bySrc.set(src, pending)
    }

    pending.chunks.set(chunkIdx, data)
    pending.lastChunkSeen = chunkIdx
    pending.lastUpdatedAt = Date.now()

    // The final chunk is the only one shorter than ZCF_MAX_CHUNK_DATA. When
    // we see one, check whether we have a contiguous run starting from 0.
    if (data.length < ZCF_MAX_CHUNK_DATA) {
      const assembled = this.tryAssemble(pending, chunkIdx)
      if (assembled !== undefined) {
        this.bySrc.delete(src)
        this.onComplete(src, assembled)
      }
    }
    return true
  }

  private tryAssemble (
    pending: PendingTransfer,
    finalChunkIdx: number
  ): Buffer | undefined {
    for (let i = 0; i <= finalChunkIdx; i++) {
      if (!pending.chunks.has(i)) return undefined
    }
    const parts: Buffer[] = []
    for (let i = 0; i <= finalChunkIdx; i++) {
      parts.push(pending.chunks.get(i)!)
    }
    return Buffer.concat(parts)
  }
}
