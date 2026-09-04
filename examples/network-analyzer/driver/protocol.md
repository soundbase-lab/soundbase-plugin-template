# The made-up instrument protocol used by this example

Line-based, over TCP. One request per line, one response per line, ASCII.

| Request | Response | Notes |
|---|---|---|
| `*IDN?` | `ACME,SA-3000,1.4.2` | manufacturer, model, firmware |
| `RANGE <startHz> <stopHz>` | `OK <startHz> <stopHz>` | clamped to the instrument's range |
| `POINTS <n>` | `OK <n>` | clamped to 2…4001 |
| `RBW <hz>` | `OK <hz>` | snapped to the nearest supported value |
| `ATTEN <db>` | `OK <db>` | clamped to 0…30 |
| `DETECTOR <peak\|average>` | `OK <name>` | unknown values fall back to `peak` |
| `SWEEP?` | `-98.2,-97.4,…` | one comma-separated sweep, `POINTS` values |

Every setting command echoes what the instrument actually settled on, which is
what makes "clamp, don't reject" easy to honour in the adapter: the adapter
reports the echo rather than the request.

Real instruments are rarely this tidy. The point of the example is the shape of
the adapter around a wire protocol, not the protocol itself.
