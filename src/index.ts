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

export default function (app: any) {
  const error = app.error
  const debug = app.debug
  let props: any
  let onStop: any = []
  let switchBanks: any = {}

  const plugin: Plugin = {
    start: function (properties: any) {
      props = properties

      if ( !props?.banks || !props.banks.length ) {
        return
      }

      props.banks.forEach((bank: any) => {
        if ( !bank.switches || !bank.switches.length ) {
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
            const pgn = makeBinaryStatusReport(bank)

            delta.updates?.forEach((update: any) => {
              update.values?.forEach((vp: any) => {
                pgn[`Indicator${bank.switches.indexOf(vp.path) + 1}`] =
                  vp.value === 1 || vp.value === true ? 'On' : 'Off'
              })
            })
            debug('sending %j', pgn)
            app.emit('nmea2000JsonOut', pgn)
          }
        )
        if (bank.sendRate) {
          const interval = setInterval(
            () => {
              const pgn = makeBinaryStatusReport(bank)
              debug('sending update %j', pgn)
              app.emit('nmea2000JsonOut', pgn)
            },
            bank.sendRate * 1000
          )
          onStop.push(() => clearInterval(interval))
        }
      })

      const n2kCallback = (msg: any) => {
        try {
          if (msg.pgn == 127502) {
            const instance = msg.fields['Switch Bank Instance']
            const paths = switchBanks[instance]
            if (paths) {
              debug('msg: ' + JSON.stringify(msg))

              for (let i = 1; i < 29; i++) {
                const val = msg.fields[`Switch${i}`]
                if (typeof val !== 'undefined') {
                  if (paths.length < i - 1) {
                    error(`no path for switch ${i} bank ${instance}`)
                  } else {
                    debug(`Switch ${i} ${val}`)
                    app.putSelfPath(paths[i - 1], val === 'On' ? 1 : 0)
                  }
                }
              }
            }
          }
        } catch (e) {
          error(e)
        }
      }
      app.on('N2KAnalyzerOut', n2kCallback)
      onStop.push(() => app.removeListener('N2KAnalyzerOut', n2kCallback))
    },

    stop: function () {
      onStop.forEach((f: any) => f())
      onStop = []
    },

    id: 'signalk-n2k-switching-emulator',
    name: 'NMEA 2000 Siwtching Emulator',
    description:
      'Signal K Plugin which makes existing switches in sk available as n2k switches',

    schema: () => {
      let paths = app.streambundle.getAvailablePaths()
          .filter((path:any) => path && path.startsWith('electrical.switches.') && path.endsWith('.state'))
      
      if ( props ) {
        props.banks?.forEach((bank:any) => {
          bank.switches?.forEach((sw:any) => {
            if ( paths.indexOf(sw) === -1 ) {
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
                  description: 'Rate (in seconds) to send to N2K (set to 0 to not send updates)',
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
                }
              }
            }
          }
        }
      }
    }
  }
  
  function makeBinaryStatusReport (bank: any) {
    const pgn: any = {
      pgn: 127501,
      'Switch Bank Instance': bank.instance,
      "Instance": bank.instance
    }
    bank.switches?.forEach((sw: any, index: number) => {
      const value = app.getSelfPath(sw)
      if (value && typeof value.value !== 'undefined') {
        pgn[`Indicator${index + 1}`] =
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
}
