/*
 * Copyright 2021 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PGN_60928,
  PGN_126996,
  PGN_127502,
  PGN_127501,
  PGN_130060,
  PGN_126208_NmeaAcknowledgeGroupFunction,
  ManufacturerCode,
  DeviceFunction,
  DeviceClass,
  YesNo,
  IndustryCode,
  GroupFunction,
  PgnErrorCode,
  mapCamelCaseKeys
} from '@canboat/ts-pgns'
import { toPgn } from '@canboat/canboatjs'
import { satisfies } from 'semver'
import * as fs from 'fs'
import * as path from 'path'
import {
  chunkZcf,
  circuitIdToSwitchIndex,
  CZONE_PGN_ANNOUNCE,
  CZONE_PGN_CIRCUIT_BITMAP,
  CZONE_PGN_CIRCUIT_CONTROL,
  CZONE_PGN_LABEL_QUERY,
  CZONE_PGN_LABEL_REPLY,
  CZONE_PGN_STATUS_EXTENDED,
  czoneFrame,
  deriveUniqueSerial,
  isCircuitStateQuery,
  packAnnounce,
  packBinaryStatusReport,
  packCircuitBitmap,
  packLabelReply,
  packStatusExtended,
  parseCircuitControl,
  parseDipswitch,
  parseLabelQuery
} from './czone'
import { ZcfReassembler } from './zcfReassembler'
import { parseZcf } from './zcfParser'
import { generateZcf, ZcfGenSpec, SUB_CATEGORY_BIT } from './zcfEncoder'

/**
 * Map a UI-friendly sub-category name (or "none") to the bitmap value
 * the .zcf circuits-section flags_b expects. All 16 low-half bits
 * exposed (verified via czone-spec/spec/zcf-section-circuits.md
 * cross-referenced with real .zcf samples).
 */
const SUB_CATEGORY_NAME_TO_BIT: { [key: string]: number } = {
  none: 0,
  'house-habitat': SUB_CATEGORY_BIT.HOUSE_HABITAT,
  'vessel-critical': SUB_CATEGORY_BIT.VESSEL_CRITICAL,
  navigation: SUB_CATEGORY_BIT.NAVIGATION,
  electronics: SUB_CATEGORY_BIT.ELECTRONICS,
  '24-hour': SUB_CATEGORY_BIT.TWENTY_FOUR_HOUR,
  communications: SUB_CATEGORY_BIT.COMMUNICATIONS,
  accessories: SUB_CATEGORY_BIT.ACCESSORIES,
  'indicators-alarms': SUB_CATEGORY_BIT.INDICATORS_AND_ALARMS,
  'engine-management': SUB_CATEGORY_BIT.ENGINE_MANAGEMENT,
  'fans-ventilation': SUB_CATEGORY_BIT.FANS_VENTILATION,
  lighting: SUB_CATEGORY_BIT.LIGHTING,
  'vessel-management': SUB_CATEGORY_BIT.VESSEL_MANAGEMENT,
  pumps: SUB_CATEGORY_BIT.PUMPS,
  'propulsion-management': SUB_CATEGORY_BIT.PROPULSION_MANAGEMENT,
  power: SUB_CATEGORY_BIT.POWER,
  refrigeration: SUB_CATEGORY_BIT.REFRIGERATION
}

const CZONE_HEARTBEAT_MS = 2000
// Re-broadcast PGN 65290 every 2 s, matching the heartbeat cadence. The
// plotter's transmit-side state machine clears its per-chunk acknowledged-
// receiver bitmap each chunk window (~3 s, per czone-spec/spec/zcf-transmit-
// protocol.md), and one of PGN 65290 / 65284 is what sets the bit again. By
// keeping the announce inside the chunk window the plugin is robust against
// either PGN being the actual gate without disassembling it further.
const CZONE_ANNOUNCE_MS = 2000
const CZONE_PGN_ZCF_TRANSFER = 130816
// Delay between attaching the device emulator and auto-pushing the .zcf.
// Gives the plotter time to discover the plugin (PGN 65290 + heartbeat)
// before the chunks arrive. 10 s is generous; a real plotter completes
// CZone discovery in ~3-5 s once announces start flowing.
const CZONE_AUTO_PUSH_DELAY_MS = 10000
// SignalK PUT path that triggers a .zcf push when czoneZcfPushEnabled is true.
// The PUT value carries the .zcf as a base64 string.
const CZONE_ZCF_PUSH_PATH = 'electrical.czone.pushZcf'

