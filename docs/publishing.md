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
  soundbase-plugin.json        valid, with `license` and `platforms` set
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
  is fine), the manifest valid, `manifest.license` set, and
  `manifest.platforms` naming at least one Desktop build target;
- the tag's commit differs from the previously released one, and the manifest
  version has never been released on this listing.

SoundBase Desktop then re-checks the download: size and archive limits, path
traversal, manifest validity, that `platforms` includes the machine it is on,
an entrypoint that resolves inside the folder,
and a **boot probe** — it spawns the plugin and waits for the handshake before
installing it. Nothing outside a staging folder is touched until that probe
passes, so a bad release cannot damage a working install.

## Cutting a release

Two routes, and they produce the same zip. Pick one.

### From the Actions tab, on CI

The shortest path, with nothing to run locally: **Actions → Release → Run
workflow**, set `bump` to `patch`, `minor` or `major` (or type an exact
`version`). The run moves the version in all three files that carry it —
`soundbase-plugin.json`, `package.json`, `package-lock.json` — makes the
release commit and the `v<version>` tag, then runs `doctor`, `manifest`, the
tests and the pack against that commit. Only if all of that passes does it
push the commit and the tag to `main` and publish the Release; a red run
leaves `main` exactly as it was.

`bump: none` (the default) is the rehearsal: the same build, the zip attached
to the run as the `plugin-zip` artifact, no Release — and the run's summary
says so, with the command that would publish.

Two things worth knowing: the run pushes to `main`, so if `main` is protected
the Actions identity needs to be on the ruleset's bypass list (or the push
fails, before anything is published); and if `main` moved while the run was
going, the push is refused and nothing is published — run it again.

### From a tag, on CI

`npm run bump 0.5.0` moves the version in every file that carries it. Commit
that, then:

```bash
git tag v0.5.0 && git push origin v0.5.0
```

`.github/workflows/release.yml` takes it from there: it installs, re-runs
`doctor`, `manifest` and the tests against the tagged commit, drops the dev
dependencies, packs the zip, boots the packed folder the way the installer's
probe does, checks it against the Lab's rules above, and publishes a GitHub
Release with the zip attached and generated notes.

Nothing to configure — it uses the token GitHub gives the workflow. The tag has
to match the manifest version, and it refuses the release rather than shipping
a version nobody wrote down.

The same packing step runs locally, which is the way to see what your users
will get before you tag anything:

```bash
npm ci && npm prune --omit=dev
npm run pack:release            # dist/<id>-<version>.zip, boot-checked
```

It needs no SoundBase checkout: your dependencies come from your own
`node_modules`, because both SDK packages are on public npm.

Then, in the Lab: **my submissions → update release → `v0.5.0`**, and wait for
approval.

## Versioning

| | |
|---|---|
| `version` | **yours.** Semver it however you like. It must increase for each release on a listing. |
| `contract` | **compatibility.** A matching major version is compatible. |
| `template` | **lineage.** Leave it alone; see [manifest-reference.md](manifest-reference.md#template). |

Bump `version` in `soundbase-plugin.json`, `package.json` and
`package-lock.json` together — `npm run bump` does this for you.

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

> The `LICENSE` in this repository is the finalised SDK licence: Business
> Source License 1.1, Licensor Show Code, Corp., converting to the Apache
> License 2.0 on September 5, 2030. It covers the template code you started
> from. If your plugin ships under a licence of its own, replace the file and
> set `license` in the manifest to match; `npm run doctor` checks that a
> `LICENSE` is present and that the manifest names one.

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
