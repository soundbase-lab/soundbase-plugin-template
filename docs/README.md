# Documentation

## If you are new, read these three, in order

1. **[soundbase.md](soundbase.md)** — what SoundBase is, what the people using
   it are doing, and where your device lands. Written for someone who has never
   opened the app and never will.
2. **[architecture.md](architecture.md)** — how a plugin is wired to it. The
   process model, the lifecycle, what the shell does so you don't have to.
3. **[getting-started.md](getting-started.md)** — clone, install, run, rename,
   and a first change end to end.

[glossary.md](glossary.md) is worth skimming at any point: it covers both the
RF vocabulary (dBm, RBW, sweep, trace mode) and SoundBase's own (project, zone,
live scan, exclusion threshold).

## Reference

| | |
|---|---|
| [adapter-reference.md](adapter-reference.md) | The file you write. Every method, what it receives, what it must return. |
| [manifest-reference.md](manifest-reference.md) | Every field of `soundbase-plugin.json`. |
| [http-contract.md](http-contract.md) | The wire, endpoint by endpoint. You don't implement it — but you'll `curl` it. |
| [glossary.md](glossary.md) | RF and SoundBase vocabulary. |

## Doing things

| | |
|---|---|
| [testing.md](testing.md) | The three checks, faking hardware you don't have, what's worth asserting. |
| [running-in-soundbase.md](running-in-soundbase.md) | Where the folder goes, the feature flag, the plugin manager, the logs. |
| [native-runtimes.md](native-runtimes.md) | Native libraries, bundled interpreters, code signing. **Read this before designing anything that needs one.** |
| [publishing.md](publishing.md) | Releases, the Lab, licensing. |
| [troubleshooting.md](troubleshooting.md) | Symptom → cause. Start with `npm run doctor`. |

## The normative documents

Everything here is a description. The specification installs with your
dependencies:

```
node_modules/@soundbase/plugin-contract/spec/
  soundbase-plugin.schema.json     the manifest schema
  core.openapi.yaml                identity, devices, config, events, health
  spectrum-analyzer.openapi.yaml   configuration, sweep control, traces
```

They ship inside the contract package rather than as a copy that might have
gone stale, so they always describe the shell version your lockfile pins. When
these pages and those documents disagree, the documents are right.

## Worked code

[`examples/network-analyzer/`](../examples/network-analyzer/README.md) is a
complete second plugin: a networked instrument over TCP, with discovery by
probing, addressing from device config, device controls, clamping, a fatal
transport error, and a fake instrument its tests run against. It is the thing
to read once the synthetic template stops being enough.
