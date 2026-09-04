# The HTTP contract

**You do not implement any of this.** `@soundbase/plugin-shell` serves every
endpoint on this page and calls your adapter. It is documented because it is
the compatibility boundary, because it is what you `curl` when something is
wrong, and because a plugin in another language would have to implement it.

Normative sources, installed with your dependencies:

```
node_modules/@soundbase/plugin-contract/spec/core.openapi.yaml
node_modules/@soundbase/plugin-contract/spec/spectrum-analyzer.openapi.yaml
```

## The shape of it

- **Loopback only.** `127.0.0.1`, on an ephemeral port the OS picks.
- **Announced on stdout.** The process's first line of output is
  `SB_PLUGIN_READY {"port":54321}`. Every later stdout line is a log line the
  host captures.
- **Bearer token per spawn.** The host generates one and passes it as
  `SB_PLUGIN_TOKEN`; every request except `GET /health` needs
  `Authorization: Bearer <token>`. **With `SB_PLUGIN_TOKEN` unset — a plugin
  you started by hand — authentication is disabled**, which is what makes
  `curl` during development easy.
- **Units.** Every frequency in hertz, including RBW, VBW and step size. Every
  amplitude in dBm.
- **Forward compatible.** Unknown modules and unknown properties are tolerated
  on both sides.

## Core API

### `GET /health`

The only unauthenticated endpoint. The host polls it every 5 seconds and treats
three consecutive failures as a crash.

```json
{ "ok": true, "uptimeMs": 41231 }
```

### `GET /info`

```json
{
  "id": "acme-network",
  "name": "Acme Networked Analyzer",
  "version": "0.1.0",
  "contract": { "core": "1.0", "modules": { "SpectrumAnalyzer": "1.0" } },
  "status": { "status": "ok" }
}
```

Statuses are `connecting`, `ok`, `failed`, `bad-config` — and, for devices
only, `disconnected`. `bad-config` means the supplied configuration cannot
work; `failed` is a runtime failure worth retrying.

### `GET /devices`

Host-added devices plus whatever your plugin has discovered.

```json
{ "devices": [
  { "id": "net:192.168.1.50", "name": "SA-3000 (192.168.1.50)",
    "product": "plugin:acme-network/sa-3000",
    "status": { "status": "ok" }, "discovered": true,
    "transport": { "kind": "network", "host": "192.168.1.50", "port": 5025 },
    "capabilities": { "minFrequencyHz": 9000, "…": "…" } }
] }
```

Calling this is also the host's "I am enumerating" signal: it opens a **60
second discovery window** during which your `discoverDevices` is polled once a
second and `device-added` / `device-removed` events are emitted. Outside a
window there is no discovery I/O at all.

`capabilities` is absent until the device has been opened, and a *discovered*
device is not opened until something asks it to do work.

### `POST /devices`

Add a device the user configured by hand. Addressing comes from the SoundBase
project, in the request — never from the plugin's own machine-local state.

```json
{ "id": "net:192.168.1.50",
  "product": "plugin:acme-network/sa-3000",
  "config": { "host": "192.168.1.50", "port": 5025 } }
```

`201` when created, `200` when it already existed. Idempotent: re-adding the
same id with an equivalent config changes nothing; with a different config it
reopens the device. Host-added devices are opened eagerly, so a wrong address
surfaces immediately as a failed device.

`DELETE /devices` removes every host-added device (project switch, shutdown).
Discovered devices are unaffected — they describe hardware that is present, not
hardware in use. `DELETE /devices/{id}` removes one.

### `PUT /config`

```json
{ "values": { "addresses": "192.168.1.50, 192.168.1.51" } }
```

The values of your `pluginConfigFields`. The **first** call after the process
starts is what brings the plugin up — the shell calls `init(values)`; every
later call is `configUpdated(values)`. A plugin needing no configuration is
fully usable with no call at all.

### `GET /events`

`text/event-stream`, carrying **lifecycle only**: `device-added`,
`device-removed`, `device-status`, `plugin-status`, `config-changed`. A
`: keepalive` comment every 15 seconds distinguishes a silent stream from a
dead one.

**Measurement data never travels here.** Traces are pulled from
`GET /devices/{id}/trace`.

## SpectrumAnalyzer module

All paths are per device: `/devices/{deviceId}/…`, with each path segment
percent-encoded (`net:192.168.1.50` → `net%3A192.168.1.50`).

