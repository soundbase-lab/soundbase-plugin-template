// Synthetic adapters — one per module — for the two products the manifest
// declares. Replace this file (and, for anything with a wire protocol, a
// driver/ beside it) to build a real plugin: main.js, the manifest shape and
// the shell stay exactly as they are. A plugin that only does one of the two
// things below simply does not export the other factory.

import { HttpError } from '@soundbase/plugin-shell';

// The products these adapters announce their devices as. Each MUST be one of
// the `deviceTypeId`s declared in soundbase-plugin.json — the shell warns and
// the host ignores a device naming a product the manifest never declared.
// `npm run rename` keeps them in step; a test asserts they agree.
export const PRODUCT = 'plugin:template/synthetic';
export const IEM_PRODUCT = 'plugin:template/synthetic-iem';

// ---------------------------------------------------------------------------
// SpectrumAnalyzer: a synthetic spectrum
// ---------------------------------------------------------------------------

const MIN_FREQUENCY_HZ = 100_000;
const MAX_FREQUENCY_HZ = 6_000_000_000;
const RBW_HZ = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000];
const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;
const DEFAULT_POINT_DIVISOR = 450;
const MAX_POINTS = 2000;
const SWEEP_INTERVAL_MS = 50;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// a gaussian "signal" bump, height in dB above the noise floor
const bump = (f, center, width, height) =>
  height * Math.exp(-(((f - center) / width) ** 2));

const nearestRbw = (hz) =>
  RBW_HZ.reduce((best, candidate) =>
    Math.abs(candidate - hz) < Math.abs(best - hz) ? candidate : best
  );

class SyntheticAnalyzerAdapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.sweepIntervalMs = isNum(pluginConfig.sweepIntervalMs)
      ? pluginConfig.sweepIntervalMs
      : SWEEP_INTERVAL_MS;
    this.config = {
      startHz: DEFAULT_START_HZ,
      stopHz: DEFAULT_STOP_HZ,
      pointCount: DEFAULT_POINT_DIVISOR + 1,
      rbwHz: undefined,
    };
    this.sweepCount = 0;
    this.timer = null;
    this.onFatal = null;
  }

  async open() {
    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        rbwHz: [...RBW_HZ],
      },
      identity: { model: 'Synthetic', firmware: '0.1.0' },
    };
  }

  async applyConfig(cfg = {}) {
    const startHz = clamp(
      isNum(cfg.startHz) ? cfg.startHz : this.config.startHz,
      MIN_FREQUENCY_HZ,
      MAX_FREQUENCY_HZ
    );
    const stopHz = clamp(
      isNum(cfg.stopHz) ? cfg.stopHz : this.config.stopHz,
      startHz + 1,
      MAX_FREQUENCY_HZ
    );
    const span = Math.max(1, stopHz - startHz);
    let pointCount;
    if (isNum(cfg.pointCount)) {
      pointCount = Math.round(cfg.pointCount);
    } else {
      const step =
        isNum(cfg.stepHz) && cfg.stepHz > 0
          ? cfg.stepHz
          : span / DEFAULT_POINT_DIVISOR;
      pointCount = Math.round(span / step) + 1;
    }
    this.config = {
      startHz,
      stopHz,
      pointCount: clamp(pointCount, 2, MAX_POINTS),
      rbwHz: isNum(cfg.rbwHz) ? nearestRbw(cfg.rbwHz) : undefined,
    };
    return { ...this.config };
  }

  async startSweep(onTrace) {
    if (this.timer) return;
    this.timer = setInterval(
      () => onTrace(this.buildTrace()),
      this.sweepIntervalMs
    );
    this.timer.unref?.();
  }

  async stopSweep() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async close() {
    await this.stopSweep();
  }

  buildTrace() {
    const { startHz, stopHz, pointCount } = this.config;
    const span = Math.max(1, stopHz - startHz);
    const amps = new Array(pointCount);
    const peakA = startHz + span * 0.33;
    const peakB = startHz + span * 0.66;
    const transient = startHz + span * 0.5;
    this.sweepCount += 1;
    // a transient on roughly one sweep in seven — this is why max-hold has to
    // accumulate every sweep, not just the ones a client happens to poll
    const withTransient = this.sweepCount % 7 === 0;
    for (let i = 0; i < pointCount; i += 1) {
      const f = startHz + (i * (stopHz - startHz)) / (pointCount - 1);
      let amp = -100 + (Math.random() * 4 - 2);
      amp += bump(f, peakA, span * 0.01, 45);
      amp += bump(f, peakB, span * 0.006, 30);
      if (withTransient) amp += bump(f, transient, span * 0.003, 50);
      amps[i] = round1(amp);
    }
    return amps;
  }
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new SyntheticAnalyzerAdapter(device, pluginConfig);
}

