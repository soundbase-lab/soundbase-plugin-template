# Troubleshooting

Start here:

```bash
npm run doctor    # is the plugin well-formed?
npm run smoke     # does it boot and serve a trace the way the host does?
```

Between them they cover every failure that produces no visible error at all.

---

## `npm install` fails with `404 Not Found @soundbase/plugin-shell`

Both SDK packages are on public npm, so a 404 means your npm is not asking
public npm. Check where it is pointed:

```bash
npm config get registry            # expect https://registry.npmjs.org/
npm config get @soundbase:registry # expect undefined
```

A company mirror or proxy is the usual answer — it will not have the packages
until it has been asked to fetch them. Either have the scope allowed through,
or install from public npm for this scope only:

```bash
npm install --@soundbase:registry=https://registry.npmjs.org
```

If the registry is right, confirm the packages are reachable at all:

```bash
npm view @soundbase/plugin-shell version
```

See [getting-started.md](getting-started.md#2-install-the-sdk).

---

## "My plugin does not appear in SoundBase"

The most common report, and the one with the least evidence, because a plugin
that fails early fails silently. Work down this list in order — each step
proves the one before it was fine.

**1. Does it boot at all?**

```bash
npm run smoke
```

No `SB_PLUGIN_READY` line means the host would have given up too (it waits 10
seconds). Look for: a missing `node_modules`, a native module that will not
load, a top-level `await` that never resolves, a crash during manifest
validation.

**2. Is the manifest valid?**

```bash
npm run manifest
```

SoundBase validates it **before spawning**. An invalid manifest means the
plugin never starts. It is listed in the plugin manager with its error, so
check there too.

**3. Is the folder where SoundBase is looking?**

`<userData>/plugins/<your-plugin>/soundbase-plugin.json` must exist — one
folder per plugin, directly under the scan root. Paths per OS are in
[running-in-soundbase.md](running-in-soundbase.md#where-the-plugin-folder-goes).
If you are using `SB_PLUGIN_DIRS`, point it at the folder *containing* your
plugin, not at the plugin folder.

**4. Are dependencies actually there?**

SoundBase runs `main.js` as-is and installs nothing. `node_modules/` has to be
in the folder. A drop-in without it dies on its first import.

**5. Is the feature flag on?**

Third-party plugins are gated behind the `plugin-system` feature flag. Without
it your plugin is scanned and listed, but never spawned. Ask your SoundBase
contact to enable it for your account.

**6. Is it enabled in the plugin manager?**

Settings → Plugins. A disabled plugin is not spawned.

**7. Is the id colliding?**

Two folders with the same manifest `id` — most often a copy left in
`<userData>/plugins` and a dev tree on `SB_PLUGIN_DIRS` — and one of them loses
as a duplicate. Rename or remove one.

---

## The plugin runs but no device appears

**Your device names a product the manifest does not declare.** The commonest
cause by far, and it happens the moment you rename a plugin without updating
`adapter.js`. The plugin log has one line:

```
[warn] discovered device synthetic:1 names undeclared product plugin:old-id/synthetic
```

```bash
npm run doctor            # catches it without booting anything
npm run rename <your-id>  # fixes all four places the id appears
```

**`discoverDevices` is returning nothing.** Check it directly:

```bash
npm start
curl localhost:<port>/devices
```

Remember discovery only runs while an *enumeration window* is open —
`GET /devices` opens one for 60 seconds. If you are watching for polls and see
none, nothing has asked yet.

**`discoverDevices` is throwing.** An address with nothing on it is a normal,
empty result. A throw takes out the whole enumeration.

**The device needs addressing that has to be typed in.** A product with
`deviceConfigFields` appears as an "add a device" option in the picker rather
than in the discovered list.

---

## The device appears but fails as soon as it is used

A *discovered* device is not opened until something asks it to do work, so the
first failure surfaces on the first configuration, not on discovery.

- Check the plugin log — `open()` throwing marks the device failed with your
  message, which is exactly what you want to read here.
- Check the addressing you are using. It must come from `device.config` (or
  from the device id you chose), never from a file beside your plugin.
- If the device works from a script but not from the plugin, something else on
  the machine probably holds the port. An idle plugin does no discovery I/O
  precisely so that it is not the culprit — but your own earlier run might be.

---

## The trace looks wrong

| Symptom | Almost always |
|---|---|
| Everything shifted in frequency | `amplitudesDbm.length` ≠ `pointCount`, or your points are not evenly spaced from `startHz` to `stopHz` inclusive |
| A cliff at one edge | a partial sweep emitted as if it were complete |
| Amplitudes wildly off | not dBm, or a missing offset (many instruments report relative to their own reference) |
| Frequencies out by 10⁶ | MHz somewhere that should be Hz. The wire is **always** hertz |
| Reversed | your instrument sweeps high to low; reverse before calling `onTrace` |
| Flat line at the noise floor | the sweep range was clamped to something tiny, or the device never retuned. Read back `GET /devices/{id}/configuration` |

---

## The trace updates slowly, or stutters

The host long-polls: it asks for the next trace immediately after each
response, and the shell holds the request open until a newer sweep exists (up
to 5 seconds). So the update rate is your sweep rate, and there is nothing to
tune on either side.

- Do not throttle `onTrace` yourself. Call it once per completed sweep, as fast
  as the hardware produces them.
- Do not use `setInterval` for sweeping if a sweep can take longer than the
  interval — reads pile up on one transport. Loop instead.
- If `sweepId` jumps by more than one between traces the host knows it skipped
  sweeps; for `max-hold` and `min-hold` nothing is lost, because the shell
  accumulates at your full rate.

---

## A configuration change is ignored, or arrives out of order

Overlapping `POST /configuration` requests **coalesce to the latest** —
intermediate configurations are dropped rather than queued, and traces produced
mid-reconfigure are discarded. Someone dragging a zoom on the plot generates a
burst of them, so expect an `applyConfig` to be abandoned in favour of a newer
one. Do not build your own queue.

Also check that you are treating `cfg` as a **patch**: fields that are absent
are unchanged, and `controls` is merged by id rather than replaced.

---

## A value comes back different from what was asked for

That is the contract working. Clamping is required, and the response is the
*effective* configuration. If it is clamping to something wrong, your
`capabilities` from `open()` are probably describing a different model than the
one connected.

---

## The device says it is fine but produces nothing

Almost always a transport that died without anyone noticing. Wire `onFatal`:

```js
this.client.on('close', () => this.onFatal?.(new Error('serial port closed')));
```

Calling it marks the device failed with your message, stops the sweep and
closes the adapter, without taking the process down. A device that keeps
reporting healthy while doing nothing is the worst failure mode in this system,
because the user has no reason to look at it.

---

## The plugin keeps restarting

The host restarts a crashed plugin with 1, 2, 4, 8, 16 second backoff and gives
up after five attempts. Three consecutive `GET /health` failures count as a
crash.

- An unhandled rejection in an async path takes the process down. `startSweep`
  callbacks are the usual offender.
- A blocking native call is worse than a crash: the process stays alive enough
  to answer `/health` while doing nothing. Put wedge-prone native work in a
  child process you can `SIGKILL` — see [native-runtimes.md](native-runtimes.md).

---

## Something else

Open an issue on this repository if the **template** is wrong. For the plugin
contract, device behaviour, or getting a plugin listed, go to the Lab. Either
way, include:

- the output of `npm run smoke`;
- the `soundbase` block from your `package.json` (it records which template
  release you started from and which contract version you target);
- the first three lines of your plugin log, which say which build is running.
