# Adapter reference

`adapter.js` is the file you write. Everything on this page is what the shell
calls, what it passes, and what it does with what you return.

The normative sources are
`node_modules/@soundbase/plugin-contract/spec/spectrum-analyzer.openapi.yaml`
and, for monitored devices, `channel-monitoring.openapi.yaml` and
`property-control.openapi.yaml` beside it. Where this page and those
documents disagree, the documents are right.

## The exports

```js
export async function discoverDevices(pluginConfig) → Device[]

// one factory per module; export the ones your products need
export function createSpectrumAnalyzerAdapter(device, pluginConfig) → Adapter
export function createMonitoringAdapter(device, pluginConfig) → MonitoringAdapter
```

`main.js` wires whichever factories exist and does nothing else. Which one a
device gets is decided by its product's manifest `capabilities`:
`spectrumAnalyzer` opens the spectrum-analyzer adapter, anything else
(`meters`, `frequency`, `receivers`, …) opens the monitoring adapter, and a
product with both gets both. A plugin that serves only one kind of device
exports only that factory. Do not add other exports expecting the shell to
call them.

---

## `discoverDevices(pluginConfig)`

Hardware this plugin can see right now.

```js
export async function discoverDevices(pluginConfig) {
  return [
    {
      id: 'usb:/dev/tty.usbmodem401',       // required, stable across restarts
      name: 'tinySA Ultra',                 // shown in the picker
      product: 'plugin:my-id/tinysa-ultra', // must be declared in the manifest
      transport: { kind: 'usb', path: '/dev/tty.usbmodem401' },
    },
  ];
}
```

| Field | | |
|---|---|---|
| `id` | required | Unique within your plugin and **stable across restarts**. It goes into URLs and into the user's saved project. `usb:<path>` and `net:<host>` are the conventions the first-party plugins use. |
| `name` | optional | Display name. Falls back to the product's `displayName`. |
| `product` | required in practice | A `deviceTypeId` from your manifest. A device naming an undeclared product is logged as a warning and ignored. |
| `transport` | optional | Free-form addressing detail, shown to the user. `{ kind, path }`, `{ kind, host, port }`. |

**When it is called.** Once per second, but only while an *enumeration window*
is open — SoundBase opens one for 60 seconds each time it lists devices, and
the window is held open while any device has a transport open. Outside a
window it is never called at all, so an idle plugin does no discovery I/O.

**Rules.**

- Return quickly. You are on a one-second cadence, and blocking here stalls
  the device picker.
- **An address with nothing on it is a normal, empty result.** Do not throw;
  do not log an error per poll. Users type addresses that are wrong.
- Do not open devices here. Probe if you must (open, ask for identity, close),
  but leave them closed.
- Returning nothing is fine and common: a plugin whose devices are always
  configured by hand can `return []` and let `POST /devices` do the work.

`pluginConfig` holds the values of your manifest's `pluginConfigFields`. For a
network plugin this is usually where the addresses to probe come from — there
is no broadcast discovery for an instrument on an arbitrary subnet.

---

## `createSpectrumAnalyzerAdapter(device, pluginConfig)`

Called once per device, the first time that device has to do anything. Returns
an object with five methods. It is not async and should not do I/O — just
construct.

```js
device = {
  id: 'net:192.168.1.50',
  product: 'plugin:my-id/sa-3000',
  config: { host: '192.168.1.50', port: 5025 },  // your deviceConfigFields
}
```

**`device.config` is where addressing comes from.** It arrives from the
SoundBase project, filled in by the user through the fields your manifest
declares. Never read a device address from a file beside your plugin: the same
project will be opened on a different machine, and that machine has never seen
your configuration.

### `open()` → `{ capabilities, identity }`

Connect and identify. Everything SoundBase will let the user ask for is
constrained by what you return here, so report what *this unit* can do, not
what the product line can do.

```js
async open() {
  await this.client.connect();
  const { model, firmware } = await this.client.identify();
  return {
    capabilities: {
      minFrequencyHz: 9_000,
      maxFrequencyHz: 3_000_000_000,
      rbwHz: [1_000, 10_000, 100_000, 1_000_000],
      controls: [ /* see below */ ],
    },
    identity: { model, firmware },
  };
}
```

**Capabilities**

