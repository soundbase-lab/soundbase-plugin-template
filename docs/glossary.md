# Glossary

Two vocabularies meet in a plugin: RF measurement, and SoundBase's own words
for things. Neither is hard, but a term you have never seen is a term you will
guess at, and guessing at `RBW` produces a plugin that draws a plausible line
nobody can coordinate against.

## RF and spectrum analysis

**Spectrum analyzer** — an instrument that measures how much radio energy is
present at each frequency across a range, and reports it as a curve. Where an
oscilloscope shows amplitude against time, an analyzer shows amplitude against
frequency.

**Sweep** — one pass across the frequency range, producing one complete set of
measurements. A plugin's `startSweep` calls back once per completed sweep.

**Trace** — the result of a sweep: an array of amplitudes, evenly spaced from
the start frequency to the stop frequency. In SoundBase it is the line drawn on
the plot.

**dBm** — decibels relative to one milliwatt: the amplitude unit used
everywhere in this contract. It is logarithmic, so the numbers are small and
usually negative: −100 dBm is a very weak signal, −30 dBm is a strong one, and
every 10 dBm is a factor of ten in power. Never send anything but dBm.

**Hz** — every frequency on the wire is in hertz. Not kHz, not MHz — hertz, as
a plain number. SoundBase's UI shows RBW in kHz and frequencies in MHz, and
converts on its side. `470_000_000` is 470 MHz.

**Start / stop / center / span** — two ways to say the same range. Start and
stop are the edges; center and span are the middle and the width. If both are
supplied, start/stop win. Responses echo all four, consistent with each other.

**Point count** — how many measurements one trace contains. Point `i` sits at
`startHz + i * (stopHz - startHz) / (pointCount - 1)`, so the first point is
exactly at `startHz` and the last exactly at `stopHz`. Getting this off by one
shifts every frequency on the plot.

**Step size (`stepHz`)** — the spacing between adjacent points; the same fact as
point count, expressed the other way. SoundBase users are told to keep it at
0.025 MHz or finer for a scan to be useful, so a device that can only manage a
few hundred points over a wide span will produce coarse-looking data.

**RBW — resolution bandwidth** — how wide a filter the analyzer uses at each
point. Narrow RBW resolves signals that sit close together and hears weaker
ones, but sweeps more slowly; wide RBW is fast and blurry. Most instruments
offer a fixed list of values, which is why `capabilities.rbwHz` is a list and
why a request for something not on it should snap to the nearest, not fail.

**VBW — video bandwidth** — smoothing applied after detection. Reduces the
visual jitter of the noise floor without changing what is really there.
Optional in this contract.

**Noise floor** — the level below which the analyzer measures only its own
noise. A trace is a noise floor with signals sticking out of it. A realistic
floor matters: SoundBase's exclusion threshold is a horizontal line the user
drags, and a plugin reporting an implausible floor makes that line meaningless.

**Reference level** — the top of the analyzer's measurement window. Setting it
too low makes strong signals clip; too high buries weak ones in the floor.

**Attenuation** — deliberate loss at the input, to stop strong local
transmitters overloading the front end. On many instruments this is the knob
that matters most in a busy venue.

**Detector** — how the instrument reduces the many samples taken for one trace
point to the single number it reports: peak, average, sample, quasi-peak. Peak
is the right default for finding interference; average produces a calmer floor.

**Trace mode** — how *successive sweeps* are combined before the trace is
handed to the user:

| Mode | Meaning |
|---|---|
| `clear-write` | each sweep replaces the last — what is there right now |
| `max-hold` | the highest value ever seen at each point |
| `min-hold` | the lowest |
| `average` | a running mean |

`max-hold` is what catches intermittent interference: a transmitter that keys
up for half a second appears once and stays on the display. **The shell
implements all four for you, accumulating at your device's full sweep rate**,
so you report raw sweeps and never think about it.

**Intermodulation (IMD)** — the spurious signals produced when two or more
transmitters mix in a non-linear receiver front end. It is the reason
coordination is hard and the reason a clean-looking band can still fail.
Nothing in a plugin has to compute it; it is what your measurements feed.

**SCPI** — a text command language many instruments speak over TCP, serial or
USB (`*IDN?`, `:FREQ:STAR 470000000`). Not part of this contract, but a very
common thing to find on the other side of a driver.

## SoundBase

**Coord** — the SoundBase application that does frequency coordination and
spectrum analysis. The one your plugin appears in.

**SoundBase Desktop** — the desktop application. Everything hardware-facing,
including your plugin, runs here and only here.

**Project** — one production's data, synced to the whole crew. Device ids and
device configuration live in it, which is why ids must be stable and
addressing must not come from your machine.

**Site** — a venue. **Zone** — an RF area within a site (a stage, a hall).
Live-scan devices are assigned per zone, so several analyzers can run at once.

**Live scan** — streaming a trace from a connected analyzer onto the plot in
real time, as opposed to importing a scan file. This is what your plugin
provides.

**Scan file** — a saved sweep, stored on the site and usable by every zone in
it. Users create one from a live trace with the save button.

**Exclusion threshold** — a dBm line the user drags on the plot; candidate
frequencies measuring above it are rejected automatically. Your amplitudes are
what it tests against.

**The plot** — the main chart: scan traces, TV channels, band plans, exclusion
ranges and every coordinated frequency, on one frequency axis.

**Waterfall / RTSA** — panel views built from a live trace over time, used to
catch interference that comes and goes.

## The plugin system

**Manifest** — `soundbase-plugin.json`. Your identity, your products, and the
configuration fields SoundBase should render. Validated before your plugin is
allowed to start. See [manifest-reference.md](manifest-reference.md).

**Contract** — the versioned HTTP + SSE interface between SoundBase and a
plugin, published as `@soundbase/plugin-contract`. `core` is mandatory;
capability **modules** layer on top. `SpectrumAnalyzer` is the only module
today.

**Shell** — `@soundbase/plugin-shell`, the runtime that implements the whole
contract so you write only device logic. It owns the HTTP server, the
handshake, authentication, the event stream, sweep bookkeeping and trace-mode
accumulation.

**Adapter** — the object you return per device: `open`, `applyConfig`,
`startSweep`, `stopSweep`, `close`. Essentially all of your work.

**Product / `deviceTypeId`** — a model your plugin can provide, declared in the
manifest and namespaced by your plugin id: `plugin:<your-id>/<model>`.

**Device** — one instance of a product: a specific analyzer at a specific
address. Has an id that is stable across restarts.

**Discovery** — reporting hardware your plugin can currently see, so it appears
in the picker without the user typing an address.

**Host** — SoundBase Desktop, in its role as the thing that spawns and
supervises your plugin process.

**Handshake** — the single `SB_PLUGIN_READY {"port":N}` line your process
prints on stdout to say it is listening. No handshake, no plugin.

**Core plugin** — a plugin shipped inside the SoundBase installer, always on
and invisible in the plugin manager. tinySA and USRP are core plugins. Yours
will not be one.

**The Lab** — SoundBase's directory of plugins, and the route by which a user
installs yours. See [publishing.md](publishing.md).
