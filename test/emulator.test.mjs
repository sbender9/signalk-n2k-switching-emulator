// Verifies the canboatjs DeviceEmulator integration path. When
// `app.onPropertyValues('canboatjsUtils', cb)` exposes a utils object
// with `supportsDeviceCreation === true`, the plugin must:
//
//   1. Call utils.createEmulator() per CZone-enabled bank with a NAME
//      whose manufacturerCode is BepMarine (295).
//   2. Send CZone proprietary frames through emulator.send() instead of
//      the server-wide nmea2000out event.
//   3. Receive CZone PGNs via emulator.onPGN() and dispatch them to the
//      bank-specific handlers.
//
// The fakeUtils object below mirrors the canboatjs PR #424 surface
// (createEmulator, supportsDeviceCreation, removeEmulator) just enough
// for the plugin to wire up.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  ManufacturerCode
} from '/home/dirk/dev/signalk-n2k-switching-emulator/node_modules/@canboat/ts-pgns/dist/index.js'
import pluginModule from '/home/dirk/dev/signalk-n2k-switching-emulator/dist/index.js'
const pluginFactory = pluginModule.default ?? pluginModule

const SWITCH_PATHS = [
  'electrical.switches.bank.0.1.state',
  'electrical.switches.bank.0.2.state',
  'electrical.switches.bank.0.3.state'
]

class FakeEmulator extends EventEmitter {
  constructor (id, addressClaim, productInfo) {
    super()
    this.id = id
    this.addressClaim = addressClaim
    this.productInfo = productInfo
    this.sent = []
  }
  send (frame) {
    this.sent.push(frame)
  }
  onPGN (cb) {
    this.on('pgn', cb)
  }
  // helper for tests
  injectInbound (pgn) {
    this.emit('pgn', pgn)
  }
}

class FakeApp extends EventEmitter {
  constructor () {
    super()
    this.config = { version: '2.20.0', settings: { vesselUuid: 'urn:test' } }
    this.selfState = {}
    this.subscriptions = []
    this.subscriptionmanager = {
      subscribe: (cmd, _onStop, errorCb, deltaCb) => {
        this.subscriptions.push({ cmd, errorCb, deltaCb })
      }
    }
    this.propertyValueListeners = {}
    this.emulators = []
  }
  debug () {}
  error () {}
  setProviderError () {}
  setProviderStatus () {}
  getSelfPath (path) {
    return this.selfState[path]
  }
  putSelfPath (path, value) {
    this.selfState[path] = { value }
    const sub = this.subscriptions[0]
    if (sub) sub.deltaCb({ updates: [{ values: [{ path, value }] }] })
  }
  handleMessage () {}
  onPropertyValues (key, cb) {
    this.propertyValueListeners[key] ??= []
    this.propertyValueListeners[key].push(cb)
  }
  // tests call this to simulate canboatjs publishing the utils
  publishCanboatjsUtils () {
    const utils = {
      supportsDeviceCreation: true,
      createEmulator: (id, _options, addressClaim, productInfo) => {
        const emu = new FakeEmulator(id, addressClaim, productInfo)
        this.emulators.push(emu)
        return emu
      },
      removeEmulator: (id) => {
        const i = this.emulators.findIndex((e) => e.id === id)
        if (i >= 0) this.emulators.splice(i, 1)
      }
    }
    const listeners = this.propertyValueListeners.canboatjsUtils ?? []
    for (const cb of listeners) {
      cb([{ value: { id: 'fake-canbus', utils } }])
    }
  }
}

const app = new FakeApp()
const plugin = pluginFactory(app)

plugin.start({
  banks: [
    {
      instance: 0,
      sendRate: 0,
      switches: SWITCH_PATHS,
      czoneEnabled: true,
      czoneDipswitch: '00011000',
      czoneFirstCircuitId: 13,
      czoneModuleName: 'test-module'
    }
  ]
})

// Now publish canboatjsUtils, which should make the plugin call
// utils.createEmulator() for the bank.
app.publishCanboatjsUtils()

await new Promise((r) => setTimeout(r, 50))

assert.equal(app.emulators.length, 1, 'one emulator created for one bank')
const emu = app.emulators[0]

// Address claim manufacturer code. ManufacturerCode.BepMarine2 = 295 is the
// CZone gate value (czone-spec/spec/discovery.md#the-mfg295-gate); BepMarine
// = 116 is an older BEP company code that the CZone receiver does not
// accept. ts-pgns >= 1.11.16-beta.1 exposes BepMarine2 once canboat#627
// disambiguated the two "BEP Marine" entries in MANUFACTURER_CODE.
const claimMfg = emu.addressClaim?.fields?.manufacturerCode
assert.equal(
  claimMfg,
  ManufacturerCode.BepMarine2,
  `address claim mfg should be BepMarine2 (got ${claimMfg})`
)
console.log('emulator created with NAME-MFG=BepMarine2 (=295): OK')

// Product info productCode
const productCode = emu.productInfo?.fields?.productCode
assert.equal(
  productCode,
  8395,
  `productCode should be 8395 (COI), got ${productCode}`
)
console.log('product info productCode=8395 (COI): OK')

// Wait for the next heartbeat after emulator attached, then check that
// at least one PGN 65284 frame was sent through the emulator's .send().
await new Promise((r) => setTimeout(r, 2200))

const sentPgns = emu.sent
  .map((s) => s.split(',')[2])
  .filter((p) => p === '65284' || p === '65290' || p === '130817')
assert.ok(
  sentPgns.length > 0,
  `expected at least one CZone heartbeat PGN through emulator.send, got ${sentPgns.length}`
)
console.log(
  `emulator.send received ${sentPgns.length} CZone frames (${[
    ...new Set(sentPgns)
  ].sort().join(', ')}): OK`
)

// Inject an inbound PGN 65280 ON command via the emulator's onPGN; the
// plugin should treat it as a circuit-control and toggle the matching
// switch on.
const initialState = app.selfState[SWITCH_PATHS[0]]?.value
emu.injectInbound({
  pgn: 65280,
  src: 5,
  fields: { Data: '0d 00 00 00 01 00' }
})
await new Promise((r) => setTimeout(r, 30))
assert.deepEqual(
  app.selfState[SWITCH_PATHS[0]],
  { value: 1 },
  `inbound 65280 via emulator should set switch 1 = 1 (was ${initialState})`
)
console.log('inbound 65280 via emulator -> switch 1 = 1: OK')

// Inject an inbound 65299 query and expect a 130820 reply through the
// emulator's send.
emu.sent.length = 0
emu.injectInbound({
  pgn: 65299,
  src: 5,
  fields: { Data: '18 00 00 80 ff ff' }
})
await new Promise((r) => setTimeout(r, 30))
const replies = emu.sent
  .map((s) => s.split(','))
  .filter((p) => p[2] === '130820')
assert.ok(
  replies.length > 0,
  `expected a 130820 reply via emulator, got ${emu.sent.length} frames`
)
console.log('inbound 65299 via emulator -> 130820 reply: OK')

plugin.stop()
console.log('\nemulator integration test: PASS')
