# signalk-n2k-switching-emulator
Signal K Plugin which makes existing switches in sk available as n2k switches

The plugin sends out pgn 127501 for the configured banks/switches and accepts
pgn 127502 to change the switches.

For compatibility with Maretron devices and MFDs, the plugin also accepts a
pgn 126208 Command Group Function whose commanded PGN is 127501. When such
a command is received, each pair in the command maps to a channel in the
indicated switch bank:

- parameter 1 carries the Indicator Bank Instance
- parameter N (for N in 2..29) carries the new status of channel N - 1

After applying the update, the plugin replies with a pgn 126208 Acknowledge
Group Function addressed to the sender.

The plugin also responds to pgn 59904 ISO Request when the requested PGN is
127501. On receipt it immediately broadcasts a pgn 127501 Binary Status
Report for every configured switch bank, so MFDs can pull the current state
on demand without waiting for the next periodic send.

## CZone emulation

In addition to standard NMEA 2000 switching, the plugin can publish one
bank as a Navico CZone-compatible module so plotters such as Zeus, GO and
Axiom display it on their CZone screen.

### Mental model

A CZone module is one NMEA 2000 device, identified by a single 8-bit
dipswitch value. The MFD holds a `.zcf` configuration file that maps
each circuit it knows about to a `(dipswitch, channel)` pair: the
dipswitch picks the module, the channel picks the switch on that module.
At runtime the MFD broadcasts circuit-control commands and each module
acts on commands whose dipswitch matches its own.

This plugin emulates one such module. It does not generate or distribute
the `.zcf` itself — you create that with Mastervolt's CZone Configuration
Tool or use a ready-made one (Yacht Devices ships one for the YDAB-01
that works with B&G plotters), and you upload it to the MFD via the MFD's
normal CZone configuration flow.

### Configuration

Three per-bank fields, all under `banks[i]`:

| Field | Default | Notes |
|---|---|---|
| `czoneEnabled` | `false` | Set to `true` to publish this bank as a CZone module. |
| `czoneDipswitch` | `"00011000"` | Eight-character binary string, leftmost char = position 1 (bit 0). Must match the dipswitch the `.zcf` assigns to this module. Each enabled bank must use a distinct dipswitch. |
| `czoneFirstCircuitId` | `13` | The first circuit id the `.zcf` gave this module. Switch 1 = this id, switch 2 = id+1, etc. The Yacht Devices YDAB-01 uses 13; configurations created from scratch in the CZone Configuration Tool can use any value. |

Each enabled bank exposes up to six switches as one CZone module —
that is the standard module size. Multiple enabled banks become
multiple modules on the bus, each with its own dipswitch.

### What goes on the bus

When `czoneEnabled` is set on a bank and the plugin starts, it sends:

| PGN | Direction | Cadence | Purpose |
|---|---|---|---|
| 65290 | TX once | startup | CZone announce (unique id + dipswitch) |
| 65284 | TX | 2 s | Circuit-state bitmap |
| 130817 | TX | 2 s | Status Extended (per-circuit state record) |
| 65280 | RX | on command | MFD circuit-control command (on/off per circuit id) |
| 65284 | RX | on query | MFD bitmap query (`27 99 C8 10 …` payload) |

Inbound circuit-control commands carry an absolute circuit id from the
`.zcf`. The plugin subtracts the bank's `czoneFirstCircuitId` to get a
0-based switch index, then writes `1` or `0` to the matching switch
path via `app.putSelfPath`, so a downstream plugin (relay driver,
etc.) can turn the actual load on or off.

### Dipswitch and `.zcf` matching

The MFD uses the dipswitch in your `.zcf` to address a specific module.
Three rules follow from that:

1. **The plugin's `dipswitch` must match the dipswitch the `.zcf`
   assigns to this module.** If they differ the MFD's commands target
   a different dipswitch and the plugin never sees them.
2. **Two devices on the bus must not share the same dipswitch.** If a
   real CZone module is on the bus with the dipswitch you've configured
   here, both devices will broadcast circuit state for the same
   dipswitch and the MFD will see conflicting statuses. Either change
   the plugin's dipswitch (and load a `.zcf` matching the new value),
   or disconnect the conflicting hardware module before enabling
   emulation.