// ---------------------------------------------------------------------------
// ChannelMonitoring + PropertyControl: a synthetic stereo IEM transmitter
// ---------------------------------------------------------------------------
//
// Two stereo channels, each with a bodypack receiver paired to it. Audio
// meters move on a slow sine so the bars visibly breathe; the packs drain
// their batteries and wobble their RF. Every property the layout shows is
// writable through `setProperty`, and the new value comes back as state —
// which is the whole PropertyControl idea: the device is the truth.

const IEM_CHANNEL_COUNT = 2;
const IEM_MIN_MHZ = 470;
const IEM_MAX_MHZ = 608;
const IEM_STEP_MHZ = 0.025;
const IEM_NAME_MAX = 8; // mirrors the manifest's channelName.maxLength
const TX_POWER_MW = [10, 50, 100];
// The shell coalesces `meters` to one patch per 50 ms tick, so reporting any
// faster than that is wasted work; a real device reports at whatever rate it
// has and lets the shell do the coalescing.
const METER_INTERVAL_MS = 50;
const PACK_INTERVAL_MS = 1_000;

const quantize = (v, step) => Math.round(v / step) * step;
const round3 = (v) => Math.round(v * 1000) / 1000;
const nearestTxPower = (mw) =>
  TX_POWER_MW.reduce((best, candidate) =>
    Math.abs(candidate - mw) < Math.abs(best - mw) ? candidate : best
  );

class SyntheticIemAdapter {
  constructor(device) {
    this.device = device;
    this.channels = {
      1: {
        channelName: 'VOX L',
        frequency: 518.1,
        txPower: 50,
        mute: false,
        rfState: true,
      },
      2: {
        channelName: 'VOX R',
        frequency: 542.35,
        txPower: 50,
        mute: false,
        rfState: true,
      },
    };
    this.packs = {
      'pack:1': {
        id: 'pack:1',
        name: 'Pack 1',
        channel: 1,
        battery: { percent: 92, lifetimeInMinutes: 410 },
        meters: { rf1: -55, lqi: 96 },
      },
      'pack:2': {
        id: 'pack:2',
        name: 'Pack 2',
        channel: 2,
        battery: { percent: 61, lifetimeInMinutes: 230 },
        meters: { rf1: -63, lqi: 88 },
      },
    };
    this.phase = 0;
    this.meterTimer = null;
    this.packTimer = null;
    // assigned by the shell before open()
    this.onState = null;
    this.onWarnings = null;
    this.onFatal = null;
  }

  async open() {
    // the complete state first, so SoundBase renders a full card at once
    for (const key of [
      'channelName',
      'frequency',
      'txPower',
      'mute',
      'rfState',
    ])
      this.emitChannelKey(key);
    this.onState?.('receivers', {
      added: Object.values(this.packs).map((pack) => ({ ...pack })),
      updated: [],
      removed: [],
    });
    // an extension key: which pack each channel feeds, something SoundBase
    // has no core key for. Declared in the manifest's stateKeys.
    this.onState?.('x.template.packLink', {
      channels: { 1: 'pack:1', 2: 'pack:2' },
    });
    this.meterTimer = setInterval(() => this.tickMeters(), METER_INTERVAL_MS);
    this.meterTimer.unref?.();
    this.packTimer = setInterval(() => this.tickPacks(), PACK_INTERVAL_MS);
    this.packTimer.unref?.();
    return {
      channelCount: IEM_CHANNEL_COUNT,
      properties: this.properties(),
      identity: { model: 'Synthetic IEM', firmware: '0.1.0' },
    };
  }

  async close() {
    clearInterval(this.meterTimer);
    clearInterval(this.packTimer);
    this.meterTimer = null;
    this.packTimer = null;
  }

