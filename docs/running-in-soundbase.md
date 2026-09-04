# Running your plugin in SoundBase

Everything up to here works without SoundBase installed. This page is the last
step: getting your plugin into the app and seeing its trace on the plot.

## Before you start

- **SoundBase Desktop.** Plugins are spawned by the desktop app. There is no
  browser path — the browser cannot reach your USB cable.
- **The `plugin-system` feature flag,** enabled for your account. Third-party
  drop-in plugins are gated behind it while the plugin system is in
  development. Ask your SoundBase contact to switch it on; without it your
  plugin is scanned, listed as disabled, and never spawned.

## Where the plugin folder goes

SoundBase scans `<userData>/plugins` for folders containing a
`soundbase-plugin.json`. Each direct child of that directory is one plugin.

| | |
|---|---|
| macOS | `~/Library/Application Support/SoundBase Desktop/plugins` |
| Windows | `%APPDATA%\SoundBase Desktop\plugins` |
| Linux | `~/.config/SoundBase Desktop/plugins` |

```
plugins/
  my-plugin/
    soundbase-plugin.json
    main.js
    adapter.js
    node_modules/          ← must be present; nothing installs it for you
```

**The dependencies have to be there.** SoundBase runs `main.js` as-is; it does
not install anything. A folder without `node_modules/@soundbase/plugin-shell`
fails at its first import, which looks exactly like a plugin that never
handshakes.

### The development shortcut

Copying a folder after every edit gets old immediately. Instead, point
SoundBase at your working tree with the `SB_PLUGIN_DIRS` environment variable —
a path-separated list of extra scan roots:

```bash
# macOS
SB_PLUGIN_DIRS="$HOME/CODE" open -a "SoundBase Desktop"
```

Point it at the *parent* of your plugin folder, not at the plugin folder
itself: a scan root contains plugins, it is not one.

`SB_PLUGIN_DIRS` roots are for development only. Installs from the Lab always
land in `<userData>/plugins`, never in one of these.

## The plugin manager

Once the folder is in place and the flag is on, your plugin appears in
**Settings → Plugins**, where a user can:

- see its name, version and status, and any manifest error that stopped it;
- enable or disable it (disabled plugins are not spawned);
- fill in the `pluginConfigFields` your manifest declares;
- read its log;
- rescan, after you have dropped in a new folder.

A plugin whose manifest fails validation is listed with its error rather than
silently skipped — one bad drop-in never stops the others.

## Seeing a device

Your devices appear where every other live-scan device appears:

1. Open a project in **Coord** and go to the plot.
2. In the plot's control bar, open the gear in the live-scan group — **Open
   Live Scan Data Settings**.
3. Your discovered devices are in the **Select a device** dropdown, named by
   what `discoverDevices` returned. Products that need addressing typed in
   appear as an "add a device" option, with the form your
   `deviceConfigFields` describe.
4. Save, then press **Live** to start sweeping. Your trace draws on the plot,
   and the sweep parameters (start/stop/centre/span, RBW, points, and any
   controls your adapter declared) are in the same dialog.

Device assignment is **per zone**, so a site can run several analyzers at once
and yours may be one of them.

## Reading the logs

Every line your plugin writes to stdout after the handshake is captured by the
host, per plugin:

| | |
|---|---|
| macOS | `~/Library/Application Support/SoundBase Desktop/pluginLogs/<id>.log` |
| Windows | `%APPDATA%\SoundBase Desktop\pluginLogs\<id>.log` |
| Linux | `~/.config/SoundBase Desktop/pluginLogs/<id>.log` |

The same lines are shown in the plugin manager. The shell prefixes its own with
a timestamp and level; `this.log('info', …)` from your plugin class joins them.

The first two lines after a successful start tell you which build is running:

```
[info] my-plugin 0.3.0 listening on 127.0.0.1:54321
[info] generated from soundbase-plugin-template 1.0.0
```

For a packed release that second line reads `packed sha256:… at <date>
(contract core 1.0, SpectrumAnalyzer 1.0)` instead — which is how support
works out *which copy* of your plugin a user is running.

## What the host does to your process

| | |
|---|---|
| Spawn | `main.js`, with `SB_PLUGIN_TOKEN` in the environment |
| Handshake | 10 s to print `SB_PLUGIN_READY`, then it gives up |
| Health | `GET /health` every 5 s; 3 consecutive failures counts as a crash |
| Restart | backoff 1, 2, 4, 8, 16 s; 5 restarts, then it stays down |
| Shutdown | best-effort `DELETE /devices`, then `SIGTERM`, then `SIGKILL` |

Enabling and disabling a plugin, and switching projects, both go through the
same path.

## When it does not appear

Work through [troubleshooting.md](troubleshooting.md). The short version: run
`npm run doctor` and then `npm run smoke` in the plugin folder — between them
they cover every failure that produces no visible error at all.