export default function (app: any) {
  const error =
    app.error?.bind(app) ?? ((...args: any[]) => console.error(...args))
  const debug = app.debug?.bind(app) ?? ((..._args: any[]) => {})
  let props: any
  let onStop: any = []
  let switchBanks: any = {}

  const needsCamelMapping = !satisfies(app.config.version, '>=2.15.0')

  const plugin: Plugin = {
    start: function (properties: any) {
      props = properties

      if (!props?.banks || !props.banks.length) {
        return
      }

      props.banks.forEach((bank: any) => {
        if (!bank.switches || !bank.switches.length) {
          return
        }
        switchBanks[bank.instance] = bank.switches
        app.subscriptionmanager.subscribe(
          {
            context: 'vessels.self',
            subscribe: bank.switches.map((path: any) => {
              return { path }
            })
          },
          onStop,
          (err: any) => {
            error(err)
            app.setProviderError(err)
          },
          (delta: any) => {
            let pgn = makeBinaryStatusReport(bank)

            delta.updates?.forEach((update: any) => {
              update.values?.forEach((vp: any) => {
                ;(pgn.fields as any)[
                  `indicator${bank.switches.indexOf(vp.path) + 1}`
                ] = vp.value === 1 || vp.value === true ? 'On' : 'Off'
              })
            })
            pgn = needsCamelMapping
              ? (mapCamelCaseKeys(pgn) as PGN_127501)
              : pgn
            debug('sending %j', pgn)
            app.emit('nmea2000JsonOut', pgn)
            if (bank.czoneEnabled) {
              sendCZoneState(bank)
            }
          }
        )
        if (bank.sendRate) {
          const interval = setInterval(() => {
            let pgn = makeBinaryStatusReport(bank)
            pgn = needsCamelMapping
              ? (mapCamelCaseKeys(pgn) as PGN_127501)
              : pgn
            debug('sending update %j', pgn)
            app.emit('nmea2000JsonOut', pgn)
          }, bank.sendRate * 1000)
          onStop.push(() => clearInterval(interval))
        }
      })

      startCZoneEmulation()

      const applySwitchState = (
        instance: any,
        channel: number,
        rawValue: any
      ) => {
        const paths = switchBanks[instance]
        if (!paths) {
          return
        }
        if (channel < 1 || channel > 28) {
          return
        }
        if (paths.length < channel) {
          error(`no path for switch ${channel} bank ${instance}`)
          return
        }
        debug(`Switch ${channel} ${rawValue}`)
        app.putSelfPath(
          paths[channel - 1],
          rawValue === 'On' || rawValue === 1 || rawValue === true ? 1 : 0
        )
      }

      const sendAcknowledge = (
        commandedPgn: number,
        dst: number,
        errorCode: PgnErrorCode
      ) => {
        if (dst === undefined || dst === 255) {
          return
        }
        const ack = new PGN_126208_NmeaAcknowledgeGroupFunction(
          {
            pgn: commandedPgn,
            pgnErrorCode: errorCode,
            transmissionIntervalPriorityErrorCode: 0,
            numberOfParameters: 0,
            list: []
          },
          dst
        )
        const outgoing = needsCamelMapping
          ? (mapCamelCaseKeys(ack) as PGN_126208_NmeaAcknowledgeGroupFunction)
          : ack
        debug('sending ACK %j', outgoing)
        app.emit('nmea2000JsonOut', outgoing)
      }

      const sendBinaryStatusReport = (bank: any) => {
        let pgn = makeBinaryStatusReport(bank)
        if (needsCamelMapping) {
          pgn = mapCamelCaseKeys(pgn) as PGN_127501
        }
        debug('sending %j', pgn)
        app.emit('nmea2000JsonOut', pgn)
      }

      const sendLabels = (bank: any) => {
        bank.switches?.forEach((sw: any, index: number) => {
          const label = switchLabel(sw)
          let pgn = new PGN_130060({
            hardwareChannelId: index,
            pgn: 127501,
            dataSourceInstanceFieldNumber: 1,
            dataSourceInstanceValue: bank.instance,
            secondaryEnumerationFieldNumber: 0,
            secondaryEnumerationFieldValue: 0,
            parameterFieldNumber: index + 2,
            label
          })
          if (needsCamelMapping) {
            pgn = mapCamelCaseKeys(pgn) as PGN_130060
          }
          debug('sending label %j', pgn)
          app.emit('nmea2000JsonOut', pgn)
        })
      }

      const onCZoneCircuitControl = (msg: any) => {
        const result = parseCircuitControl(extractRawPayload(msg))
        if (!result) return
        czoneEnabledBanks().forEach((bank: any) => {
          const switchIndex = circuitIdToSwitchIndex(
            result.circuitId,
            bankFirstCircuitId(bank),
            bank.switches.length
          )
          if (switchIndex < 0) return
          const path = bank.switches[switchIndex]
          if (!path) return
          debug(
            'czone circuit %d -> bank %d switch %d path %s = %s',
            result.circuitId,
            bank.instance,
            switchIndex + 1,
            path,
            result.on ? 'on' : 'off'
          )
          app.putSelfPath(path, result.on ? 1 : 0)
          setCachedSwitch(path, result.on)
          sendCZoneState(bank)
        })
      }

      const onCZoneLabelQuery = (msg: any) => {
        const q = parseLabelQuery(extractRawPayload(msg))
        if (!q) return
        czoneEnabledBanks().forEach((bank: any) => {
          if (q.dipswitch !== bankDipswitch(bank)) return
          // queryType 0x80 = controller / group label (per-circuit), index
          // identifies the circuit by (instance, sub_instance). We answer
          // with the bank switch's display label.
          // queryType 0x87 = system / module name (per-module), no index.
          const replyIndex = (q.subInstance << 8) | q.instance
          let label = ''
          if (q.queryType === 0x87) {
            label = bank.czoneModuleName || `bank ${bank.instance}`
          } else {
            const switchIndex = q.subInstance
            const path = bank.switches?.[switchIndex]
            label = path ? switchLabel(path) : ''
          }
          if (!label) return
          const replyData = packLabelReply(q.queryType, replyIndex, label)
          const reply = czoneFrame(CZONE_PGN_LABEL_REPLY, replyData)
          debug(
            'czone label query type=%d (instance=%d sub=%d) -> %s',
            q.queryType,
            q.instance,
            q.subInstance,
            JSON.stringify(label)
          )
          sendFromBank(bank, reply)
        })
      }

      const onZcfComplete = (src: number, zcf: Buffer) => {
        const dataDir = app.getDataDirPath
          ? app.getDataDirPath()
          : path.join(__dirname, '..')
        try {
          fs.mkdirSync(dataDir, { recursive: true })
          const out = path.join(dataDir, 'last-czone.zcf')
          fs.writeFileSync(out, zcf)
          debug('saved .zcf (%d bytes) from src=%d to %s', zcf.length, src, out)
        } catch (e) {
          debug('failed to persist .zcf: %s', e)
        }
        const summary = parseZcf(zcf)
        if (summary.circuits.length === 0) {
          debug('zcf parse: no circuits found')
          return
        }
        debug(
          'zcf parse: %d circuits, first=%d, contiguous=%s',
          summary.circuits.length,
          summary.firstCircuitId,
          summary.contiguous
        )
        for (const c of summary.circuits) {
          debug('  circuit %d  %s', c.circuitId, c.name)
        }
        if (app.setProviderStatus) {
          const idStr = summary.contiguous
            ? `id range ${summary.firstCircuitId}..${summary.firstCircuitId! +
                summary.circuits.length -
                1}`
            : `ids ${summary.circuits.map(c => c.circuitId).join(',')}`
          app.setProviderStatus(
            `Saw .zcf from src=${src}: ${summary.circuits.length} circuits (${idStr})`
          )
        }
      }
      const zcfReassembler = new ZcfReassembler(onZcfComplete)

      // True when at least one bank has a DeviceEmulator attached; in
      // that case the per-bank emulator.onPGN callback is the dispatch
      // path for CZone proprietary PGNs. The server-wide listener
      // skips them here to avoid double-dispatch.
      const haveCZoneEmulators = (): boolean =>
        czoneEnabledBanks().some((b: any) => b.czoneEmulator)

      const n2kCallback = (msg: any) => {
        try {
          if (msg.pgn == CZONE_PGN_ZCF_TRANSFER) {
            const payload = extractZcfPayload(msg) ?? extractRawPayload(msg)
            if (payload && msg.src !== undefined) {
              zcfReassembler.ingest(msg.src, payload)
            }
            return
          }
          if (
            msg.pgn == CZONE_PGN_CIRCUIT_CONTROL ||
            msg.pgn == CZONE_PGN_CIRCUIT_BITMAP ||
            msg.pgn == CZONE_PGN_LABEL_QUERY
          ) {
            if (haveCZoneEmulators()) {
              // The per-bank emulator's onPGN callback handles these.
              return
            }
            // Fallback path (older canboatjs without DeviceEmulator):
            // dispatch from the server-wide stream.
            if (msg.pgn == CZONE_PGN_CIRCUIT_CONTROL) {
              onCZoneCircuitControl(msg)
            } else if (msg.pgn == CZONE_PGN_CIRCUIT_BITMAP) {
              if (isCircuitStateQuery(extractRawPayload(msg))) {
                czoneEnabledBanks().forEach((b: any) => sendCZoneState(b))
              }
            } else if (msg.pgn == CZONE_PGN_LABEL_QUERY) {
              onCZoneLabelQuery(msg)
            }
            return
          }
          if (msg.pgn == 59904) {
            const requestedPgn =
              msg.fields['pgn'] !== undefined
                ? msg.fields['pgn']
                : msg.fields['PGN']
            if (requestedPgn == 127501) {
              debug('ISO Request for 127501 from src %j', msg.src)
              props.banks?.forEach((bank: any) => {
                if (bank.switches && bank.switches.length) {
                  sendBinaryStatusReport(bank)
                }
              })
            } else if (requestedPgn == 130060) {
              debug('ISO Request for 130060 from src %j', msg.src)
              props.banks?.forEach((bank: any) => {
                if (bank.switches && bank.switches.length) {
                  sendLabels(bank)
                }
              })
            }
            return
          }
          if (msg.pgn == 127502) {
            const camel = msg.fields['instance']
            const instance =
              camel !== undefined ? camel : msg.fields['Instance']
            if (switchBanks[instance]) {
              debug('msg: ' + JSON.stringify(msg))

              for (let i = 1; i < 29; i++) {
                const lowerVal = msg.fields[`switch${i}`]
                const val =
                  lowerVal !== undefined ? lowerVal : msg.fields[`Switch${i}`]
                if (typeof val !== 'undefined') {
                  applySwitchState(instance, i, val)
                }
              }
            }
          } else if (msg.pgn == 126208) {
            const functionCode =
              msg.fields['functionCode'] !== undefined
                ? msg.fields['functionCode']
                : msg.fields['Function Code']
            if (functionCode !== GroupFunction.Command && functionCode !== 1) {
              return
            }
            const commandedPgn =
              msg.fields['pgn'] !== undefined
                ? msg.fields['pgn']
                : msg.fields['PGN'] !== undefined
                ? msg.fields['PGN']
                : msg.fields['Commanded PGN']
            if (commandedPgn != 127501) {
              return
            }
            const list = msg.fields['list'] || msg.fields['List'] || []
            if (!Array.isArray(list) || list.length === 0) {
              return
            }

            let instance: any = undefined
            const channelUpdates: { channel: number; value: any }[] = []

            list.forEach((pair: any) => {
              const parameter =
                pair.parameter !== undefined ? pair.parameter : pair.Parameter
              const value = pair.value !== undefined ? pair.value : pair.Value
              if (parameter == 1) {
                instance = value
              } else if (
                typeof parameter === 'number' &&
                parameter >= 2 &&
                parameter <= 29
              ) {
                channelUpdates.push({ channel: parameter - 1, value })
              }
            })

            if (instance === undefined || !switchBanks[instance]) {
              sendAcknowledge(127501, msg.src, PgnErrorCode.PgnNotAvailable)
              return
            }

            debug('msg: ' + JSON.stringify(msg))
            channelUpdates.forEach(({ channel, value }) => {
              applySwitchState(instance, channel, value)
            })
            sendAcknowledge(127501, msg.src, PgnErrorCode.Acknowledge)
          }
        } catch (e) {
          error(e)
        }
      }
      app.on('N2KAnalyzerOut', n2kCallback)
      onStop.push(() => app.removeListener('N2KAnalyzerOut', n2kCallback))

      registerZcfPushHandler()

      const labelTimer = setTimeout(() => {
        props.banks?.forEach((bank: any) => {
          if (bank.switches && bank.switches.length) {
            sendLabels(bank)
          }
        })
      }, 5000)
      onStop.push(() => clearTimeout(labelTimer))
    },

    stop: function () {
      onStop.forEach((f: any) => f())
      onStop = []
    },

    id: 'signalk-n2k-switching-emulator',
    name: 'NMEA 2000 Siwtching Emulator',
    description:
      'Signal K Plugin which makes existing switches in sk available as n2k switches',

    registerWithRouter: (router: any) => {
      // GET /plugins/signalk-n2k-switching-emulator/zcf?bank=N
      // Returns a synthesised .zcf for the requested bank as a download.
      // Defaults to bank index 0. Useful for a user who wants to load the
      // plugin's switch configuration into the CZone Configuration Tool
      // or upload it to a Navico MFD via SD/USB.
      router.get('/zcf', (req: any, res: any) => {
        const bankIndex =
          req.query?.bank !== undefined
            ? parseInt(String(req.query.bank), 10)
            : 0
        if (!Number.isFinite(bankIndex) || bankIndex < 0) {
          return res.status(400).send('bank must be a non-negative integer')
        }
        const bank = props?.banks?.[bankIndex]
        if (!bank) {
          return res.status(404).send(`no bank at index ${bankIndex}`)
        }
        try {
          const zcf = generateZcfForBank(bank)
          const filename = `${(
            bank.czoneModuleName || `signalk-bank-${bank.instance}`
          ).replace(/[^a-zA-Z0-9._-]/g, '_')}.zcf`
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}"`
          )
          res.send(zcf)
        } catch (e) {
          error(e)
          const msg = e instanceof Error ? e.message : String(e)
          res.status(500).send(`zcf generation failed: ${msg}`)
        }
      })
    },

    schema: () => {
      let paths = app.streambundle
        .getAvailablePaths()
        .filter(
          (path: any) =>
            path &&
            path.startsWith('electrical.switches.') &&
            path.endsWith('.state')
        )

      if (props) {
        props.banks?.forEach((bank: any) => {
          bank.switches?.forEach((sw: any) => {
            if (paths.indexOf(sw) === -1) {
              paths.push(sw)
            }
          })
        })
      }

      paths = paths.sort()

      return {
        //title: plugin.name,
        type: 'object',
        properties: {
          czoneZcfPushEnabled: {
            type: 'boolean',
            title: 'Enable .zcf push to the CZone bus (experimental)',
            description:
              'When enabled, the plugin can push a .zcf file to the bus via PGN 130816 ' +
              "fast-packet sequences from the first CZone-enabled bank's source address. " +
              'Trigger with a SignalK PUT to electrical.czone.pushZcf carrying ' +
              '{ "value": "<base64 of .zcf>" } in the request body. ' +
              'Real CZone modules and plotters listening on PGN 130816 will receive the ' +
              'broadcast, CRC-validate, persist to default.zcf on disk, and reload. ' +
              'Default off.',
            default: false
          },
          czoneAutoPushZcfOnStart: {
            type: 'boolean',
            title:
              'Auto-push the bank-0 .zcf to the bus shortly after start (recovery path)',
            description:
              "When enabled, the plugin generates the first CZone-enabled bank's .zcf " +
              'and broadcasts it via PGN 130816 ~10 seconds after the device emulator ' +
              "attaches, exercising the plotter's bus-receive path " +
              '(czone-spec/spec/zcf-parser.md "Architecture summary"). The plotter ' +
              'CRC-validates the chunks, writes the result to its own default.zcf on ' +
              'disk, and reloads — recovering from a "Starting configuration claim" ' +
              'cold-start hang caused by a missing or corrupt default.zcf. Requires ' +
              'czoneZcfPushEnabled also be true. Use for diagnostic / recovery only; ' +
              "default off so the plugin doesn't unilaterally rewrite a working " +
              "plotter's config on every restart.",
            default: false
          },
          czoneMfdDipswitch: {
            type: 'string',
            title: 'MFD CZone dipswitch (8-bit binary string)',
            description:
              "Your MFD's (Zeus / NSS / Vulcan / etc.) own CZone dipswitch — find it in " +
              "the MFD's CZone settings page. The generated .zcf declares a Display " +
              'Interface module at this dipswitch so the plotter recognises itself in the ' +
              'config and can claim authority during the cold-start "Starting configuration ' +
              'claim" state. Mismatch with the real MFD\'s dipswitch causes the plotter to ' +
              'hang in that state. 8-character binary string, e.g. "00000001" = 1. Must ' +
              "differ from every bank's czoneDipswitch.",
            default: '00000001',
            pattern: '^[01]{8}$'
          },
          czoneSuppressAnnounce: {
            type: 'boolean',
            title: 'Diagnostic: suppress PGN 65290 announce',
            description:
              'Stop emitting the periodic CZone module-announce frame. Bisection ' +
              "toggle for narrowing which PGN trips the plotter's host-local " +
              '"Configuration conflict" popup (eCZoneConfigState=3). Default off.',
            default: false
          },
          czoneSuppressHeartbeat: {
            type: 'boolean',
            title: 'Diagnostic: suppress PGN 65284 circuit-state heartbeat',
            description:
              'Stop emitting the periodic CZone circuit-state bitmap frame. ' +
              'Bisection toggle. Note: real CZone modules use this as a heartbeat; ' +
              'suppressing it will cause the plotter to drop the module from its ' +
              'CZone panel after ~3x the prior cadence. Default off.',
            default: false
          },
          czoneSuppressStatusExt: {
            type: 'boolean',
            title: 'Diagnostic: suppress PGN 130817 status-extended',
            description:
              'Stop emitting the per-circuit status-extended frame. Bisection ' +
              'toggle. Suspected most-likely trigger of the host-local ' +
              '"Configuration conflict" popup since the plugin emits records ' +
              'with bit-position circuit_ids that may not match any module in ' +
              "the plotter's loaded .zcf. Default off.",
            default: false
          },
          czoneChunkIdxOffset: {
            type: 'integer',
            title: 'PGN 130816 starting chunk_idx (advanced debug)',
            description:
              'Shift all emitted chunk_idx values by this offset. ' +
              'Default 0 (canonical). libCZoneCore receive handler at vma 0x6a084 ' +
              'requires the inbound chunk_idx to match its expected_next_chunk_idx ' +
              '(singleton+0x58); only the success path advances that counter, with no ' +
              'documented reset. If the plotter is stuck at "Receiving 0%" because the ' +
              'counter is wedged at a non-zero value from a prior session, ' +
              'rebasing the chunks here (try 1..15 in turn) lets you probe which value ' +
              'unsticks it. czone-spec commit b0a017e for the decode.',
            default: 0,
            minimum: 0,
            maximum: 255
          },
          banks: {
            title: 'Banks',
            type: 'array',
            description: 'N2K bank instances to emulate',
            items: {
              type: 'object',
              properties: {
                instance: {
                  title: 'N2K Bank Instance',
                  type: 'number',
                  default: 0
                },
                sendRate: {
                  title: 'Send Rate',
                  type: 'number',
                  description:
                    'Rate (in seconds) to send to N2K (set to 0 to not send updates)',
                  default: 15
                },
                switches: {
                  type: 'array',
                  title: 'Switches',
                  items: {
                    title: 'Switch Path',
                    type: 'string',
                    enum: paths.length > 0 ? paths : undefined
                  }
                },
                czoneEnabled: {
                  type: 'boolean',
                  title: 'Expose this bank as a CZone module on the bus',
                  default: false
                },
                czoneDipswitch: {
                  type: 'string',
                  title: 'CZone dipswitch (when CZone enabled)',
                  description:
                    'Eight-bit dipswitch as a binary string (the same value entered on the plotter\'s CZone settings page), e.g. "00011000". Each CZone-enabled bank must use a distinct dipswitch.',
                  default: '00011000',
                  pattern: '^[01]{8}$'
                },
                czoneFirstCircuitId: {
                  type: 'integer',
                  title: 'First CZone circuit id (when CZone enabled)',
                  description:
                    'The first circuit id the .zcf assigned to this module. Switch 1 of this bank = this id, switch 2 = id+1, etc. Yacht Devices YDAB-01 uses 13.',
                  default: 13,
                  minimum: 1,
                  maximum: 252
                },
                czoneAnnounceUnique: {
                  type: 'string',
                  title: 'Override CZone announce unique (advanced)',
                  description:
                    'Override the 20-bit unique ID announced in PGN 65290 for this bank. Empty = derive from vesselUuid+bank.instance (default). libCZoneCore compares this against the unique field of the loaded .zcf module on the plotter and fires the "Configuration conflict" popup on mismatch — set to match what the plotter has loaded for the dipswitch slot you are claiming. Accepts decimal ("899387"), 0x-hex ("0xDB13B"), or bare hex ("DB13B"). YDAB-01 default = 0xDB13B.',
                  default: ''
                },
                czoneModuleName: {
                  type: 'string',
                  title: 'CZone module name',
                  description:
                    'Module label as shown in the CZone Configuration Tool and used as the answer to a system-name query (PGN 65299 query_type 0x87). Also used as the filename for downloaded .zcf files. Optional.',
                  default: ''
                },
                czoneConfigName: {
                  type: 'string',
                  title: 'CZone config name',
                  description:
                    'Top-level config label written into the .zcf when generating one for download. Defaults to "SignalK Switching <instance>" if empty.',
                  default: ''
                },
                czoneModuleType: {
                  type: 'string',
                  title: 'CZone module type',
                  description:
                    'Which kind of module the CZone Configuration Tool should render this bank as. Look at the part-number sticker on your module to pick the matching type. "oi" = Output Interface (default), 6 outputs DC1..DC6, parts 80-911-0009-00 / -0010-00. "coi" = Combination Output Interface, 16 outputs DC1..DC16 (the modern hardware has 4 x 25A high-current + 12 x 10A dimmable, 150A max), parts 80-911-0119-00 (modern) / 80-911-0120-00 (legacy). "control1" = Control 1 module, 16 outputs DC1..DC16, part 80-911-0122-00 (a separate Mastervolt product that shares the 16-channel layout with COI but has its own hardware identity).',
                  enum: ['oi', 'coi', 'control1'],
                  default: 'oi'
                },
                czoneSubCategories: {
                  type: 'array',
                  title: 'CZone sub-categories per switch (optional)',
                  description:
                    'One sub-category per switch (in the same order as the switches array) shown by the CZone Configuration Tool in its Circuit Menu Sub-Categories grid. Leave a slot at "none" to keep the circuit uncategorised.',
                  items: {
                    type: 'string',
                    enum: [
                      'none',
                      'house-habitat',
                      'vessel-critical',
                      'navigation',
                      'electronics',
                      '24-hour',
                      'communications',
                      'accessories',
                      'indicators-alarms',
                      'engine-management',
                      'fans-ventilation',
                      'lighting',
                      'vessel-management',
                      'pumps',
                      'propulsion-management',
                      'power',
                      'refrigeration'
                    ],
                    default: 'none'
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // PGN 130816 dedicated extractor. canboatjs may deliver this PGN in
  // either of two shapes:
  //
  //  (a) Stub: fields.Data is a hex string of EVERY byte after the
  //      0x27 0x99 manufacturer header (chunk_idx + flag + reserved
  //      + actual .zcf data). Older canboat releases use this.
  //
  //  (b) Named: fields.{chunkIndex, flag, reserved6, data} where each
  //      field carries only its slice. The `data` field is just the
  //      trailing .zcf payload, NOT everything-after-header. Newer
  //      canboat releases (with the full BEP CZone .zcf Bus Distribution
  //      definition) use this shape.
  //
  // The legacy extractRawPayload only handles (a) and would prepend
  // 0x27 0x99 to the data slice in (b), producing a buffer the
  // ZcfReassembler reads chunk_idx out of the wrong byte offsets.
  // This helper handles (b) explicitly: rebuild the wire bytes from
  // the named fields, in the order the ZcfReassembler expects.
  function extractZcfPayload (msg: any): Buffer | undefined {
    const fields = msg?.fields
    if (!fields || typeof fields.chunkIndex !== 'number') return undefined
    const dataHex = fields.data ?? fields.Data
    if (typeof dataHex !== 'string') return undefined
    const cleaned = dataHex.replace(/[^0-9a-fA-F]/g, '')
    if (cleaned.length % 2 !== 0) return undefined
    const dataBytes = Buffer.alloc(cleaned.length / 2)
    for (let i = 0; i < dataBytes.length; i++) {
      dataBytes[i] = parseInt(cleaned.substr(i * 2, 2), 16)
    }
    // Build the 23-byte fixed header + dataBytes:
    //   [0x27 0x99] + chunkIndex u16 LE + flag u8 + 18 reserved bytes + data
    const buf = Buffer.alloc(23 + dataBytes.length)
    buf[0] = 0x27
    buf[1] = 0x99
    buf.writeUInt16LE(fields.chunkIndex & 0xffff, 2)
    buf[4] = (fields.flag ?? 0) & 0xff
    // bytes 5..22 are reserved zero (already zero from Buffer.alloc).
    dataBytes.copy(buf, 23)
    return buf
  }

  function extractRawPayload (msg: any): Buffer | undefined {
    if (Buffer.isBuffer(msg?.data)) return msg.data
    const dataField = msg?.fields?.Data ?? msg?.fields?.data
    if (typeof dataField === 'string') {
      const cleaned = dataField.replace(/[^0-9a-fA-F]/g, '')
      if (cleaned.length % 2 !== 0) return undefined
      const buf = Buffer.alloc(2 + cleaned.length / 2)
      buf[0] = 0x27
      buf[1] = 0x99
      for (let i = 0; i < cleaned.length / 2; i++) {
        buf[2 + i] = parseInt(cleaned.substr(i * 2, 2), 16)
      }
      return buf
    }
    // canboatjs has parsed the proprietary fields (e.g. circuit_id,
    // levelOrValue) into msg.fields and dropped the catch-all `Data`.
    // Round-trip back through the encoder to reconstruct the wire bytes
    // so our spec-driven parsers (parseCircuitControl, parseLabelQuery,
    // ...) see the same byte layout regardless of whether canboat ships
    // a stub for the PGN or a fully-decoded definition.
    if (msg?.fields && typeof msg.pgn === 'number') {
      try {
        const buf = toPgn(msg as any)
        if (Buffer.isBuffer(buf)) return buf
      } catch (e) {
        debug('extractRawPayload toPgn failed for pgn %d: %s', msg.pgn, e)
      }
    }
    return undefined
  }

  // Per-bank in-memory cache of switch states. Inbound CZone circuit-control
  // (PGN 65280) writes to this synchronously so the next heartbeat reflects
  // the new state immediately. We also fall back to app.getSelfPath if the
  // cache hasn't seen the path yet (e.g. an externally-driven switch toggled
  // via SignalK delta from another producer).
  const switchStateCache: { [path: string]: boolean } = {}

  function setCachedSwitch (path: string, on: boolean): void {
    switchStateCache[path] = on
  }

  function readBankSwitchStates (bank: any): boolean[] {
    // Size the result array to the bank's actual configured switch count
    // (capped at 32, the bitmap width in PGN 65284). Hardcoding to
    // CZONE_SUPPORTED_SWITCHES=6 was wrong for non-OI module types: a
    // 16-channel COI bank would still report only 6 switches, causing
    // the plotter to detect a circuit-count mismatch vs the loaded
    // .zcf and surface state 12 ("Configuration conflict detected on
    // network").
    const switchPaths = (bank.switches as string[]) ?? []
    const count = Math.min(switchPaths.length, 32)
    const out = new Array(count).fill(false)
    for (let index = 0; index < count; index++) {
      const sw = switchPaths[index]
      if (Object.prototype.hasOwnProperty.call(switchStateCache, sw)) {
        out[index] = switchStateCache[sw]
        continue
      }
      const value = app.getSelfPath(sw)
      if (value && typeof value.value !== 'undefined') {
        out[index] = value.value === 1 || value.value === true
      }
    }
    return out
  }

  function czoneEnabledBanks (): any[] {
    return (
      props?.banks?.filter(
        (b: any) => b?.czoneEnabled && b.switches && b.switches.length
      ) ?? []
    )
  }

  function bankDipswitch (bank: any): number {
    return parseDipswitch(bank?.czoneDipswitch)
  }

  function bankFirstCircuitId (bank: any): number {
    const v = bank?.czoneFirstCircuitId
    return Number.isFinite(v) ? Number(v) : 13
  }

  function bankSerial (bank: any): number {
    // Per-bank explicit override takes precedence so users can match a
    // specific module's unique that the plotter has loaded in its .zcf.
    // libCZoneCore's PGN-65290 inbound handler compares the announce's
    // unique field against the loaded module's unique (from BSS+0x69e6c)
    // and fires the conflict-popup chain on mismatch — see
    // czone-spec/spec/czone-config-state-machine.md commit 830b2c4
    // "popup discriminator IDENTIFIED as the unique field".
    //
    // Accepts decimal ("899387"), 0x-prefixed hex ("0xDB13B"), or bare hex
    // ("DB13B"). Clamped to 20 bits (the on-wire field width).
    const override = bank?.czoneAnnounceUnique
    if (typeof override === 'string' && override.trim() !== '') {
      const s = override.trim()
      let n: number
      if (/^0x[0-9a-f]+$/i.test(s)) n = parseInt(s, 16)
      else if (/^[0-9]+$/.test(s)) n = parseInt(s, 10)
      else if (/^[0-9a-f]+$/i.test(s)) n = parseInt(s, 16)
      else n = NaN
      if (Number.isFinite(n) && n >= 0) return n & 0xfffff
    }
    return deriveUniqueSerial(
      `${app.config?.settings?.vesselUuid ??
        app.config?.settings?.vesselMMSI ??
        'signalk'}#${bank.instance}`
    )
  }

  // Send a CZone-proprietary frame either through the bank's own
  // DeviceEmulator (when canboatjsUtils exposed createEmulator and we've
  // claimed a NAME-MFG=295 device for this bank) or, on older canboatjs
  // versions without that API, by injecting an Actisense string via the
  // `nmea2000out` event so the host CAN provider rewrites src to the
  // server's claimed source.
  //
  // The emulator path is what the discovery spec actually requires
  // (czone-spec/spec/discovery.md#the-mfg295-gate); the fallback exists
  // only so the plugin keeps doing _something_ on older canboatjs.
  function sendFromBank (bank: any, frame: string): void {
    if (bank.czoneEmulator) {
      bank.czoneEmulator.send(frame)
    } else {
      app.emit('nmea2000out', frame)
    }
  }

  // Per-bank state tracking for sendCZoneState's rate-limiter.
  const lastCZoneStateMs: { [instance: number]: number } = {}
  const lastCZoneStateBitmap: { [instance: number]: string } = {}

  function sendCZoneState (bank: any): void {
    // Rate-limit + change-suppress: collapse back-to-back calls when
    // the bank's switch state hasn't changed. sendCZoneState is called
    // from FIVE places (the 2 s timer, every inbound PGN 65280 from
    // both the server-wide stream AND the per-bank emulator stream,
    // every inbound PGN 65284 query from both streams, and every
    // SignalK delta on a switch path). Without this guard, the
    // SignalK delta from inbound PGN 127501 broadcasts (every ~250 ms
    // on a busy bus) loops back through the subscriptionmanager and
    // fires sendCZoneState on every delta, producing PGN 65284 / 130817
    // emissions at ~5 Hz instead of the spec's typical 0.5 Hz cadence.
    // Real Zeus3S plotters detect the abnormal cadence and surface it
    // as eCZoneConfigState[12] "Configuration conflict detected on
    // network", refusing to leave the initial config-claim state.
    // Verified 2026-05-10 from czone-scott-plotter-state-12-emulator-
    // hardcoded-6.txt: PGN 130817 firing at avg 175 ms (min 1 ms,
    // max 1998 ms) when the plotter sat on state 12.
    //
    // The two suppression conditions:
    //   - if the switch-state bitmap is identical to the last emission
    //     AND less than CZONE_HEARTBEAT_MS has elapsed, skip
    //   - genuine state changes always fire immediately so the plotter
    //     sees toggle-acks without lag
    const switches = readBankSwitchStates(bank)
    const bitmapKey = switches.map(b => (b ? '1' : '0')).join('')
    const now = Date.now()
    const last = lastCZoneStateMs[bank.instance] ?? 0
    const lastBitmap = lastCZoneStateBitmap[bank.instance]
    if (bitmapKey === lastBitmap && now - last < CZONE_HEARTBEAT_MS) return
    lastCZoneStateMs[bank.instance] = now
    lastCZoneStateBitmap[bank.instance] = bitmapKey

    const dipswitch = bankDipswitch(bank)
    if (!props?.czoneSuppressHeartbeat) {
      const bitmap = czoneFrame(
        CZONE_PGN_CIRCUIT_BITMAP,
        packCircuitBitmap(dipswitch, switches)
      )
      debug('sending czone 65284 %s', bitmap)
      sendFromBank(bank, bitmap)
    }

    if (!props?.czoneSuppressStatusExt) {
      const status = czoneFrame(
        CZONE_PGN_STATUS_EXTENDED,
        packStatusExtended(dipswitch, switches)
      )
      debug('sending czone 130817 %s', status)
      sendFromBank(bank, status)
    }
  }

  function buildAddressClaim (bank: any): PGN_60928 {
    // Device instance splits 3 bits low + 5 bits high = 8 bits total. Convention
    // (Maretron, Yacht Devices, etc.) is to set this to the bank instance so
    // multiple switch banks of the same device class on the same bus are
    // distinguishable in the NAME itself, not just the per-PGN instance fields.
    const inst = (bank.instance ?? 0) & 0xff
    return new PGN_60928({
      uniqueNumber: bankSerial(bank),
      // czone-spec/spec/discovery.md "MFG=295 gate": the CZone receiver
      // requires NAME manufacturer_code = 295. ManufacturerCode.BepMarine
      // resolves to 116 (an older BEP company code); ManufacturerCode.
      // BepMarine2 resolves to 295 — exposed by @canboat/ts-pgns once
      // canboat upstream PR #627 disambiguated the duplicate "BEP Marine"
      // names in MANUFACTURER_CODE.
      manufacturerCode: ManufacturerCode.BepMarine2,
      deviceFunction: DeviceFunction.SwitchInterface,
      deviceClass: DeviceClass.ElectricalDistribution,
      deviceInstanceLower: inst & 0x07,
      deviceInstanceUpper: (inst >> 3) & 0x1f,
      systemInstance: inst & 0x0f,
      industryGroup: IndustryCode.Marine,
      arbitraryAddressCapable: YesNo.Yes
    })
  }

  function buildProductInfo (bank: any): PGN_126996 {
    // productCode 8395 = COI = Combination Output Interface (per
    // czone-spec/spec/discovery.md#recognised-product-ids). Picked as the
    // closest match for "a generic 6-channel switch bank" until the spec
    // identifies a better default.
    return new PGN_126996({
      nmea2000Version: 1300,
      productCode: bank.czoneProductCode ?? 8395,
      modelId: (bank.czoneModuleName || `signalk-czone-${bank.instance}`).slice(
        0,
        32
      ),
      softwareVersionCode: '1.0',
      modelVersion: '1.0',
      modelSerialCode: String(bankSerial(bank)).slice(0, 32),
      certificationLevel: 0,
      loadEquivalency: 1
    })
  }

  function attachEmulatorToBank (bank: any, utils: any): void {
    if (bank.czoneEmulator) return
    const id = `signalk-n2k-switching-emulator/bank-${bank.instance}`
    debug(
      'creating CZone emulator for bank %d via canboatjsUtils id=%s',
      bank.instance,
      id
    )
    const emulator = utils.createEmulator(
      id,
      {},
      buildAddressClaim(bank),
      buildProductInfo(bank),
      undefined
    )
    bank.czoneEmulator = emulator
    onStop.push(() => {
      try {
        utils.removeEmulator(id)
      } catch (e) {
        debug('removeEmulator(%s) failed: %s', id, e)
      }
      delete bank.czoneEmulator
    })
    emulator.onPGN((pgn: any) => onCZonePGN(bank, pgn))
    sendBankAnnounce(bank)
    maybeScheduleAutoPushZcf(bank)
  }

  // If czoneAutoPushZcfOnStart is enabled (and czoneZcfPushEnabled is true,
  // since auto-push uses the same code path), schedule a one-shot timer to
  // push this bank's .zcf via PGN 130816 about 10 s after the emulator
  // attaches. The plotter CRC-validates inbound chunks and persists the
  // result to its own default.zcf — recovering from a "Starting
  // configuration claim" cold-start hang caused by a missing or corrupt
  // default.zcf on the plotter's disk. See czone-spec/spec/zcf-parser.md
  // "Architecture summary" — the bus-receive path triggers a write-then-
  // reload regardless of whether the on-disk default.zcf is currently
  // valid. Only fires for the FIRST CZone-enabled bank (matching the
  // PUT-handler contract that pushes from the first bank's SA); other
  // banks' .zcfs would have to be pushed manually via the PUT endpoint.
  function maybeScheduleAutoPushZcf (bank: any): void {
    if (!props?.czoneAutoPushZcfOnStart) return
    if (!props?.czoneZcfPushEnabled) {
      debug(
        'czoneAutoPushZcfOnStart=true but czoneZcfPushEnabled=false; ' +
          'auto-push disabled (set both to true to enable)'
      )
      return
    }
    const firstEnabled = czoneEnabledBanks()[0]
    if (!firstEnabled || firstEnabled.instance !== bank.instance) return
    const timer = setTimeout(() => {
      try {
        const zcf = generateZcfForBank(bank)
        const { chunks } = pushZcfToBus(zcf)
        debug(
          'auto-pushed bank %d .zcf (%d bytes) as %d PGN 130816 chunks',
          bank.instance,
          zcf.length,
          chunks
        )
      } catch (e) {
        error(
          `auto-push of bank ${bank.instance} .zcf failed: ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
    }, CZONE_AUTO_PUSH_DELAY_MS)
    onStop.push(() => clearTimeout(timer))
  }

  // Dispatch a CZone proprietary PGN that arrived on a specific bank's
  // DeviceEmulator. The bank context is known statically (each bank
  // owns one emulator) so we don't need to iterate every CZone-enabled
  // bank like the server-wide n2kCallback does.
  function onCZonePGN (bank: any, pgn: any): void {
    if (!pgn) return
    if (pgn.pgn === CZONE_PGN_CIRCUIT_CONTROL) {
      const result = parseCircuitControl(extractRawPayload(pgn))
      if (!result) return
      const switchIndex = circuitIdToSwitchIndex(
        result.circuitId,
        bankFirstCircuitId(bank),
        bank.switches.length
      )
      if (switchIndex < 0) return
      const path = bank.switches[switchIndex]
      if (!path) return
      debug(
        'czone circuit %d -> bank %d switch %d path %s = %s',
        result.circuitId,
        bank.instance,
        switchIndex + 1,
        path,
        result.on ? 'on' : 'off'
      )
      app.putSelfPath(path, result.on ? 1 : 0)
      // Update the in-memory mirror synchronously so the next heartbeat
      // reflects the new state without waiting for the SignalK delta
      // pipeline to round-trip back through getSelfPath.
      setCachedSwitch(path, result.on)
      sendCZoneState(bank)
      return
    }
    if (pgn.pgn === CZONE_PGN_CIRCUIT_BITMAP) {
      if (isCircuitStateQuery(extractRawPayload(pgn))) {
        sendCZoneState(bank)
      }
      return
    }
    if (pgn.pgn === CZONE_PGN_LABEL_QUERY) {
      const q = parseLabelQuery(extractRawPayload(pgn))
      if (!q) return
      if (q.dipswitch !== bankDipswitch(bank)) return
      const replyIndex = (q.subInstance << 8) | q.instance
      let label = ''
      if (q.queryType === 0x87) {
        label = bank.czoneModuleName || `bank ${bank.instance}`
      } else {
        const switchIndex = q.subInstance
        const path = bank.switches?.[switchIndex]
        label = path ? switchLabel(path) : ''
      }
      if (!label) return
      const replyData = packLabelReply(q.queryType, replyIndex, label)
      const reply = czoneFrame(CZONE_PGN_LABEL_REPLY, replyData)
      debug(
        'czone label query type=%d (instance=%d sub=%d) -> %s',
        q.queryType,
        q.instance,
        q.subInstance,
        JSON.stringify(label)
      )
      sendFromBank(bank, reply)
    }
  }

  // Locate the bundled .zcf template that generateZcf uses as a structural
  // prototype. When the plugin is installed via npm, dist/ sits next to
  // templates/ inside the package; in development from this repo it's the
  // same layout. Falls back to scanning a couple of well-known parents.
  let cachedTemplate: Buffer | undefined
  function loadZcfTemplate (): Buffer {
    if (cachedTemplate) return cachedTemplate
    const candidates = [
      path.join(__dirname, '..', 'templates', 'template.zcf'),
      path.join(__dirname, '..', '..', 'templates', 'template.zcf')
    ]
    for (const p of candidates) {
      try {
        cachedTemplate = fs.readFileSync(p)
        return cachedTemplate
      } catch {
        // try next
      }
    }
    throw new Error(
      `could not find template.zcf in any of: ${candidates.join(', ')}`
    )
  }

  function generateZcfForBank (bank: any): Buffer {
    const template = loadZcfTemplate()
    const switches = (bank.switches as string[]) ?? []
    if (switches.length === 0) {
      throw new Error(`bank ${bank.instance} has no switches configured`)
    }
    const firstCircuitId = bankFirstCircuitId(bank)
    const dipswitch = bank.czoneEnabled ? bankDipswitch(bank) : 0x18
    const moduleName = bank.czoneModuleName || `SignalK Bank ${bank.instance}`
    const subCats = (bank.czoneSubCategories as string[]) ?? []
    // typeCode picks how the Configuration Tool labels the module's
    // outputs. Each value is verified by importing a generated file
    // on Windows and reading the tool's Modules tree label:
    //   'oi'       -> m1=0x0f. Renders as "Output Interface", 6 outputs
    //                 DC1..DC6. Parts 80-911-0009-00 / -0010-00.
    //   'coi'      -> m1=0x1f. Renders as "Combination Output Interface",
    //                 16 outputs DC1..DC16 (4 high-current + 12 dimmable
    //                 on the modern hardware, 150A max). Parts
    //                 80-911-0119-00 (modern) / 80-911-0120-00 (legacy).
    //   'control1' -> m1=0x1c. Renders as "Control 1", 16 outputs
    //                 DC1..DC16. A separate Mastervolt product
    //                 (80-911-0122-00) that happens to share the
    //                 16-channel layout with COI but has its own
    //                 hardware identity.
    // Other czoneModuleType values ('contact6', 'cxp') are intentionally
    // absent until we can verify them empirically by Windows import.
    const typeKey = (bank.czoneModuleType as string) || 'oi'
    const typeCode =
      typeKey === 'coi' ? 0x1f : typeKey === 'control1' ? 0x1c : 0x0f
    const mfdDipswitchRaw = props?.czoneMfdDipswitch
    const mfdDipswitch =
      typeof mfdDipswitchRaw === 'string' && /^[01]{8}$/.test(mfdDipswitchRaw)
        ? parseDipswitch(mfdDipswitchRaw)
        : undefined
    const spec: ZcfGenSpec = {
      configName: bank.czoneConfigName || `SignalK Switching ${bank.instance}`,
      module: { dipswitch, name: moduleName, typeCode },
      bankInstance: bank.instance & 0xff,
      mfdDipswitch,
      circuits: switches.map((sw, i) => {
        const subKey = subCats[i] ?? 'none'
        const subCategory = SUB_CATEGORY_NAME_TO_BIT[subKey] ?? 0
        return {
          name: switchLabel(sw),
          circuitId: firstCircuitId + i,
          subCategory
        }
      })
    }
    return generateZcf(spec, template)
  }

  // Push a full .zcf onto the bus as a sequence of PGN 130816 fast-packet
  // frames from the first CZone-enabled bank's source address. Mirrors what
  // a Zeus 3S plotter does when distributing a config — see
  // czone-spec/spec/pgn-130816.md "Frame layout" and the captures referenced
  // there. Gated on `props.czoneZcfPushEnabled`; the PUT handler refuses
  // when the toggle is off so this stays opt-in.
  function pushZcfToBus (zcf: Buffer): { chunks: number; bank: any } {
    const banks = czoneEnabledBanks()
    if (banks.length === 0) {
      throw new Error('no CZone-enabled bank to push from')
    }
    const bank = banks[0]
    const startIdx = Number.isFinite(props?.czoneChunkIdxOffset)
      ? Number(props.czoneChunkIdxOffset) & 0xffff
      : 0
    const chunks = chunkZcf(zcf, startIdx)
    for (const c of chunks) {
      const frame = czoneFrame(CZONE_PGN_ZCF_TRANSFER, c.payload)
      sendFromBank(bank, frame)
    }
    return { chunks: chunks.length, bank }
  }

  // SignalK PUT handler on `electrical.czone.pushZcf`. Body shape:
  //   { "value": "<base64 of .zcf>" }
  // Returns a SignalK ActionResult-compatible object.
  function registerZcfPushHandler (): void {
    if (typeof app.registerPutHandler !== 'function') {
      debug('app.registerPutHandler unavailable; .zcf push disabled')
      return
    }
    app.registerPutHandler(
      'vessels.self',
      CZONE_ZCF_PUSH_PATH,
      (_context: string, _path: string, value: any, _callback?: any) => {
        if (!props?.czoneZcfPushEnabled) {
          return {
            state: 'COMPLETED',
            statusCode: 403,
            message:
              'czoneZcfPushEnabled is false — enable it in plugin settings'
          }
        }
        if (typeof value !== 'string' || value.length === 0) {
          return {
            state: 'COMPLETED',
            statusCode: 400,
            message: 'PUT value must be a non-empty base64 string'
          }
        }
        let zcf: Buffer
        try {
          zcf = Buffer.from(value, 'base64')
        } catch (e) {
          return {
            state: 'COMPLETED',
            statusCode: 400,
            message: `base64 decode failed: ${e}`
          }
        }
        // Sanity-check the .zcf header. parseZcf returns at least an empty
        // circuit list on garbage input, so use it as a soft validator: a
        // file with zero strings is almost certainly not a real .zcf.
        const summary = parseZcf(zcf)
        if (zcf.length < 32 || summary.strings.length === 0) {
          return {
            state: 'COMPLETED',
            statusCode: 400,
            message: `payload (${zcf.length} bytes) does not look like a .zcf`
          }
        }
        try {
          const { chunks, bank } = pushZcfToBus(zcf)
          debug(
            'pushed .zcf (%d bytes) as %d chunks from bank %d',
            zcf.length,
            chunks,
            bank.instance
          )
          return {
            state: 'COMPLETED',
            statusCode: 200,
            message: `pushed ${zcf.length} bytes as ${chunks} chunks`
          }
        } catch (e) {
          error(e)
          return {
            state: 'COMPLETED',
            statusCode: 500,
            message: e instanceof Error ? e.message : String(e)
          }
        }
      }
    )
  }

  function sendBankAnnounce (bank: any): void {
    if (props?.czoneSuppressAnnounce) return
    const dipswitch = bankDipswitch(bank)
    const serial = bankSerial(bank)
    const announce = czoneFrame(
      CZONE_PGN_ANNOUNCE,
      packAnnounce(serial, dipswitch)
    )
    sendFromBank(bank, announce)
  }

  function startCZoneEmulation (): void {
    czoneEnabledBanks().forEach((bank: any) => {
      const dipswitch = bankDipswitch(bank)
      const serial = bankSerial(bank)
      debug(
        'czone emulation: bank=%d dipswitch=%d serial=%d',
        bank.instance,
        dipswitch,
        serial
      )
      // The first announce goes out via the nmea2000out fallback; once
      // canboatjsUtils arrives below, the bank's DeviceEmulator is
      // attached and the next periodic announce uses the MFG=295 path.
      sendBankAnnounce(bank)
      // Re-broadcast PGN 65290 every 2 s. spec/pgn-65290.md doesn't mandate
      // a cadence, but spec/zcf-transmit-protocol.md shows the plotter's
      // state-9 handler clears its acknowledged-receiver bitmap each chunk
      // window (~3 s) — the announce has to land inside that window for
      // the plotter to advance past chunk 0. Real CZone modules tolerate
      // a 2 s announce cadence; the bus chatter is negligible.
      const announceInterval = setInterval(
        () => sendBankAnnounce(bank),
        CZONE_ANNOUNCE_MS
      )
      onStop.push(() => clearInterval(announceInterval))
      const interval = setInterval(
        () => sendCZoneState(bank),
        CZONE_HEARTBEAT_MS
      )
      onStop.push(() => clearInterval(interval))
    })

    // Subscribe to canboatjsUtils to get the DeviceEmulator factory; when
    // it arrives, attach a per-bank emulator that claims a NAME-MFG=295
    // device on the bus. This is what the spec's MFG=295 gate requires
    // (czone-spec/spec/discovery.md#the-mfg295-gate).
    if (typeof app.onPropertyValues === 'function') {
      app.onPropertyValues('canboatjsUtils', (history: any[]) => {
        if (!history) return
        for (const entry of history) {
          if (!entry || !entry.value) continue
          const utils = (entry.value as any).utils
          if (!utils || !utils.supportsDeviceCreation) continue
          czoneEnabledBanks().forEach((bank: any) =>
            attachEmulatorToBank(bank, utils)
          )
        }
      })
    } else {
      debug(
        'app.onPropertyValues unavailable; falling back to nmea2000out path. ' +
          'CZone main panel will not see MFG=295 in the address claim — ' +
          'upgrade canboatjs to the version that exports createEmulator.'
      )
    }
  }

  function switchLabel (path: string): string {
    const data = app.getSelfPath(path)
    if (data?.meta?.displayName) {
      return data.meta.displayName
    }
    const parts = path
      .replace('electrical.switches.', '')
      .replace('.state', '')
      .split('.')
    return parts
      .map((p: string) =>
        p
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (c: string) => c.toUpperCase())
      )
      .join(' ')
      .trim()
  }

  function makeBinaryStatusReport (bank: any) {
    const pgn = new PGN_127501({
      instance: bank.instance
    })

    bank.switches?.forEach((sw: any, index: number) => {
      const value = app.getSelfPath(sw)
      if (value && typeof value.value !== 'undefined') {
        ;(pgn.fields as any)[`indicator${index + 1}`] =
          value.value === 1 || value.value === true ? 'On' : 'Off'
      }
    })
    return pgn
  }

  return plugin
}

interface Plugin {
  start: (app: any) => void
  stop: () => void
  id: string
  name: string
  description: string
  schema: any
  registerWithRouter?: (router: any) => void
}