3. **You can leave a real CZone module physically connected** as long
   as you upload a `.zcf` whose dipswitch differs from the real
   module's — the MFD will simply stop addressing it.

When testing, give the emulated circuits clearly different labels in
the `.zcf` from anything in your existing setup. That way the MFD
visibly switches to the new configuration once you upload it, which
makes it obvious whether you're seeing the emulator or the old
hardware.

### Finding the circuit IDs in your `.zcf`

The plugin's `czoneFirstCircuitId` field has to match the first circuit id
that your `.zcf` assigns to this module. There are three ways to find it:

1. **Open the `.zcf` in the CZone Configuration Tool** and read the values
   off the Circuits tab.
2. **Watch the bus.** When a Navico plotter loads a `.zcf` it broadcasts
   the file as PGN 130816 chunks. The plugin reassembles those chunks,
   saves the resulting `.zcf` to the plugin's data directory as
   `last-czone.zcf`, parses out the circuit list, and logs it via the
   plugin's debug channel and provider status. No upload UI required —
   just have the plugin running while the plotter is loading or
   distributing a `.zcf`.
3. **Run the bundled CLI** on a `.zcf` you already have on disk:

```
node tools/zcf-info.mjs path/to/your.zcf [--strings]
```

The CLI uses the same parser as the runtime listener, so its output is
identical to what the plugin would log when it sees the same `.zcf` on
the bus.

Sample output for `Test.zcf`:

```
zcf:    /path/to/Test.zcf
size:   781 bytes

format version byte: 0x06

circuit_id  name
         1  Bilge Pump
         2  Fridge
         4  Freezer

first circuit id: 1
circuit ids are NOT contiguous (range 1..4, 3 circuits). The plugin's
czoneFirstCircuitId expects a contiguous run; either reconfigure your
.zcf so the circuits used by this module have sequential ids, or pick
a starting id and accept that gaps map to "no switch".

dipswitch: open the .zcf in the CZone Configuration Tool, click the
Modules tab, and read the dipswitch from there. Convert it to the
plugin's binary-string form by writing positions 1..8 as '1' (on) or
'0' (off), leftmost = position 1.
```

What it does:

- Lists every circuit by `(circuit_id, name)`.
- Prints the first circuit id, suggesting it as `czoneFirstCircuitId`.
- Warns when the circuit ids are not contiguous — the plugin maps a
  bank's switches to consecutive circuit ids starting from
  `czoneFirstCircuitId`, so non-contiguous ids need either a
  reconfigured `.zcf` or padding the bank's `switches` array with
  unused entries to skip the gaps.
