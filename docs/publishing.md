# Publishing a plugin

How a plugin gets from your machine to a user's.

## The route

SoundBase's **Lab** is a directory of plugins. A listing points at your GitHub
repository, and a release is a **GitHub Release with a zip attached**. When a
user installs your plugin, SoundBase downloads that zip, verifies it, extracts
it, boots it once as a check, and moves it into place.

You keep control of the code, the repository and the release cadence. SoundBase
curates listings and approves releases.

```
your repo  ──►  git tag + GitHub Release (one .zip asset)
                        │
                submit the tag in the Lab
                        │
                   approval
                        │
                SoundBase Desktop downloads, verifies, boots, installs
```

## What the zip has to contain

A **runnable plugin folder** — not a source checkout. That means dependencies
included, because nothing installs them on the user's machine.

```
my-plugin/                     one top-level folder is expected
  soundbase-plugin.json        valid, and with `license` set
  LICENSE                      required, at the root
  main.js
  adapter.js
  package.json
  node_modules/                real, installed dependencies
```

What the Lab checks when you submit a tag:

- a **published** (non-draft) GitHub Release on that tag;
- **exactly one** `.zip` asset, at most **250 MB**;
- `soundbase-plugin.json` and a `LICENSE` at the zip root (one top-level folder
  is fine), the manifest valid, and `manifest.license` set;
- the tag's commit differs from the previously released one, and the manifest
  version has never been released on this listing.

SoundBase Desktop then re-checks the download: size and archive limits, path
traversal, manifest validity, an entrypoint that resolves inside the folder,
and a **boot probe** — it spawns the plugin and waits for the handshake before
installing it. Nothing outside a staging folder is touched until that probe
passes, so a bad release cannot damage a working install.

## Cutting a release

```bash
node scripts/release.mjs 0.5.0
node scripts/release.mjs 0.5.0 --notes "Adds the SA-6000"
node scripts/release.mjs --dry-run     # build the zip only; git is untouched
```

It bumps the version in both `soundbase-plugin.json` and `package.json`,
commits and tags, builds the zip, boots the packed result the way the installer
does, verifies the zip against the Lab's rules, pushes, and publishes the
GitHub Release with the zip attached. Every command it runs is echoed as
`$ …` so you can repeat any step by hand.

It refuses to run on a dirty tree, on a branch other than `main`, or with a tag
that already exists — a release commit should carry the version bump and
nothing else.

> **`release.mjs` currently needs a SoundBase checkout** (`--sb <path>`,
> `SB_ROOT`, or the first `~/CODE/SoundBase*` it finds), because it builds the
> zip by shelling out to SoundBase's `plugins/pack-plugin.mjs`.
>
> That is now the only reason. The SDK packages are on public npm, so the
> dependencies in your zip could come from an ordinary `npm ci --omit=dev` and
> this script could get much shorter — it just has not been rewritten yet.
> Until it is, the checkout is still required. Read it before you rely on it —
> it is short and it echoes every command it runs.

Then, in the Lab: **my submissions → update release → `v0.5.0`**, and wait for
approval.

## Versioning

| | |
|---|---|
| `version` | **yours.** Semver it however you like. It must increase for each release on a listing. |
| `contract` | **compatibility.** A matching major version is compatible. |
| `template` | **lineage.** Leave it alone; see [manifest-reference.md](manifest-reference.md#template). |

Bump `version` in both `soundbase-plugin.json` and `package.json` together —
`release.mjs` does this for you and refuses to continue if it cannot.

## Licensing

**Two separate licences are involved.** Do not conflate them.

**Your plugin code is yours.** Licence it however you want: MIT, proprietary,
commercial. You may sell it.

**The SDK you build on** — `@soundbase/plugin-contract`,
`@soundbase/plugin-shell`, this template — is under the **Business Source
License 1.1**: source available, not open source. Read the Additional Use
Grant in [`LICENSE`](../LICENSE). In short: it permits developing,
distributing and operating plugins for SoundBase, **including commercially**;
it does not permit using this code with anything that is not SoundBase. Each
version converts to the Change License named in `LICENSE` on its Change Date.

> The `LICENSE` in this repository still carries `<<<PLACEHOLDER:` markers
> while the SDK licence is finalised. `npm run doctor` warns about it. Replace
> the file with your own plugin's licence, or wait for the finalised text
> before publishing.

The Lab refuses a release with no `LICENSE` file or no `license` in the
manifest. That is not bureaucracy: a repository with no licence is
all-rights-reserved by default, and a user has no idea what they may do with
it.

## What users are trusting

Say so plainly in your README, because it is true: **installing a plugin means
trusting its author.** The process boundary between SoundBase and your plugin
is fault isolation, not a security sandbox — your code runs with the user's
privileges, like a VST or a Companion module. `repository` and `maintainers` in
your manifest are shown to users deciding whether to trust you; fill them in.

## Before you tag

```bash
npm run doctor    # id changed, licence real, manifest valid, main.js untouched
npm test
npm run smoke
```

And check by hand:

- the plugin **id** is yours and final — it is stored in users' projects and
  cannot be changed painlessly later;
- `repository` and `maintainers` in the manifest are filled in;
- the README says what hardware it supports and what it does not;
- `template` has not been bumped to a version you never merged.
