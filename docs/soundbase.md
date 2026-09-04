# SoundBase, for people who have never used it

You can write a working plugin without ever opening SoundBase. But you will
make better decisions — about defaults, about what to clamp, about what
counts as an error — if you know what the person on the other end is doing
when your device is running. This page is the whole of it in one read.

## The problem SoundBase solves

At any live event of scale — a festival, a broadcast, a theatre, a corporate
keynote — dozens or hundreds of wireless devices share the air: handheld
microphones, beltpack transmitters, in-ear monitors, comms, camera links.
Each needs a frequency. The frequencies must avoid:

- **each other**, including the *intermodulation products* they create when
  mixed in a receiver front end — two transmitters at 500 and 510 MHz
  manufacture interference at 490 and 520 MHz that belongs to neither;
- **licensed users of the same spectrum**, mainly television, which differs by
  country, by city, and increasingly by the week;
- **whatever else is already radiating at that venue** — the other production
  in the next hall, a wireless camera system nobody told you about, a noisy LED
  wall.

Getting this wrong sounds like a burst of static in a broadcast heard by
millions, and you cannot fix it during the show. **SoundBase is the tool
audio teams use to get it right**, and to keep it right while the show runs:
frequency coordination, spectrum measurement, hardware control and live
monitoring, in one project the whole crew shares.

The application your plugin lives in is called **Coord**. It is SoundBase's
flagship; the platform has others, and they are not relevant here.

## Why measurement matters, and where you come in

A coordination built purely from theory is a guess about a room you have never
stood in. So the workflow is: **go to the venue, measure what is actually in
the air, and coordinate against the measurement.**

That measurement is a **scan** — amplitude against frequency, captured at the
venue with a spectrum analyzer. In SoundBase a scan is not decoration. It:

- draws as a trace on the plot behind every coordinated frequency;
- **rejects candidate frequencies automatically** when the measured amplitude
  at that frequency exceeds the user's exclusion threshold;
- shows each candidate's measured amplitude so a coordinator can prefer the
  quietest;
- decides which TV channels are actually receivable in this building;
- feeds the health checks that flag problems during the show.

Users can upload scan files exported from an analyzer, but the tool they reach
for is **live scan**: connect an analyzer, watch a continuously updating trace
on the plot, and save any sweep as a scan file. The analyzer can be told to
follow the plot — zoom in on the plot and the hardware retunes to match.

**A spectrum-analyzer plugin is a live-scan device.** When someone connects
your plugin's device, your sweeps become that cyan trace, and the numbers you
return decide which frequencies the software is willing to use. That is the
whole reason the amplitude scale and trace geometry are worth being careful
about — see [glossary.md](glossary.md) if `dBm`, `RBW` or *noise floor* are new
to you.

## The parts of the product a plugin touches

**SoundBase Desktop.** SoundBase runs both in a browser and as a desktop app.
Everything that talks to hardware is desktop-only, because it has to live on
the same machine as the USB cable. Your plugin is spawned by the desktop app
and never exists in the browser. Collaborators in the browser can see a live
trace streamed to them; they cannot host the device.

**Projects.** A project holds a whole production and syncs to everyone on the
crew. It records which devices are in use and how they are addressed. This is
why two rules in this repository are non-negotiable:

- **device ids must be stable across restarts** — the id is stored in the
  project, and next week's show reopens it;
- **addressing arrives explicitly**, in the device SoundBase asks you to open —
  never from a file beside your plugin. The same project gets opened on the
  other engineer's laptop, and that laptop has never seen your config.

**Sites and zones.** A site is a venue; a zone is an RF area within it (a
stage, a hall, a truck). Live-scan devices are assigned **per zone**, so one
site can run several analyzers at once, and yours may be one of several. Your
plugin can be asked for more than one device at a time, and each is
independent.

**The plot.** One chart: TV channels, cellular blocks, band plans, exclusion
ranges, every coordinated frequency, and the scan traces. A live trace also
feeds the **waterfall** and **RTSA** views, which are what people use to catch
interference that comes and goes — which is exactly why the shell accumulates
`max-hold` at your device's full sweep rate rather than at the rate the UI
happens to poll. A transient that appears on one sweep in seven must not be
lost because nobody was looking.

**The device picker.** Users choose a live-scan device from a dropdown in the
plot's Live Scan Data Settings. Today it lists first-party integrations
(tinySA over USB, Owon over SCPI, Wisycom, Sennheiser Spectera, and a generic
analyzer bridge). **A plugin's devices appear in that same list**, described by
the `products` in your manifest, and are configured by the fields your manifest
declares. Nothing about your device is special-cased in SoundBase — which is
the point: your plugin can ship a new instrument without SoundBase shipping
anything.

## What SoundBase never learns about your device

This is the load-bearing idea of the whole architecture, so it is worth stating
plainly.

SoundBase knows: how to draw a trace, how to offer a frequency range, a point
count and a resolution bandwidth, and how to render a form from a list of field
descriptors. That is all.

It does not know what your instrument is, what a detector is, what your
attenuator does, or what your protocol looks like. When your device needs a
knob SoundBase has never heard of, you declare it as a
[control](adapter-reference.md#device-controls) and SoundBase renders it,
stores the user's value, and hands it back to you verbatim. **Adding a knob to
a shipped plugin does not require a SoundBase release**, and neither does
shipping an entirely new instrument.

The corollary is that SoundBase cannot help your device look good. Sensible
defaults, honest capability limits and clamping-rather-than-rejecting are
entirely yours to get right.

## Who your users are

Not developers. RF coordinators and audio engineers, often in a loading dock,
often an hour before doors, frequently with the venue's Wi-Fi as their only
network. When something is wrong they will not read a stack trace; they will
see a device that says it is broken, or worse, a device that says it is fine
and draws a flat line.

Two habits follow from that, and they run through the rest of these docs:

- **Fail loudly and specifically.** A device error with a real message
  ("serial port /dev/tty.usbmodem401 is no longer present") is worth ten
  generic ones. See `onFatal` in
  [adapter-reference.md](adapter-reference.md#onfatal-assigned-to-you).
- **Never reject what you can clamp.** If someone asks for a 12.345 kHz
  resolution bandwidth and your hardware offers 10 kHz, use 10 kHz and say so.
  An error just looks like your plugin is broken.

## Where to go next

- [architecture.md](architecture.md) — how a plugin is actually wired to the app
- [glossary.md](glossary.md) — the RF and SoundBase words used throughout
- [getting-started.md](getting-started.md) — get it running
