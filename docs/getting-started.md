# Getting started

From nothing to a running plugin, then to a plugin that is yours.

## Prerequisites

- **Node 20 or newer.** Nothing else. No SoundBase checkout, no hardware, no
  account.
- SoundBase Desktop, eventually, if you want to see your device in the app —
  but not for anything on this page.

## 1. Get the code

Press **Use this template → Create a new repository** at the top of this
repository's GitHub page, then clone the repository that gives you:

```bash
git clone https://github.com/<you>/<your-plugin> my-plugin
cd my-plugin
```

> **Use the button rather than cloning this repository directly.** A clone
> keeps this repository as its `origin`, so your first `npm run release` would
> try to tag and publish a release *here*, and fail. It also inherits this
> repository's history, which is regenerated wholesale on every SDK release and
> is not a history you want to build on. The button gives you a clean repository
> you own, with no history and the right `origin`.

## 2. Install the SDK

Two packages do all the work you are not doing: `@soundbase/plugin-contract`
(the manifest schema, the OpenAPI documents, the validator) and
`@soundbase/plugin-shell` (the runtime).

```bash
npm install
```

That pulls two packages from public npm:

| | |
|---|---|
| `@soundbase/plugin-contract` | the manifest schema, the OpenAPI specs, and a manifest validator |
| `@soundbase/plugin-shell` | the runtime that serves the whole HTTP contract for you |

They are the same versions SoundBase itself runs, and they are the only
dependencies. You do not need a SoundBase checkout to build a plugin.

The specs install alongside the code, at
`node_modules/@soundbase/plugin-contract/spec/` — those files are the normative
contract, so prefer them over any prose (including these docs) when the two
seem to disagree.

Then confirm the whole setup in one command:

```bash
npm run doctor
```

It checks your Node version, the SDK, the manifest, the entrypoint, the adapter
and the licence, and prints the exact fix for anything wrong. Run it whenever
something is broken and you do not yet know which layer is at fault.

## 3. Run it

```bash
npm start
```

```
SB_PLUGIN_READY {"port":54321}
[info] template 0.1.0 listening on 127.0.0.1:54321
```

That first line is the handshake — the whole of the startup contract. Started
by hand like this, with no `SB_PLUGIN_TOKEN` in the environment, the plugin
serves the same contract with authentication disabled, which makes it easy to
poke at:

```bash
curl localhost:54321/health
curl localhost:54321/devices
```

The template ships a **synthetic** analyzer: a noise floor with two carriers
and a transient that appears on one sweep in seven. It exists so the entire
path — discovery, configuration, sweeping, trace geometry, max-hold
accumulation — works before you own any hardware.

Take a sweep from it:

```bash
PORT=54321
DEV=synthetic%3A1
curl -s -X POST localhost:$PORT/devices/$DEV/configuration \
  -H 'content-type: application/json' \
  -d '{"startHz":470000000,"stopHz":616000000,"pointCount":11}'
curl -s -X POST localhost:$PORT/devices/$DEV/sweep/start
curl -s localhost:$PORT/devices/$DEV/trace
```

## 4. Check it the way the host does

```bash
npm test    # your adapter, through the real shell, over real HTTP
npm run smoke   # spawns main.js as a child process and handshakes with it
```

`npm test` imports your code. `npm run smoke` does not: it starts `main.js` as
a child process, reads the stdout handshake and talks HTTP, which is exactly
what SoundBase does. **A plugin can pass its tests and still be invisible to
SoundBase** — see [testing.md](testing.md).

## 5. Make it yours

### Pick an id

```bash
npm run rename my-plugin-id
npm run rename my-plugin-id -- --name "My Analyzer"
```

The plugin id appears in four places that must agree — the manifest `id`, the
`plugin:<id>/<model>` prefix on every product, the `PRODUCT` constant in
`adapter.js`, and the npm package name. `rename` changes all four. A mismatch
produces a plugin that boots, discovers a device, and then has that device
silently ignored.

