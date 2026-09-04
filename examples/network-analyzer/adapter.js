// A worked adapter for a networked instrument.
//
// Everything the synthetic adapter in the repo root does not show:
//
//   - discovery driven by plugin configuration, probing addresses
//   - device addressing taken from `device.config`, never from this machine
//   - device controls declared at open() from what the hardware admits to
//   - clamping by echoing what the instrument settled on
//   - a fatal transport error reported through onFatal
//   - close() that actually releases a socket
//
// It is a complete plugin: examples/network-analyzer/main.js and
// soundbase-plugin.json sit beside it, and the test boots the pair under the
// real shell against a fake instrument.

import { AnalyzerClient, probe } from './driver/analyzer-client.js';

export const PRODUCT = 'plugin:acme-network/sa-3000';

const DEFAULT_PORT = 5025;
const MIN_FREQUENCY_HZ = 9_000;
const MAX_FREQUENCY_HZ = 3_000_000_000;
const RBW_HZ = [1_000, 10_000, 100_000, 1_000_000];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Devices reachable right now.
 *
 * The shell calls this once a second while SoundBase is enumerating, and never
 * otherwise — an idle plugin does no discovery I/O at all. Keep it cheap and
 * keep it silent: an address with nothing on it is a normal result, not an
 * error.
 *
 * `pluginConfig` holds the manifest's `pluginConfigFields`, which is where a
 * network plugin gets its addresses from: there is no broadcast discovery for
 * an instrument on an arbitrary subnet, so the user types them in once.
 */
export async function discoverDevices(pluginConfig = {}) {
  const addresses = parseAddresses(pluginConfig.addresses);
  const found = await Promise.all(
    addresses.map(async ({ host, port }) => {
      const identity = await probe({ host, port });
      if (!identity) return null;
      return {
        // Stable across restarts, because it is derived from the address and
        // nothing else. It goes into URLs and into the user's saved project.
        id: `net:${host}:${port}`,
        name: `${identity.model} (${host})`,
        product: PRODUCT,
        transport: { kind: 'network', host, port },
      };
    })
  );
  return found.filter(Boolean);
}

/** "192.168.1.50, 192.168.1.51:5026" -> [{host, port}, …] */
function parseAddresses(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(':');
      return { host, port: Number(port) || DEFAULT_PORT };
    });
}

export function createSpectrumAnalyzerAdapter(device) {
  return new NetworkAnalyzerAdapter(device);
}

class NetworkAnalyzerAdapter {
  constructor(device) {
    // Addressing arrives explicitly, in the device the host asked for. Never
    // read it from a file beside the plugin: the same project opened on another
    // machine has to work, and that machine has never seen your config.
    const { host, port } = addressOf(device);
    this.host = host;
    this.port = port;
    this.client = null;
    this.effective = null;
    this.sweeping = false;
    /** assigned by the shell; call it when the transport dies unprompted */
    this.onFatal = null;
  }

