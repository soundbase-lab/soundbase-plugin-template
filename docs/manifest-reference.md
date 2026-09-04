# Manifest reference

`soundbase-plugin.json` is your plugin's identity card. SoundBase validates it
**before it will spawn your process**, so an invalid manifest means a plugin
that never starts and never explains why.

```bash
npm run manifest    # validate against the contract's own schema
```

The normative schema is
`node_modules/@soundbase/plugin-contract/spec/soundbase-plugin.schema.json`.
The same validator runs in three places — this script, the shell at boot, and
SoundBase before spawning — so if it passes here it passes there.

**Unknown properties are tolerated everywhere.** A manifest written for a newer
host still loads on an older one; that is deliberate and load-bearing.

## Top level

| Field | Required | |
|---|---|---|
| `manifestVersion` | ✓ | Always `1`. |
| `id` | ✓ | Lowercase letters, digits and hyphens, starting with a letter or digit. Namespaces every `deviceTypeId` you ship and is **stored in users' projects** — see the warning below. |
| `name` | ✓ | Human-readable plugin name, shown in the plugin manager. |
| `version` | ✓ | Yours to choose. Semver is expected but not enforced. |
| `contract` | ✓ | Which contract you implement. See below. |
| `runtime` | ✓ | `{ "type": "node", "entrypoint": "main.js" }`. `node` is the only runtime type today, and the entrypoint must resolve inside your plugin folder. |
| `products` | ✓ | At least one. The models you provide. |
| `license` | | SPDX id or licence name. **Required by the Lab** before it will accept a release. |
| `repository` | | URL. Shown to users deciding whether to trust you. |
| `maintainers` | | `[{ name, email?, url? }]` |
| `deployment` | | `["managed"]` — spawned and supervised by SoundBase. `"attached"` (a plugin running elsewhere on the network) is reserved and not yet supported. |
| `deviceConfigFields` | | The form SoundBase shows when a user adds one of your devices. |
| `pluginConfigFields` | | The form for settings belonging to the plugin as a whole. |
| `template` | | Lineage. Leave it alone — see below. |
| `stateKeys` | | Reserved for future device classes. `[]` for a spectrum analyzer. |
| `limits` | | `maxCommandsPerSecond`, `burst`, `maxInFlight`. Advisory. |

> **Choose `id` before you publish anything.** It namespaces every
> `deviceTypeId` you ship, and those ids are saved inside users' projects.
> Changing it later strands every device they configured. `npm run rename
> <id>` updates the four places it appears.

## `contract`

```json
"contract": { "core": "1.0", "modules": { "SpectrumAnalyzer": "1.0" } }
```

`core` is mandatory; `modules` names the capability modules you implement.
`SpectrumAnalyzer` is the only one today. A matching **major** version is
treated as compatible.

This is the **only** field that governs compatibility. Not `version`, and
definitely not `template`.

## `products`

One entry per model. A product is a *type* of device; a device is an instance
of one.

```json
{
  "deviceTypeId": "plugin:acme-network/sa-3000",
  "manufacturer": { "id": "acme", "name": "Acme Instruments" },
  "model": { "id": "sa-3000", "name": "SA-3000", "displayName": "Acme SA-3000" },
  "family": { "id": "acme-sa", "name": "Acme SA" },
  "capabilities": { "spectrumAnalyzer": true },
  "traits": { "isSpectrumAnalyzer": true }
}
```

| | |
|---|---|
| `deviceTypeId` | **Required.** Must match `plugin:<your-id>/<model>` exactly. This is what your adapter returns as a device's `product`, and what a saved project records. |
| `manufacturer` | **Required.** `{ id, name }`. |
| `model` | **Required.** `{ id, name, displayName? }`. `displayName` is what the picker shows; `name` is the fallback. |
| `family` | Optional. Groups related models. |
| `capabilities` | What this product can do. `{ "spectrumAnalyzer": true }` for an analyzer. |
| `traits` | Static facts about the model. `{ "isSpectrumAnalyzer": true }`. |