- Pass `--strings` to also dump every length-prefixed string the
  scanner found in the file (useful for sanity-checking which `.zcf`
  you're looking at).

What it does not do:

- It is a heuristic parser, not a full `.zcf` parser. The format is
  proprietary and the tool relies on the typical layout that the CZone
  Configuration Tool emits for small switching configurations. Files
  with extensive HVAC, audio, modes, alarms or custom-PGN sections may
  confuse it.
- It does not extract the dipswitch — the tool tells you to read it
  from the CZone Configuration Tool's Modules tab. Adding dipswitch
  detection requires a deeper format walk than this scanner does.
- It does not modify the `.zcf`.

If the output looks wrong on your file, configure the plugin manually
from the CZone Configuration Tool UI and (if you'd like) attach the
`.zcf` to an issue so we can improve the heuristic.

### Side-bar control on Navico displays

To make the emulated switches appear on the Navico Control Bar (the
side-bar on Zeus / NSS / GO), follow Navico's standard procedure for
adding third-party Switch Bank Control devices to a CZone
configuration:

1. In the CZone Configuration Tool, open the **Advanced → Third-Party
   Devices** tab and add a Switch Bank PGN Control entry. Pick a
   Switch Bank supported module type (C1, MOI, OI, etc.), set a
   unique Switch Bank Instance, and tick *Enable advanced CZone
   remote control switch functions*.
2. On the **Circuits** tab, add a Switch Bank circuit control to each
   circuit you want the side-bar to drive (Switch Type:
   Single Throw Momentary, Switch Output Function: Toggle).
3. Write the updated configuration to the network.
4. On the MFD, enable *Settings → System → Advanced → Digital
   Switching* and CZone, then add the Control Bar to the side-bar
   layout.

The plugin itself is unchanged by this — it just publishes the
module so the MFD can address it. All UI configuration happens in
the CZone Configuration Tool.

#### Verifying the side-bar without an MFD

The side-bar surface uses two standard NMEA 2000 PGNs that are
independent of the CZone MFG=295 gate:

- PGN 127501 (Binary Status Report) — current on/off state
- PGN 130060 (Suggested Metadata) — per-switch labels

Either listen for them on the bus directly, or run the
[czone-spec stubplotter](https://github.com/dirkwa/czone-spec/tree/main/stubplotter)
rig — its `switchbank_status_present` and `sidebar_labels_present`
tests pass when these two PGNs appear within their windows. The rig
ships a `make smoke` target that drives a fresh signalk-server +
this plugin against vcan and reports pass/fail per spec rule.

### Generating a `.zcf` from the plugin's switch list

The plugin can synthesise a `.zcf` from its configured switches and
hand it to you as a download. You then either open it in the
CZone Configuration Tool to inspect / save it, or upload it to the
MFD via the MFD's normal SD-card / USB / network upload flow.

```
http://<your-signalk-host>:3000/plugins/signalk-n2k-switching-emulator/zcf?bank=0
```

(Add `?bank=N` to pick a specific bank; defaults to bank 0.) The
response is a binary `.zcf` named after the bank's
`czoneModuleName` (or `signalk-bank-<instance>` if unset).

What gets put in the file:

- **config name** = `czoneConfigName` (defaults to
  `SignalK Switching <instance>`)
- **two module records**:
  1. an **Output Interface** (or **Combination Output Interface /
     Contact 6 / CXP**, depending on `czoneModuleType`) =
     `(czoneDipswitch, czoneModuleName)`. Pick the type matching
     your real hardware (look at the part-number sticker
     `80-911-NNNN-NN` on the module):
     - `oi` (default) — Output Interface, 6 outputs DC1..DC6
       (parts 80-911-0009-00 / -0010-00). `m1=0x0f`.
     - `coi` — modern Combination Output Interface, **16 outputs**
       (4 high-current DC1..DC4 + 12 dimmable DC5..DC16, 150A
       max). Part 80-911-0119-00. `m1=0x1c`.
     - `contact6` — Contact 6 / Contact 6 Plus dry-contact
       module, 6 outputs C1..C6. Parts 80-911-0140-00 /
       -0160-00. `m1=0x09`.
     - `cxp` — CXP load module, 13 outputs. `m1=0x36`.
  2. a **Display Interface** record (`m1=0x10`) carried over from
     the bundled template. The Configuration Tool's "Module
     Configuration" tree shows both, and the per-circuit
     "All Display Interfaces" Circuit Control wildcard binds
     against the Display Interface's presence (without it the
     side-bar control on Navico displays doesn't bind).
- **at least 3 circuits** — one per configured switch path, named
  via the path's SignalK `meta.displayName` (or the path's last
  segment, prettified). When fewer than 3 switches are configured
  the generator pads with placeholder circuits ("Spare DC2",
  "Spare DC3") so the Configuration Tool doesn't synthesise
  "DC{n} - Paralleled with DC1" rows. Each circuit gets a
  leading wildcard output (`channel_address = 0x0000`) for
  "All Display Interfaces" plus a real physical-output entry at
  `(dipswitch << 8) | (0x1e + offset)`.
- **per-circuit Sub-Category** comes from the optional
  `czoneSubCategories` field — one of `none`, `house-habitat`,
  `navigation`, `communications`, `lighting`, `pumps`,
  `refrigeration`. Drives the Configuration Tool's "Circuit Menu
  Sub-Categories" checkboxes.
- **circuit ids** start at `czoneFirstCircuitId` and run consecutively
  (so the ids the MFD sees match what the running plugin handles for
  inbound PGN 65280 commands).
- **Switch Bank Instance** in the Configuration Tool's Switch Bank
  PGN config = the bank's `instance` setting.

The file is a byte-identical mutation of a known-good template
(`templates/template.zcf`, which is the bundled `Test.zcf` sample
from czone-spec). All structural fields the plugin doesn't
explicitly set are preserved verbatim from the template, so the
file passes parse-time CRC and structural checks. The plugin's
test suite locks in byte-identity round-trip for three real `.zcf`
samples (Test.zcf, config-6.zcf, CompassRose.zcf — 781 / 1014 /
6384 bytes) so the encoder can't silently drift.

**Caveat:** "passes parse" is not the same as "the CZone
Configuration Tool will open this without complaint" or "the MFD
will accept this as a config". The encoder is byte-perfect against
real files; whether the produced *combination* of fields is one
the tool / MFD recognises is the next thing to validate. Plan: open
a generated file in the CZone Configuration Tool and report what it
says. If the tool accepts it, the MFD upload path is the next test.

#### Verifying the download locally

Quickest check — fetch the file and inspect it with the bundled
heuristic parser (the same scanner the runtime uses on inbound
PGN 130816):

```bash
curl -O "http://localhost:3000/plugins/signalk-n2k-switching-emulator/zcf?bank=0"
node -e "
  const { parseZcf } = require('signalk-n2k-switching-emulator/dist/zcfParser.js');
  const buf = require('fs').readFileSync('signalk-bank-0.zcf');
  const s = parseZcf(buf);
  console.log('circuits:', s.circuits.length, 'first:', s.firstCircuitId, 'contiguous:', s.contiguous);
  for (const c of s.circuits) console.log(' ', c.circuitId, c.name);
"
```

The expected output: one circuit per configured switch, `firstId`
matches your `czoneFirstCircuitId`, contiguous ids.

End-to-end against a fresh signalk-server in a sandbox:

```bash
cd /path/to/czone-spec/stubplotter
eval "$(./setup.sh)"
make smoke      # installs SK + plugin, drives the rig + downloads & parses the .zcf
./teardown.sh
```

`make smoke` already covers all the on-bus PGN-level rules (CZone
MFG=295 gate, heartbeat regularity, switch-command round-trip, the
side-bar PGNs, the PGN 130816 push). With the new endpoint check it
now also asserts the synthesized `.zcf` parses cleanly and contains
the bank's switches at the expected ids.

### Pushing a `.zcf` from the plugin (experimental)

When the plugin is enabled with `czoneZcfPushEnabled: true`, it
exposes a SignalK PUT endpoint at `electrical.czone.pushZcf` that
broadcasts a `.zcf` to the bus as PGN 130816 fast-packet sequences
(N×200 bytes + optional partial chunk + zero-byte terminator,
matching what a real Zeus 3S plotter does per
`czone-spec/spec/pgn-130816.md` "Frame layout"). The frames go out
from the first CZone-enabled bank's source address.

This is intended for testing — driving the plugin's own
PGN 130816 reassembler from another node, populating a stubplotter
listener with a known `.zcf`, or feeding a development MFD without
the SD-card / USB upload dance. Whether a real plotter accepts a
non-plotter-originated `.zcf` as a config replacement has not been
pinned down by the spec; expect that production plotters reject
it. **Default is off.**

How to use it:

1. In the plugin settings, tick **Enable .zcf push to the CZone
   bus (experimental)**.
2. Base64-encode your `.zcf`:

   ```bash
   base64 -w0 path/to/your.zcf > zcf.b64
   ```

3. Issue a SignalK PUT against `vessels.self` with the path
   `electrical.czone.pushZcf`:

   ```bash
   curl -X PUT \
     -H 'Content-Type: application/json' \
     -d "{\"value\": \"$(cat zcf.b64)\"}" \
     http://localhost:3000/signalk/v1/api/vessels/self/electrical/czone/pushZcf
   ```

   (Add the appropriate auth headers if your server requires them.)

The handler validates that the payload looks like a `.zcf`
(non-empty, length-prefixed strings present), then chunks and
broadcasts it. The response carries `state: "COMPLETED"` plus a
status code: 200 on success, 400 on a malformed payload, 403 when
the toggle is off, 500 if no CZone-enabled bank is configured.

### Limitations

- Up to six switches per CZone-enabled bank — the standard CZone
  module size. Banks with more than six paths are still served as a
  normal NMEA 2000 switch bank, but only the first six surface under
  the CZone identity.
- The plugin does not implement the `.zcf` distribution PGNs
  (130818/130819/130821). Configure the MFD with your `.zcf` through
  the existing CZone tooling.