  /** PropertyControl descriptors, in SoundBase's PropertyDescriptor shape. */
  properties() {
    const channel = (id, value) => ({
      id,
      scope: 'channel',
      access: 'readWrite',
      stateBinding: { key: id },
      value,
    });
    return [
      channel('txPower', { type: 'enum', options: TX_POWER_MW, unit: 'mW' }),
      channel('mute', { type: 'boolean' }),
      channel('frequency', {
        type: 'number',
        min: IEM_MIN_MHZ,
        max: IEM_MAX_MHZ,
        step: IEM_STEP_MHZ,
        unit: 'MHz',
      }),
      channel('channelName', { type: 'string', maxLength: IEM_NAME_MAX }),
    ];
  }

  /** `{ requestId, propertyId, channelIndex?, entityId?, value }` → applied, then reported. */
  async setProperty({ propertyId, channelIndex, value }) {
    const ch = this.channels[channelIndex];
    if (!ch) {
      throw new HttpError(
        400,
        'unknown_channel',
        `${propertyId} is per channel; channelIndex must be 1..${IEM_CHANNEL_COUNT}`
      );
    }
    switch (propertyId) {
      case 'txPower':
        if (!isNum(value)) throw badValue(propertyId, 'a number in mW');
        ch.txPower = nearestTxPower(value);
        break;
      case 'mute':
        ch.mute = Boolean(value);
        break;
      case 'frequency':
        if (!isNum(value)) throw badValue(propertyId, 'a number in MHz');
        // clamp and quantize, then echo: the card shows what the device did
        ch.frequency = round3(
          quantize(clamp(value, IEM_MIN_MHZ, IEM_MAX_MHZ), IEM_STEP_MHZ)
        );
        break;
      case 'channelName':
        if (typeof value !== 'string') throw badValue(propertyId, 'a string');
        ch.channelName = value.trim().toUpperCase().slice(0, IEM_NAME_MAX);
        break;
      default:
        throw new HttpError(
          400,
          'unknown_property',
          `No property ${propertyId} on ${IEM_PRODUCT}`
        );
    }
    this.emitChannelKey(propertyId, channelIndex);
  }

  emitChannelKey(key, only) {
    const channels = {};
    for (const [n, ch] of Object.entries(this.channels)) {
      if (only === undefined || Number(n) === only) channels[n] = ch[key];
    }
    this.onState?.(key, { channels });
  }

  tickMeters() {
    this.phase += 0.12;
    const channels = {};
    for (const [n, ch] of Object.entries(this.channels)) {
      const swing = 14 * Math.sin(this.phase + Number(n));
      const af = ch.mute ? -90 : round1(-24 + swing);
      channels[n] = { af, afR: round1(af - 2.5), txOn: ch.rfState };
    }
    this.onState?.('meters', { timestamp: Date.now(), channels });
  }

  tickPacks() {
    const updated = [];
    for (const pack of Object.values(this.packs)) {
      pack.battery.percent = Math.max(0, pack.battery.percent - 1);
      pack.battery.lifetimeInMinutes = Math.max(
        0,
        pack.battery.lifetimeInMinutes - 4
      );
      pack.meters.rf1 = round1(pack.meters.rf1 + (Math.random() * 4 - 2));
      pack.meters.lqi = clamp(
        Math.round(pack.meters.lqi + (Math.random() * 6 - 3)),
        0,
        100
      );
      updated.push({
        id: pack.id,
        changes: { battery: { ...pack.battery }, meters: { ...pack.meters } },
      });
    }
    this.onState?.('receivers', { added: [], updated, removed: [] });
  }
}

const badValue = (propertyId, expected) =>
  new HttpError(400, 'bad_value', `${propertyId} expects ${expected}`);

export function createMonitoringAdapter(device, pluginConfig) {
  return new SyntheticIemAdapter(device, pluginConfig);
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

// one fixed device per product, so the discovery path is exercised end to end
export async function discoverDevices() {
  return [
    {
      id: 'synthetic:1',
      name: 'Synthetic Analyzer',
      product: PRODUCT,
      transport: { kind: 'synthetic' },
    },
    {
      id: 'synthetic-iem:1',
      name: 'Synthetic IEM',
      product: IEM_PRODUCT,
      transport: { kind: 'synthetic' },
    },
  ];
}