Support several models by listing several products and returning the right
`product` per device from `discoverDevices`. One plugin, one manufacturer's
range, is the usual shape.

## Config fields

Both `deviceConfigFields` and `pluginConfigFields` use one vocabulary, and so
do the [device controls](adapter-reference.md#device-controls) your adapter
declares at `open()`. Learn it once.

```json
{
  "id": "host",
  "type": "textinput",
  "label": "IP address",
  "required": true,
  "help": "The analyzer's address on the show network."
}
```

| Property | | |
|---|---|---|
| `id` | ✓ | The key this field's value appears under. |
| `type` | ✓ | `textinput`, `number`, `dropdown`, `checkbox`, `static-text`. |
| `label` | ✓ | Shown beside the input. |
| `default` | | Value the form starts from when the project has none saved. |
| `required` | | Marks the field mandatory. |
| `secret` | | Masks the input. Note that project data is not encrypted — see the caveat below. |
| `choices` | | `[{ id, label }]`. Required for `dropdown`, ignored otherwise. |
| `unit` | | Suffix shown beside the input, e.g. `dBm`, `Hz`. |
| `min`, `max`, `step` | | For `number`. **Advisory — clamp in the adapter too.** |
| `help` | | Helper text under the input. |

**Which list does a field belong in?**

- **`deviceConfigFields`** — anything that identifies or addresses *one*
  device: an IP address, a port, a serial path, a channel. The values arrive in
  `device.config` and are stored per device in the project, so they travel to
  whoever opens it next.
- **`pluginConfigFields`** — anything that belongs to the plugin as a whole: a
  list of addresses to probe during discovery, a network interface, a
  simulation toggle. The values arrive as the second argument to both your
  exports, and as `this.config`.

**Secrets.** `secret: true` masks the input, but device configuration is stored
in project data that syncs, unencrypted. Do not design a plugin that needs a
password to be safe.

## `template`

```json
"template": { "name": "soundbase-plugin-template", "version": "1.0.0" }
```

Lineage: what this plugin was generated from. It is **never** read to decide
whether a plugin works, and you should copy it in and then leave it alone.

It stays useful precisely by going stale. When a template release notes a fix
to, say, the example error handling, this block is what tells you whether that
fix applies to you. Bumping it to match a template you have not actually merged
destroys the only information it carries.

Two plugins built from different template versions can speak exactly the same
contract, and an old lineage does not make an incompatible plugin compatible.

## A complete example

```json
{
  "manifestVersion": 1,
  "id": "acme-network",
  "name": "Acme Networked Analyzer",
  "version": "0.1.0",
  "license": "MIT",
  "repository": "https://github.com/acme/soundbase-plugin-acme",
  "maintainers": [{ "name": "Acme Instruments", "email": "support@acme.example" }],
  "contract": { "core": "1.0", "modules": { "SpectrumAnalyzer": "1.0" } },
  "runtime": { "type": "node", "entrypoint": "main.js" },
  "deployment": ["managed"],
  "template": { "name": "soundbase-plugin-template", "version": "1.0.0" },
  "products": [
    {
      "deviceTypeId": "plugin:acme-network/sa-3000",
      "manufacturer": { "id": "acme", "name": "Acme Instruments" },
      "model": { "id": "sa-3000", "name": "SA-3000", "displayName": "Acme SA-3000" },
      "family": { "id": "acme-sa", "name": "Acme SA" },
      "capabilities": { "spectrumAnalyzer": true },
      "traits": { "isSpectrumAnalyzer": true }
    }
  ],
  "pluginConfigFields": [
    {
      "id": "addresses",
      "type": "textinput",
      "label": "Analyzer addresses",
      "help": "Comma-separated host or host:port"
    }
  ],
  "deviceConfigFields": [
    { "id": "host", "type": "textinput", "label": "IP address", "required": true },
    { "id": "port", "type": "number", "label": "Port", "default": 5025 }
  ],
  "stateKeys": []
}
```

This is `examples/network-analyzer/soundbase-plugin.json`, and the adapter that
consumes it is beside it.
