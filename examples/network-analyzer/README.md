# Example: a networked spectrum analyzer

A complete second plugin, kept in this repository as a worked reference. It
talks to a made-up instrument over TCP, and its tests run against a fake
instrument in `driver/fake-analyzer.js`, so the whole thing works on a laptop
with nothing plugged in.

The synthetic adapter at the repository root proves the *path*. This one shows
the things a real device forces you to deal with:

| | Root `adapter.js` | This example |
|---|---|---|
| Discovery | one hardcoded device | probes addresses from plugin config |
| Addressing | none | `device.config`, with the device id as fallback |
| Transport | none | a TCP client in `driver/`, with timeouts |
| Controls | none | attenuation and detector, declared at `open()` |
| Clamping | in the adapter | echoed from what the instrument replied |
| Failure | none | `onFatal` when the socket dies mid-sweep |
| Tests | against the synthetic source | against a fake instrument |

## The files

```
soundbase-plugin.json   its own manifest — note deviceConfigFields for addressing
main.js                 byte-identical to the repository root's
adapter.js              the adapter: discovery, open, applyConfig, sweep, close
driver/analyzer-client.js   the wire protocol. Knows nothing about SoundBase.
driver/fake-analyzer.js     an instrument to test against
driver/protocol.md          what the made-up instrument speaks
__tests__/                  the whole stack, over real HTTP, no hardware
```

The split between `adapter.js` and `driver/` is the one worth copying.
`driver/` is about the wire and can be tested on its own; `adapter.js` is about
the contract. When you swap TCP for a serial port, only `driver/` changes.

## Running it

The example is exercised by the repository's test suite:

```sh
npm test
```

To run it as a plugin in its own right — the fake instrument has to be
listening somewhere first, so this is mostly useful once you have replaced the
driver with one that talks to real hardware:

```sh
node examples/network-analyzer/main.js
```

## Grafting it into your plugin

This example is a reference, not a starting point — start from the repository
root, which is the thing designed to be renamed and released. To adopt a piece
of it:

1. Copy `driver/` into your repository and rewrite it for your protocol, keeping
   the fake and its tests.
2. Move the parts of this `adapter.js` you need into the root `adapter.js`.
3. Add your addressing fields to `deviceConfigFields` in the root manifest, and
   anything the plugin as a whole needs to `pluginConfigFields`.
4. Delete `examples/` when it stops being useful to you. Nothing depends on it
   except the `npm test` glob.