| | |
|---|---|
| `minFrequencyHz`, `maxFrequencyHz` | the tuning range |
| `rbwHz` | discrete resolution bandwidths, in Hz. Omit if RBW is continuous. |
| `vbwHz` | discrete video bandwidths. Omit if continuous or unsupported. |
| `minRefLevelDbm`, `maxRefLevelDbm` | reference level range |
| `minStepHz`, `maxStepHz` | point-spacing limits |
| `traceModes` | **do not set this.** The shell overwrites it with all four modes, because it accumulates them in software. |
| `controls` | extra knobs — see [Device controls](#device-controls) |

Throwing marks the device `failed` with your message and reports `503` to the
host. That is the correct outcome for "the cable is not plugged in". Make the
message specific enough to act on.

### `applyConfig(cfg)` → effective configuration

The most subtle method, and the one worth reading twice.

**What you receive.** Only fields the host actually wants changed, already
normalised by the shell:

```js
cfg = {
  startHz?, stopHz?,       // center/span has already been converted to these
  pointCount?, stepHz?,    // pointCount wins when both were supplied
  rbwHz?, vbwHz?, refLevelDbm?,
  controls?: { … },        // merged by id, not replaced
}
```

`traceMode` never reaches you — the shell owns it.

**What you return.** The configuration that is *actually in force*, after
clamping to what the hardware accepted:

```js
return {
  startHz, stopHz, pointCount,   // required — a missing one is a 502
  rbwHz?,                        // what you settled on
  controls?: { … },              // what each knob settled on
  resolved?: { rbwHz: 10_000 },  // what an *automatic* request resolved to
};
```

The shell fills in `centerHz`, `spanHz`, `stepHz` and `traceMode` from those,
and the whole object becomes what `GET /devices/{id}/configuration` reports.

**The three rules**

1. **Clamp, do not reject.** Out-of-range values snap to what the hardware can
   do. A `400` makes a working plugin look broken; the SoundBase form keeps
   showing the user's saved value either way, so a rejection communicates
   nothing and a clamp communicates everything.
2. **Echo what happened, not what was asked.** The return value is the only
   channel by which the host can learn what is really in force.
3. **Absent means unchanged.** `cfg` is a patch. If `rbwHz` is absent, leave
   the bandwidth alone; if `controls` carries one key, the others stay as they
   were.

**Automatic values.** Omitting `rbwHz` entirely means "the analyzer's choice".
Report what it chose under `resolved` rather than inventing a value for
`rbwHz` — that keeps the user's field showing *auto* while still telling them
what auto meant.

```js
const [rbw] = await this.client.setting('RBW AUTO');
return { startHz, stopHz, pointCount, resolved: { rbwHz: Number(rbw) } };
```

**Overlapping calls coalesce.** While one configuration is being applied, a
newer request supersedes any still-pending one; intermediate configurations are
dropped rather than queued, and traces produced mid-reconfigure are discarded.
You do not have to serialise anything yourself, but you should expect
`applyConfig` to be abandoned in favour of a newer one — someone dragging a
zoom on the plot generates a burst of them.

### `startSweep(onTrace)`

Sweep continuously, calling `onTrace(amplitudesDbm)` once per **completed**
sweep.

```js
async startSweep(onTrace) {
  if (this.sweeping) return;      // starting twice is a no-op, not an error
  this.sweeping = true;
  (async () => {
    while (this.sweeping) {
      try {
        onTrace(await this.client.sweep());
      } catch (err) {
        if (this.sweeping) this.onFatal?.(err);
        return;
      }
    }
  })();
}
```

`onTrace` takes one argument: an array of numbers in **dBm**, `pointCount`
long, ordered from `startHz` to `stopHz`. Nothing else. The shell builds the
frequency axis, the sweep id, the timestamp and the trace-mode accumulation
from the effective configuration.

- **Length must equal `pointCount`.** The host draws `pointCount` of them; a
  mismatch is the classic cause of a trace that looks right but is shifted in
  frequency.
- **Never emit a partial sweep.** A half-finished sweep padded to length draws
  a cliff on the plot.
- Prefer a loop over `setInterval`: an instrument slower than the interval will
  otherwise pile up overlapping reads on one transport.
- Do not accumulate max-hold or averaging yourself. The shell does it, at your
  full sweep rate, which is the only place it can be done without losing a
  transient nobody happened to poll for.

### `stopSweep()`

Stop sweeping. Called on user request and before teardown. Must be safe to
call when not sweeping. The most recent trace stays available.

### `close()`

Release the transport. Called when the device is removed, when the plugin
shuts down, and after a fatal error. Must be idempotent and must not throw.

### `onFatal` (assigned to you)

The shell assigns this property; you call it. It is how a device that has died
stops claiming to be healthy.

```js
this.client.on('close', () => this.onFatal?.(new Error('serial port closed')));
```

Calling it marks the device `failed` with your message, stops the sweep and
closes the adapter — without taking the process down. The device reopens on the
next operation.

Use it for the transport dying **unprompted**: unplugged, powered off,
connection reset. Not for a bad parameter, and not for a `close()` you asked
for yourself.

### `onWarnings` (assigned to you) — core 1.1

Conditions worth a person's attention that are not failures. The shell
assigns this property; you call it with the **complete current set** whenever
it changes:

```js
this.onWarnings?.([
  { id: 'overload', severity: 'warning',
    message: 'Input overload: the front end is clipping. Reduce gain or add attenuation.' },
  { id: 'uncalibrated', severity: 'info',
    message: 'Levels are estimated, not calibrated; relative readings are fine.' },
]);
```

| | |
|---|---|
| `id` | stable per condition (`overload`, `usb-overflow`), lowercase, so the host can tell a condition that persists from one that recurs |
| `severity` | `info` — worth knowing, the trace is fine · `warning` — the trace is degraded, act if it persists · `critical` — do not trust the trace right now, or the hardware is at risk |
| `message` | one or two sentences the *user* can act on: what is wrong and what to do. The reader is an RF coordinator an hour before doors, not you |

Three rules:

- **Replace, don't append.** Each call is the whole set; a condition that has
  cleared simply stops being listed. There is nothing to reset, which is what
  makes reporting from a timer safe.
- **Pick the severity from the reader's seat.** The question is "can I trust
  what the plot shows?", not how alarming the cause sounds. Sample overflows
  are a `warning`; a stalled radio whose trace has silently frozen is
  `critical`; a USB 2 link is `info`.
- **Warnings are not status.** A device stays `ok` while overloaded. Something
  the device cannot recover from is `onFatal`, not a critical warning.

Call it as often as you like — the shell drops identical reports before they
reach the host. The `?.` matters: a shell built for core 1.0 never assigns it,
and your plugin should still run there. For conditions about the plugin as a
whole rather than one device, `this.updateWarnings(list)` on the plugin class
does the same thing at plugin level.

---

## Device controls

Knobs SoundBase has never heard of. Declare them from `open()`, receive them in
`applyConfig`, echo what the hardware settled on.

```js
controls: [
  { id: 'refLevelDbm', type: 'number', label: 'Reference level',
    unit: 'dBm', default: -20, min: -56, max: 20, step: 1 },
  { id: 'detector', type: 'dropdown', label: 'Detector', default: 'peak',
    choices: [{ id: 'peak', label: 'Peak' }, { id: 'average', label: 'Average' }] },
]
```

Each entry is a field descriptor in the same vocabulary as the manifest's
config fields — see [manifest-reference.md](manifest-reference.md#config-fields)
for every property and type.

- **Built at `open()`, not declared in the manifest**, so ranges and choices can
  come from the hardware you have just identified. A model with a 30 dB
  attenuator and one with 50 dB can share a plugin and still each offer the
  truth.
- SoundBase renders them beside RBW and point count, saves the values in the
  project, and hands them back in `cfg.controls` keyed by the same ids.
- **Nothing between the form and your adapter interprets them.** SoundBase
  never learns what a detector is, which is exactly why adding a control to a
  shipped plugin needs no SoundBase release.
- `null` is a value ("auto"), not an erasure.
- Clamp and echo, as with everything else.

---

## `createMonitoringAdapter(device, pluginConfig)`

For RF receivers, IEM transmitters and anything else that lands in
SoundBase's **device monitoring** views rather than the spectrum plot. Called
once per device, when SoundBase adds it. Returns an object with two required
methods and one optional one; the shell assigns three callbacks. Not async,
no I/O — just construct.

```js
export function createMonitoringAdapter(device, pluginConfig) {
  return {
    async open() {                      // connect, report the full state, start reporting
      return { channelCount: 2, properties: [...], identity: { model, firmware } };
    },
    async close() {},
    async setProperty(command) {},      // PropertyControl; optional
    // assigned by the shell before open(): onState, onWarnings, onFatal
  };
}
```

The module is **push, not pull**. Nothing polls you: every fact SoundBase
shows comes from you calling `this.onState(key, value)` — on connect, on every
change, and for meters on a timer. The shell turns each call into a state
patch on the `device-state` event and SoundBase's monitoring cards render
from those patches, the same way they render its built-in devices.

### `open()` → `{ channelCount?, layout?, properties?, identity? }`

Connect, then report. `onState` is already assigned when `open()` runs, so
report the complete state *before* returning — channel names, frequencies,
power, mute, the paired receivers — and SoundBase draws a full card the
moment the device appears rather than filling it in field by field.

| | |
|---|---|
| `channelCount` | how many channels *this unit* has, when it differs from the product's `traits.channelCount`. |
| `layout` | a replacement for the product's manifest layout, for a unit whose front panel differs from the product's. Rare. |
| `properties` | `PropertyControl` descriptors — see [`setProperty`](#setpropertycommand). |
| `identity` | `{ model, firmware }`, for the plugin manager. |

Throwing marks the device `failed` with your message, exactly as for the
spectrum-analyzer adapter.

### `onState(key, value, operation?)` (assigned to you)

The one call that matters. `key` is either a **core state key** —
`frequency`, `channelName`, `mute`, `txPower`, `meters`, `battery`,
`receivers` and the rest of `spec/state-keys.json` — or an **extension key**
you declared in the manifest's `stateKeys`, named `x.<your-id>.<key>`. The
shell derives the patch's scope and operation from that table and from your
declaration; you never write them.

Value shapes, from `channel-monitoring.openapi.yaml`:

```js
// channel-scoped keys: a map of channel number → value, wrapped in `channels`
this.onState('frequency',   { channels: { 1: 518.100, 2: 542.350 } });   // MHz
this.onState('channelName', { channels: { 1: 'VOX L' } });
this.onState('mute',        { channels: { 1: false } });
this.onState('txPower',     { channels: { 1: 50 } });                    // mW

// meters: device-scoped, one reading per channel
this.onState('meters', { timestamp: Date.now(), channels: {
  1: { af: -18.5, afR: -20.1, txOn: true },     // dBFS; rf1..rf6 in dBm; lqi 0–100
} });

// receivers: the bodypacks paired to an IEM transmitter, as a delta
this.onState('receivers', {
  added:   [{ id: 'pack:1', name: 'Pack 1', channel: 1, battery: { percent: 92 } }],
  updated: [{ id: 'pack:2', changes: { battery: { percent: 41 } } }],
  removed: [],
});

// an extension key, declared as { key: 'x.acme.packLink', scope: 'channel', op: 'merge' }
this.onState('x.acme.packLink', { channels: { 1: 'pack:1' } });
```

**Report meters as fast as your hardware does.** The shell coalesces
`meters` to one patch per 50 ms per device, keeping the latest reading per
channel, so the rate on the wire is bounded whatever you send. Every other
key is sent as it arrives, except that a value identical to the last one you
reported for that key is dropped — so reporting from a timer is free.

**A call the contract refuses is dropped and reported, never lost quietly.**
An unknown key, an extension key you did not declare, a `delta` on a key that
only takes `merge`: the patch is dropped, a warning naming the key appears on
the plugin in SoundBase's plugin manager, and the plugin log says why. If
your state is not showing up, that warning is the first place to look.

### `setProperty(command)`

The `PropertyControl` module — optional, and the reason `open()` returns
`properties`. Each descriptor names a property, its scope, whether it is
writable, and its value type, in SoundBase's own `PropertyDescriptor` shape
(`property-control.openapi.yaml`):

```js
properties: [
  { id: 'txPower', scope: 'channel', access: 'readWrite',
    stateBinding: { key: 'txPower' },
    value: { type: 'enum', options: [10, 50, 100], unit: 'mW' } },
  { id: 'frequency', scope: 'channel', access: 'readWrite',
    stateBinding: { key: 'frequency' },
    value: { type: 'number', min: 470, max: 608, step: 0.025, unit: 'MHz' } },
]
```

SoundBase renders them in the device settings modal, and inline wherever the
product layout has a `control` node naming the descriptor. When the user
changes one, `setProperty` receives

```js
{ requestId, propertyId: 'txPower', channelIndex: 1, value: 100 }   // entityId for a receiver's property
```

**Apply it, then report the result through `onState`.** Do not return the new
value: the shell answers `202 Accepted` as soon as `setProperty` resolves,
and SoundBase updates the card only when the new value arrives as state.
That is deliberate — the device is the truth, and a value it clamped or
refused shows up exactly as the device has it. Throw `HttpError(400, …)` for
a request that is wrong on its face (an unknown property, a value of the
wrong type); throw anything else and the host sees `503`.

`channelName` and `frequency` are ordinary properties here. SoundBase checks
a new name against the product's manifest `channelName` rules before sending
it, so what you receive already fits the device.

### `close()`, `onWarnings`, `onFatal`

As for the spectrum-analyzer adapter. `close()` stops your timers and
releases the transport; `onWarnings` reports the complete current set of
conditions worth a person's attention; `onFatal(err)` says the transport is
gone. After `onFatal` the shell ignores anything the dead adapter still
reports, so a late timer tick cannot resurrect a stale reading.

---

## Errors and what the host sees

| You do | The host sees |
|---|---|
| throw from `open()` | device `failed`, your message, `503 device_unavailable` |
| throw `HttpError(400, …)` from `setProperty` | that status and code; anything else is `503 device_unavailable` |
| call `onState` with a key the contract refuses | patch dropped, a `dropped-state-…` warning on the plugin, a line in the log |
| throw from `applyConfig` / `startSweep` / `stopSweep` | `503 device_unavailable` with your message |
| `throw new HttpError(409, 'busy', '…')` | that exact status and code — import `HttpError` from `@soundbase/plugin-shell` when you need a specific one |
| call `onFatal(err)` | device `failed`, sweep stopped, adapter closed, process alive |
| return a config missing `startHz`/`stopHz`/`pointCount` | `502 bad_adapter_config` |
| let the process crash | plugin restarted with backoff, up to 5 times |

Messages reach a plugin log the user can open, and an RF coordinator an hour
before doors is the person reading it. `Serial port /dev/tty.usbmodem401 is no
longer present` is worth ten of `Error: read ECONNRESET`.

---

## Plugin-level hooks

`main.js` subclasses `SoundBasePlugin`, overrides `discoverDevices`, and
attaches whichever adapter factories `adapter.js` exports:

```js
import * as adapter from './adapter.js';

class Plugin extends SoundBasePlugin {
  async discoverDevices() {
    return adapter.discoverDevices?.(this.config) ?? [];
  }
}
if (typeof adapter.createSpectrumAnalyzerAdapter === 'function') { /* wired */ }
if (typeof adapter.createMonitoringAdapter === 'function') { /* wired */ }
```

**You almost certainly need nothing else.** `this.config` — the current values
of your `pluginConfigFields` — is already threaded into every one of your
exports, which is why no first-party plugin overrides anything further and
why every `main.js` in existence is byte-identical.

The base class does offer more, for the rare case where the plugin *as a
whole*, not one device, has work to do:

| | |
|---|---|
| `async init(pluginConfig)` | the first configuration push after the process starts. This is what brings the plugin up. |
| `async configUpdated(pluginConfig)` | every later push |
| `async destroy()` | shutdown; the shell has already closed every device |
| `get config()` | latest `pluginConfigFields` values |
| `get manifest()` | the parsed manifest |
| `log(level, message)` | into the host's per-plugin log, which the user can open |
| `updateStatus(status, message)` | `'ok'`, `'failed'` or `'bad-config'` for the plugin itself |

Throwing from `init` or `configUpdated` marks the plugin `bad-config` with your
message — the right response to "the address field is empty", which is a
configuration problem the user can fix, as distinct from a runtime failure
worth retrying.

Adding one of these is the only legitimate reason to touch `main.js`. Keep the
change inside the class body; leave the imports and the `runPlugin` call
exactly as they are. (`npm run doctor` will start warning that `main.js` has
been edited. That warning is doing its job — it is aimed at the much more
common case where something that belonged in `adapter.js` ended up here.)
