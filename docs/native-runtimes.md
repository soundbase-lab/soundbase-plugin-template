# Native libraries and bundled runtimes

Most plugins never need this document. If your device speaks a serial protocol
or talks over the network, write it in JavaScript in `adapter.js` and stop
reading — you have no native dependency and none of the following applies.

You need this if your device requires a native library (a vendor SDK, a USB
driver layer) or a language runtime you cannot assume is installed. Everything
below was learned building a plugin around libuhd for Ettus USRP hardware, and
each item cost real time to discover.

## 1. Isolate anything that can wedge

**This is the one that matters. The rest is packaging.**

A blocking C library that owns a USB device can hang mid-call — a cable comes
out during a bulk transfer, the firmware stops answering, the kernel driver
gets confused. There is frequently no timeout and no way to interrupt it.

If that call happens inside your plugin's process, your plugin is gone.
SoundBase notices the health check stop, kills the process and restarts it, and
the user watches their device disappear and come back.

So put the native work in a **child process you can always kill**:

```
adapter.js          ← contract-facing, always responsive
driver/
  my-driver.js      ← owns one worker, JSON-lines RPC over stdio
  worker/           ← the native part, in whatever language the SDK likes
```

When a call does not answer, `SIGKILL` the worker, report a clean device error,
and stay alive. Your plugin process never blocks, so SoundBase never has to
restart it, so the user's *other* devices are unaffected.

The process boundary between SoundBase and your plugin protects SoundBase from
you. This second boundary is the one that protects you from the vendor's SDK.

A useful side effect: the worker becomes independently testable. You can drive
it by hand and see exactly what it does.

```sh
printf '%s\n' \
  '{"id":1,"op":"open","args":{}}' \
  '{"id":2,"op":"config","config":{"startHz":88e6,"stopHz":108e6,"pointCount":401}}' \
  '{"id":3,"op":"start"}' \
  | python3 driver/worker/my_worker.py
```

## 2. Be honest about what you cannot bundle

Some things are genuinely system prerequisites. A USB driver layer like libuhd
installs kernel-adjacent components and downloads FPGA images; you are not
going to ship that inside a plugin folder, and pretending otherwise produces a
plugin that fails mysteriously on a clean machine.

Say so, in your README, in the first section a user reads:

> **Requires libuhd.** `brew install uhd` (macOS) or
> `apt install libuhd-dev uhd-host` (Linux), then `uhd_images_downloader -t b2xx`
> once so the FPGA images exist.

Then give an override for when it lives somewhere unusual — an environment
variable or a plugin config field naming the library path. Users with unusual
setups will find it; users without one will file bugs.

## 3. Freezing a language runtime

If you need an interpreter, do not depend on the user having one. A frozen
runtime is what makes the difference between "works on my machine" and "works".

Assemble a self-contained interpreter plus its packages into a per-target
directory:

```
runtime/
  darwin-arm64/     runtime.json + the interpreter and libraries
  darwin-x64/
  win32-x64/
  linux-x64/
```

**Pin everything by digest.** The interpreter tarball per target, and every
wheel hash. A build that resolves "latest" at assembly time is a build that
produces a different artifact next week for reasons nobody can reconstruct.
Bumping a version should mean editing an explicit pins block and nothing else.

**Resolve in this order**, so a broken bundle degrades instead of failing:

1. an explicit setting (plugin config field, or an environment variable)
2. `runtime/<platform>-<arch>/` if it exists
3. probe the system

An assembled runtime makes a machine with *no interpreter at all* work; a
damaged one falls back to the system search; and a user with a specific
interpreter they need you to use can always win outright.

### Cross-assembly must never execute target binaries

You want one CI job to produce every target. That means the host cannot run
what it is assembling — you cannot execute a Windows binary while building on
Linux.

So: lay wheels down as files, and precompile bytecode with a *host-platform*
interpreter **of the same pinned version**. Nothing target-specific ever runs.
One job on any OS produces all targets.

### Precompile bytecode, because the install will be read-only

Once a plugin ships inside a signed application bundle, its directory is
read-only. An interpreter that wants to write `.pyc` files beside its own
source will fail, or silently pay the compile cost on every single start.

Precompile at assembly time (for Python, `-o 2`) and verify the runtime works
from a genuinely read-only directory. Test this deliberately — `chmod -R a-w`
the runtime and start the plugin. It is a five-minute test that catches a bug
which otherwise only appears after signing, packaging and installing.

### Expect it to be large

A frozen CPython with numpy runs roughly 57 MB on macOS and 77 MB on Windows,
or about 18–25 MB compressed inside an installer. That is the honest price of
"it just works". Budget for it rather than discovering it at release.

## 4. Code signing (macOS)

If your plugin ships inside a signed, notarized application, every Mach-O
binary in your runtime must be registered for hardened-runtime signing —
executables, shared libraries, and the dozens of extension modules a scientific
Python stack drags along.

The one that is not obvious: an interpreter that `ctypes`-loads a
system-installed library needs the **`disable-library-validation`**
entitlement. Without it, the hardened runtime refuses to load a library signed
by anyone else, which is exactly what a Homebrew- or vendor-signed SDK is. The
failure message does not say this.

Executables also cannot run from inside an asar archive. They have to be
packaged as an extra resource, unarchived.

## 5. Testing without hardware

You cannot put a USRP in CI, and you should not need one to develop.

**Give your worker a mock mode.** A synthetic device — a noise floor, a CW tone
at a known frequency, maybe a DC spur — that exercises the interpreter, the
packages and the full pipeline, with only the vendor library swapped out:

```sh
SB_MYPLUGIN_MOCK=1 npm start
```

That is what lets you poke at the plugin with `curl` on a laptop with no radio
attached, and what lets CI run the real integration path.

**Structure tests in two layers.** The adapter and driver against a scripted
fake worker (fast, deterministic, no interpreter needed), plus one integration
test that drives the real worker in mock mode end to end. Skip the second
*loudly* when the runtime is absent — a silently skipped test is a test you
believe is passing.

## 6. Windows

Assembling for Windows is not the same as having tested on Windows. It is
entirely normal to have a `win32-x64` runtime that assembles cleanly and has
never actually been executed — the first-party USRP plugin was in exactly that
state for months.

Two Windows-specific facts worth knowing up front:

- Node cannot deliver a real `SIGTERM` on Windows. Killing a worker means
  `taskkill /pid <n> /f /t` to take the whole process tree, and the shell does
  this for your plugin already — but if you spawn your own children, it is
  yours to handle.
- Path separators reach your device ids and therefore your URLs. Percent-encode
  and round-trip them in a test.

If you have not run it on Windows, say so in your README. A user hitting a
platform you never tried should discover that from your documentation, not from
a crash.
