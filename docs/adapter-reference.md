# Adapter reference

`adapter.js` is the file you write. Everything on this page is what the shell
calls, what it passes, and what it does with what you return.

The normative source is
`node_modules/@soundbase/plugin-contract/spec/spectrum-analyzer.openapi.yaml`.
Where this page and that document disagree, the document is right.

## The two exports

```js
export async function discoverDevices(pluginConfig) → Device[]

export function createSpectrumAnalyzerAdapter(device, pluginConfig) → Adapter
```

`main.js` imports both by name and does nothing else. Do not add a third
export expecting the shell to call it.

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

## Errors and what the host sees

| You do | The host sees |
|---|---|
| throw from `open()` | device `failed`, your message, `503 device_unavailable` |
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

`main.js` subclasses `SoundBasePlugin` and overrides exactly two methods:

```js
class Plugin extends SoundBasePlugin {
  async discoverDevices() {
    return discoverDevices(this.config);
  }
  createSpectrumAnalyzerAdapter(device) {
    return createSpectrumAnalyzerAdapter(device, this.config);
  }
}
```

**You almost certainly need nothing else.** `this.config` — the current values
of your `pluginConfigFields` — is already threaded into both of your exports,
which is why neither first-party plugin overrides anything further and why
every `main.js` in existence is byte-identical.

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