  /**
   * Connect and identify. Whatever this returns is what SoundBase constrains
   * its UI to, so report what this particular unit can do — not what the
   * product line can do.
   */
  async open() {
    this.client = new AnalyzerClient({ host: this.host, port: this.port });
    this.client.onFatal = (err) => this.onFatal?.(err);
    await this.client.connect();
    const identity = await this.client.identify();

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        rbwHz: [...RBW_HZ],
        // Knobs SoundBase has never heard of. It renders them beside RBW and
        // point count and hands the values back in cfg.controls, keyed by
        // these ids — so adding one needs no SoundBase release. Built here,
        // rather than declared in the manifest, so the ranges can come from
        // the unit we just identified.
        controls: [
          {
            id: 'attenDb',
            type: 'number',
            label: 'Input attenuation',
            unit: 'dB',
            default: 0,
            min: 0,
            max: 30,
            step: 5,
            help: 'Raise this if strong local transmitters are compressing the front end.',
          },
          {
            id: 'detector',
            type: 'dropdown',
            label: 'Detector',
            default: 'peak',
            choices: [
              { id: 'peak', label: 'Peak' },
              { id: 'average', label: 'Average' },
            ],
          },
        ],
      },
      identity: {
        model: identity.model,
        firmware: identity.firmware,
        manufacturer: identity.manufacturer,
      },
    };
  }

  /**
   * Apply what was asked for and return what actually happened.
   *
   * Two rules, both of which look like pedantry until a user reports a bug:
   *
   *   - Clamp, do not reject. A 400 makes a working plugin look broken; a
   *     clamped value tells the user what the instrument can do.
   *   - Echo the *effective* configuration. It is what
   *     `GET /devices/{id}/configuration` reports, so it is the only way the
   *     host can show what is really in force.
   *
   * Fields absent from `cfg` are unchanged. `cfg.controls` is merged by id, so
   * a request carrying one control leaves the others alone.
   */
  async applyConfig(cfg = {}) {
    const previous = this.effective ?? { controls: {} };
    const startHz = isNum(cfg.startHz)
      ? cfg.startHz
      : (previous.startHz ?? 470_000_000);
    const stopHz = isNum(cfg.stopHz)
      ? cfg.stopHz
      : (previous.stopHz ?? 616_000_000);

    // the instrument clamps and echoes, so the echo is the effective value
    const [rangeStart, rangeStop] = await this.client.setting(
      `RANGE ${Math.round(startHz)} ${Math.round(stopHz)}`
    );

    const pointCount = isNum(cfg.pointCount)
      ? cfg.pointCount
      : (previous.pointCount ?? 401);
    const [points] = await this.client.setting(
      `POINTS ${Math.round(pointCount)}`
    );

    const effective = {
      startHz: Number(rangeStart),
      stopHz: Number(rangeStop),
      pointCount: Number(points),
      controls: { ...previous.controls },
    };

    // Omitting rbwHz means "the instrument's choice". Report what it chose
    // under `resolved` rather than inventing a value for `rbwHz` — the host
    // shows the user's field as auto and the resolved value beside it.
    if (isNum(cfg.rbwHz)) {
      const [rbw] = await this.client.setting(`RBW ${Math.round(cfg.rbwHz)}`);
      effective.rbwHz = Number(rbw);
    } else if (isNum(previous.rbwHz)) {
      effective.rbwHz = previous.rbwHz;
    } else {
      const [rbw] = await this.client.setting('RBW 100000');
      effective.resolved = { rbwHz: Number(rbw) };
    }

    const controls = cfg.controls ?? {};
    if (controls.attenDb !== undefined) {
      const [atten] = await this.client.setting(
        `ATTEN ${Math.round(Number(controls.attenDb))}`
      );
      effective.controls.attenDb = Number(atten);
    }
    if (controls.detector !== undefined) {
      const [detector] = await this.client.setting(
        `DETECTOR ${controls.detector}`
      );
      effective.controls.detector = detector;
    }

    this.effective = effective;
    return effective;
  }

  /**
   * Sweep until told to stop, calling `onTrace(amplitudesDbm)` once per
   * completed sweep. One array of numbers, `pointCount` long, ordered from
   * startHz to stopHz — the shell builds the frequency axis, the sweep id, the
   * timestamp and the trace-mode accumulation from the effective config.
   *
   * Loop rather than setInterval: an instrument slower than the interval would
   * otherwise pile up overlapping reads on one socket.
   */
  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    (async () => {
      while (this.sweeping) {
        try {
          const amplitudes = await this.client.sweep();
          if (this.sweeping) onTrace(amplitudes);
        } catch (err) {
          // one bad read is not necessarily a dead instrument; the client's
          // own close/error handling calls onFatal when it really is
          if (!this.sweeping) return;
          this.onFatal?.(err);
          return;
        }
      }
    })();
  }

  async stopSweep() {
    this.sweeping = false;
  }

  /** Release the transport. Called on removal, teardown, and after a fatal. */
  async close() {
    this.sweeping = false;
    this.client?.close();
    this.client = null;
  }
}

/**
 * `device.config` holds the manifest's `deviceConfigFields`, filled in from the
 * SoundBase project. The id fallback covers a device this plugin discovered
 * itself, whose id already encodes the address.
 */
function addressOf(device) {
  const config = device.config ?? {};
  if (config.host)
    return { host: config.host, port: Number(config.port) || DEFAULT_PORT };
  const match = /^net:([^:]+)(?::(\d+))?$/.exec(device.id ?? '');
  if (match) return { host: match[1], port: Number(match[2]) || DEFAULT_PORT };
  throw new Error(
    `device ${device.id} has no address: set "host" in its configuration`
  );
}