### `POST /devices/{id}/configuration`

Every field optional; only the fields present change.

```json
{ "startHz": 470000000, "stopHz": 616000000,
  "pointCount": 401, "rbwHz": 100000,
  "traceMode": "max-hold",
  "controls": { "attenDb": 10, "detector": "peak" } }
```

Responds with the **effective** configuration after clamping:

```json
{ "startHz": 470000000, "stopHz": 616000000,
  "centerHz": 543000000, "spanHz": 146000000,
  "pointCount": 401, "stepHz": 365000,
  "rbwHz": 100000, "traceMode": "max-hold",
  "controls": { "attenDb": 10, "detector": "peak" },
  "resolved": { "vbwHz": 30000 } }
```

- When both `startHz` and `stopHz` are given they win over `centerHz`/`spanHz`;
  responses echo all four consistently.
- `pointCount` wins over `stepHz`; responses echo both.
- Omitting `rbwHz` means auto — what the analyzer chose appears under
  `resolved`, while `rbwHz` itself stays absent.
- `controls` is merged by id, so a request carrying one knob leaves the others
  in force. An explicit `null` is a value, not an erasure.
- Overlapping requests **coalesce to the latest**; intermediate configurations
  are dropped and traces produced mid-reconfigure are discarded, so a trace is
  never labelled with a configuration that did not produce it.

`GET` on the same path reads it back, or `409 not_configured` if it never has
been.

### `POST /devices/{id}/sweep/start` and `/stop`

```json
{ "sweeping": true, "sweepId": 128 }
```

Starting a device that is already sweeping is a no-op that still returns `200`.
Stopping leaves the most recent trace available.

### `GET /devices/{id}/trace`

**Long-polled.** The host issues the next request immediately after each
response, with no delay. The plugin holds the response open until a sweep newer
than the one it last served completes, capping the hold at 5 seconds and then
returning the most recent trace regardless. The poll rate therefore matches the
hardware with nothing to tune.

`?sinceSweepId=127` makes the comparison explicit — useful for a second client
or after a host restart.

```json
{ "startHz": 470000000, "stopHz": 616000000, "stepHz": 36500000,
  "pointCount": 5, "sweepId": 128,
  "timestamp": "2026-05-21T12:00:00Z", "unit": "dBm",
  "amplitudesDbm": [-95.2, -88.1, -101.4, -76.9, -98.7] }
```

- `amplitudesDbm.length` **must** equal `pointCount`.
- Point `i` sits at `startHz + i * (stopHz - startHz) / (pointCount - 1)`.
- `sweepId` increments by 1 per completed sweep, so a jump tells the host it
  skipped sweeps. For `max-hold` and `min-hold` the shell accumulates at the
  device's full rate, so nothing is lost regardless of poll rate.
- `409 no_trace` until the first sweep completes.
- Optional `series` adds named curves sharing the same axis — per-antenna
  traces, say. Single-curve plugins omit it.

## Errors

```json
{ "error": "device_unavailable", "detail": "Serial port /dev/tty.usbmodem401 is no longer present." }
```

| Status | | |
|---|---|---|
| `400` | `bad_request`, `unknown_product`, `bad_config` | malformed, or naming something undeclared |
| `401` | `unauthorized` | missing or wrong bearer token |
| `404` | `unknown_device`, `not_found` | |
| `409` | `not_configured`, `no_trace` | the operation is valid but too early |
| `501` | `module_not_supported` | the plugin does not implement the module |
| `502` | `bad_adapter_config` | `applyConfig` returned no `startHz`/`stopHz`/`pointCount` |
| `503` | `device_unavailable` | the plugin is running but cannot reach the hardware |

## Poking at a running plugin

```bash
npm start                 # note the port from the handshake line
PORT=54321
DEV=synthetic%3A1

curl -s localhost:$PORT/health
curl -s localhost:$PORT/info
curl -s localhost:$PORT/devices

curl -s -X POST localhost:$PORT/devices/$DEV/configuration \
  -H 'content-type: application/json' \
  -d '{"startHz":470000000,"stopHz":616000000,"pointCount":11}'
curl -s -X POST localhost:$PORT/devices/$DEV/sweep/start
curl -s localhost:$PORT/devices/$DEV/trace
curl -N localhost:$PORT/events        # watch lifecycle events
```

Add `-H "Authorization: Bearer $SB_PLUGIN_TOKEN"` if you started the plugin
with a token set.
