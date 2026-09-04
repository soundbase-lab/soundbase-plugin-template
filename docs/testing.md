# Testing a plugin

Three checks, in increasing order of what they prove. Run all three before you
release; run the first constantly.

```bash
npm test          # your adapter, through the real shell, over real HTTP
npm run manifest  # the manifest the host will accept or refuse
npm run smoke     # main.js spawned as a child process, handshake and all
```

`npm run doctor` sits underneath all of them: it checks the setup itself —
Node, the SDK, the manifest, the entrypoint, the adapter exports, the licence —
and tells you what to do about anything wrong. Start there when you do not yet
know which layer is broken.

## Why the tests go through the shell

`__tests__/template.test.js` does not call your adapter directly. It boots
`main.js`, gets a real HTTP server on a real port, and makes real requests:

```js
const handle = await (await import('../main.js')).default;
const res = await fetch(`${handle.url}/devices/${id}/trace`);
```

That is deliberate. Half of what can go wrong in a plugin lives in the gap
between "my adapter returns the right thing" and "the contract carries it
correctly" — a trace whose length disagrees with `pointCount`, a config echo
the shell cannot build an effective configuration from, a device announcing a
product the manifest never declared. Testing through the shell catches all of
those, and it means the tests keep their meaning when your adapter stops being
synthetic and starts talking to hardware. **They are written against the
contract, not against the signal source.**

Keep them passing as you replace `adapter.js`. When one starts failing because
your hardware genuinely behaves differently, change the assertion — do not
delete the test.

## Why `npm run smoke` is separate, and why it matters most

Unit tests `import` your code. The host does not: it spawns `main.js` as a
child process, reads one line of stdout, and talks HTTP.

```bash
$ npm run smoke
booting the plugin
SB_PLUGIN_READY {"port":54494}
  ok    handshake reported port 54494
  ok    /health
  ok    /info — My Analyzer 0.3.0, core 1.0
  ok    /devices — 1 discovered
  ok    configuration applied — 470000000–616000000 Hz, 401 points
  ok    sweep started
  ok    trace — sweep 1, 401 points
  ok    sweep stopped
smoke check passed
```

**A plugin whose tests pass but whose handshake never arrives is invisible to
SoundBase**, and the symptom is "my plugin does not appear" with nothing in any
log to explain it. A top-level `await` that never resolves, a native module
that fails to load on a machine other than yours, a crash during manifest
validation — none of these show up in a test that imports a module.

Devices are optional in the smoke check on purpose: with nothing plugged in,
`discoverDevices` finds nothing, the sweep checks report as skipped, and boot
and handshake are still proven. That is the normal result on a CI runner.

## Testing hardware you do not have

The single highest-value thing you can build is a **fake device**, in
`driver/`, beside the real one.

[`examples/network-analyzer/driver/fake-analyzer.js`](../examples/network-analyzer/driver/fake-analyzer.js)
is a complete one: a TCP server that speaks the same protocol as the instrument
it imitates, generates a plausible spectrum, and can be told to drop its
connections. Its test suite drives the whole stack — shell, adapter, driver,
socket — with nothing attached, and covers things that are hard to stage
physically:

```js
test('a transport that dies mid-sweep marks the device failed, not healthy', async () => {
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  instrument.dropConnections();
  // …poll /devices until status is 'failed'
});
```

Design the fake in from the start. Retrofitting one means untangling a driver
that assumed it could always reach real hardware, and the failure paths — the
ones that matter to a user in a loading dock — are exactly the ones you will
otherwise never exercise.

If your driver runs a native library or a separate runtime, give the worker a
mock mode rather than a mock at the JavaScript boundary; that way the process
plumbing is under test too. See
[native-runtimes.md](native-runtimes.md#5-testing-without-hardware).

## What is worth testing

The contract's sharp edges, in roughly this order:

| | |
|---|---|
| **Trace geometry** | `amplitudesDbm.length === pointCount`, first point at `startHz`, last at `stopHz`. Off by one here shifts every frequency on the plot, and it still *looks* fine. |
| **Clamping** | An out-of-range request returns `200` with a clamped value, not an error. |
| **Config echo** | What `applyConfig` returns is what `GET /configuration` reports. |
| **Partial config** | A request carrying only `startHz`/`stopHz` leaves RBW and controls alone. |
| **Controls** | Merged by id; a request carrying one leaves the others in force; values come back as the device settled on them. |
| **Discovery** | An address with nothing on it returns `[]` and does not throw. Device ids are stable across two calls. |
| **Failure** | A dead transport reaches `onFatal` and the device reports `failed`. |
| **The manifest/adapter agreement** | Every product the adapter announces is declared in the manifest. |

The last one sounds trivial and is the single most common way a renamed plugin
breaks: the device is discovered, the host ignores it as an undeclared product,
and one warning line in the log is the only evidence.

## CI

Two workflows ship with this template. `.github/workflows/ci.yml` runs the
three checks on a matrix of operating systems and Node versions, on every push
and pull request. `.github/workflows/release.yml` runs them again on a `v*`
tag and turns that commit into a GitHub Release —
[publishing.md](publishing.md#cutting-a-release) covers it.

The rest of this section is about `ci.yml`.

The OS matrix is worth keeping even for a plugin that talks to hardware nobody
has in CI: path handling, process termination and line endings differ between
platforms, and those are exactly the bugs that reach users before you notice
them.

Nothing in it needs adapting: both SDK packages are on public npm, so the
install resolves on a stock runner with no registry configuration and no
secrets.

The one thing to keep an eye on is your lockfile. A repository made from this
template does not have one yet, so the install step falls back to `npm install`
and the dependency cache stays off — CI is green from the first push, but two
runs a month apart can install different versions of the SDK. Run `npm install`
once locally and commit the `package-lock.json` it writes: from then on CI
takes the `npm ci` path, installs exactly what the lockfile pins, and caches
between runs. Let your usual update process move the SDK rather than editing
the lockfile by hand.