**Do this before you publish anything.** The id namespaces every
`deviceTypeId` you ship and is stored inside users' saved projects, so
changing it later strands every device they configured.

### Describe your hardware

Edit `soundbase-plugin.json`: one entry in `products` per model you support,
plus `deviceConfigFields` for anything SoundBase must ask the user in order to
address a device (an IP address, a port), and `pluginConfigFields` for settings
that belong to the plugin as a whole. Field reference:
[manifest-reference.md](manifest-reference.md).

```bash
npm run manifest   # validate it against the contract's own schema
```

### Replace `adapter.js`

This is the file you write. It exports exactly two things:

```js
export async function discoverDevices(pluginConfig) → Device[]
export function createSpectrumAnalyzerAdapter(device, pluginConfig) → adapter
```

Full reference: [adapter-reference.md](adapter-reference.md). For a worked
version against a real transport — discovery by probing, addressing from device
config, controls, clamping, and a socket that dies mid-sweep — read
[`examples/network-analyzer/`](../examples/network-analyzer/README.md), which
is a complete second plugin with its own tests.

Put anything protocol-specific in a `driver/` beside the adapter, and give it a
fake so your tests run with nothing plugged in. That split is worth more than
it looks: `driver/` is testable on its own and is the only thing that changes
when you swap a transport.

### Do not edit `main.js`

Sixteen lines of shell bootstrap, byte-identical across every plugin ever
written against this contract. Anything you are tempted to put there belongs in
`adapter.js`. `npm run doctor` warns if it has changed.

## 6. A first change, end to end

Give the synthetic analyzer a control, so you can watch a knob you invented
appear in the contract without SoundBase knowing anything about it.

In `adapter.js`, return one from `open()`:

```js
async open() {
  return {
    capabilities: {
      minFrequencyHz: MIN_FREQUENCY_HZ,
      maxFrequencyHz: MAX_FREQUENCY_HZ,
      rbwHz: [...RBW_HZ],
      controls: [
        { id: 'attenDb', type: 'number', label: 'Attenuation',
          unit: 'dB', default: 0, min: 0, max: 30, step: 5 },
      ],
    },
    identity: { model: 'Synthetic', firmware: '0.1.0' },
  };
}
```

Read it in `applyConfig`, clamp it, and echo what you settled on:

```js
async applyConfig(cfg = {}) {
  // …existing range and point handling…
  const requested = cfg.controls?.attenDb;
  if (requested !== undefined) {
    this.attenDb = Math.min(30, Math.max(0, Math.round(Number(requested))));
  }
  return { ...this.config, controls: { attenDb: this.attenDb ?? 0 } };
}
```

Subtract it in `buildTrace` (`amp -= this.attenDb ?? 0`), then:

```bash
npm start
curl -s -X POST localhost:<port>/devices/synthetic%3A1/configuration \
  -H 'content-type: application/json' \
  -d '{"controls":{"attenDb":42}}'
```

You get `{"controls":{"attenDb":30}}` back — clamped, not rejected — and in
SoundBase that control renders as a form field beside RBW and point count.
Nothing in SoundBase was changed or rebuilt to make that happen, and nothing in
SoundBase knows what attenuation is.

## 7. See it in the app

[running-in-soundbase.md](running-in-soundbase.md) covers where to put the
folder, the feature flag that gates third-party plugins, the plugin manager,
and where the logs are.

## Where to go next

| If you want to… | Read |
|---|---|
| Understand the app you are plugging into | [soundbase.md](soundbase.md) |
| Understand the wiring | [architecture.md](architecture.md) |
| Look up an adapter method | [adapter-reference.md](adapter-reference.md) |
| Look up a manifest field | [manifest-reference.md](manifest-reference.md) |
| Debug with `curl` | [http-contract.md](http-contract.md) |
| Wrap a native library or ship a runtime | [native-runtimes.md](native-runtimes.md) |
| Ship it to users | [publishing.md](publishing.md) |
| Work out why nothing appears | [troubleshooting.md](troubleshooting.md) |
