# Working on this plugin with Claude

Context for Claude Code and any other coding agent working in this repository.
It is also the shortest accurate description of the plugin model here, so it is
worth reading yourself.

## What this repository is

A **SoundBase plugin**: a small network service that provides one or more
devices to SoundBase over a versioned HTTP contract. SoundBase spawns it as a
child process and supervises it — handshake, health, crash-restart, teardown.

SoundBase is an RF coordination platform for live events: it plans which
frequencies hundreds of wireless microphones and in-ear monitors will use, and
coordinates against **measured** spectrum rather than assumptions. A
spectrum-analyzer plugin supplies that measurement — its sweeps become the live
trace on the plot, and the amplitudes it reports decide which frequencies the
software is willing to use. `docs/soundbase.md` is the full orientation.

The author writes device logic. The author never writes UI, IPC, or HTTP.

```
soundbase-plugin.json   identity, products, config fields
main.js                 shell bootstrap — never edit
adapter.js              device logic — this is the file that changes
driver/                 optional: protocol-specific code adapter.js uses
__tests__/              contract tests, driven through the real shell
examples/network-analyzer/   a second complete plugin, over TCP, with a fake device
docs/                   the guide set; docs/README.md indexes it
scripts/                doctor, smoke, manifest, rename, release, pack-release
```

## Invariants — do not violate these without being asked

- **Never edit `main.js`.** It is byte-identical across every first-party
  plugin and is the contract's entry point. Anything you are tempted to put
  there belongs in `adapter.js`. The single exception is adding a lifecycle
  hook (`init`, `configUpdated`, `destroy`) to the `Plugin` class body — and
  `this.config` is already threaded into both adapter exports, so that is
  rarely needed.
- **Never implement HTTP, routing, SSE, auth, or sweep bookkeeping.**
  `@soundbase/plugin-shell` owns all of it. If a change involves an HTTP verb,
  it is almost certainly wrong.
- **Never read a device address from machine-local state.** Addressing arrives
  explicitly in `device.config` on `POST /devices`. The same project opened on
  another machine must work.
- **Device ids must be stable across restarts.** They appear in URLs and are
  stored in users' projects. `usb:<path>` and `net:<host>` are the conventions.
- **Clamp, do not reject.** Out-of-range config gets snapped to what the
  hardware accepts and echoed back. Rejection looks like a broken plugin.
- **Every product the adapter announces must be declared in the manifest.** The
  two agree via `npm run rename`; a mismatch produces a device the host
  silently ignores. A test and `npm run doctor` both check it.
- **Do not accumulate trace modes.** The shell does max-hold, min-hold and
  average at the device's full sweep rate. Report raw sweeps.
- **Do not bump the `template` block** in `soundbase-plugin.json`. It records
  what this plugin was generated from and is meant to go stale.

## The adapter contract

`adapter.js` exports exactly two things:

```js
export async function discoverDevices(pluginConfig) → Device[]
export function createSpectrumAnalyzerAdapter(device, pluginConfig) → {
  open()                 → { capabilities, identity }
  applyConfig(cfg)       → effective config, echoing what the device accepted
  startSweep(onTrace)    → calls onTrace(number[]) once per completed sweep
  stopSweep()
  close()
  onFatal                → assigned by the shell; call it when the transport dies
}
```

`docs/adapter-reference.md` is the detailed version. The normative
specification is installed, not guessed at:

```
node_modules/@soundbase/plugin-contract/spec/
  soundbase-plugin.schema.json
  core.openapi.yaml
  spectrum-analyzer.openapi.yaml
```

**Read those files before answering a question about the contract.** They ship
inside the dependency and always match the shell version in the lockfile, so
they are authoritative in a way that any summary — including this file — is not.

## Verifying a change

In order of what they prove:

```sh
npm run doctor    # is the plugin well-formed at all?
npm test          # adapter through the real shell, over HTTP
npm run manifest  # the manifest the host will refuse or accept
npm run smoke     # boots as a child process, handshakes, sweeps
```

A change is not done because `npm test` passes. If it touches discovery,
startup or the manifest, run the smoke check — that is the path that fails
silently in production, because a plugin that never handshakes is simply
invisible to SoundBase.

## Prompts that work

**Implementing a real device**

> Replace `adapter.js` so it talks to <device> over <transport>. Keep
> `discoverDevices` and `createSpectrumAnalyzerAdapter` as the only exports and
> put the protocol code in `driver/`. Read
> `node_modules/@soundbase/plugin-contract/spec/spectrum-analyzer.openapi.yaml`
> and `examples/network-analyzer/adapter.js` first, and match their semantics
> for `applyConfig`'s echo and trace geometry. Add a fake device beside the
> driver so the tests run with nothing attached. Keep the existing tests
> passing — they are written against the contract, not against the synthetic
> source.

**Adding a device control**

> Add a <name> control. Declare it in `capabilities.controls` from `open()`
> using the config-field vocabulary, read it from `cfg.controls` in
> `applyConfig`, clamp it to what the hardware allows, and echo the settled
> value in the returned `effective.controls`. Add a test that a value outside
> the range comes back clamped rather than rejected, and one that a request
> carrying only this control leaves the others in force.

**Wrapping a native library**

> Read `docs/native-runtimes.md` first. Put the libuhd work in a worker child
> process under `driver/worker/` speaking JSON-lines over stdio, so the driver
> can SIGKILL it when a call wedges. Give the worker a mock mode so tests run
> with no hardware attached.

**Diagnosing "my plugin does not appear in SoundBase"**

> Run `npm run doctor`, then `npm run smoke`, and work from what they report.
> Check in this order: does the manifest validate; does the handshake line
> appear at all; does `GET /devices` return anything; does every device name a
> product the manifest declares. The host gives up on a plugin that does not
> handshake, and logs nothing that explains why. `docs/troubleshooting.md` has
> the full list.

**Renaming the plugin**

> Run `npm run rename <id>` rather than editing by hand — the id appears in the
> manifest, in every product's `deviceTypeId`, in `adapter.js`, and in
> `package.json`, and a partial rename produces a device the host ignores with
> only a warning line in the log.

## What not to ask for

- **A second transport.** WebSocket, gRPC and subscription protocols are all
  out of scope; the contract is HTTP plus SSE lifecycle events, deliberately.
- **UI.** Plugins do not ship renderer code. If a device needs a knob SoundBase
  has never heard of, that is `capabilities.controls`, which renders generically
  and needs no SoundBase release.
- **Changes to the shell.** If the shell seems to be in the way, that is worth
  raising as an issue rather than working around — a workaround in `adapter.js`
  becomes the thing that breaks on the next contract version.
- **Trace-mode maths, sweep ids, long-polling, or an SSE stream.** All of it is
  already implemented in the shell.
