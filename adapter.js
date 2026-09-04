// Synthetic spectrum-analyzer adapter. Replace this file (and, for anything with
// a wire protocol, a driver/ beside it) to build a real plugin — main.js, the
// manifest shape and the shell stay exactly as they are.

// The product this adapter announces its devices as. It MUST be one of the
// `deviceTypeId`s declared in soundbase-plugin.json — the shell warns and the
// host ignores a device naming a product the manifest never declared.
// `npm run rename` keeps the two in step; a test asserts they agree.
export const PRODUCT = 'plugin:template/synthetic';

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

// one fixed device, so the discovery path is exercised end to end
export async function discoverDevices() {
  return [
    {
      id: 'synthetic:1',
      name: 'Synthetic Analyzer',
      product: PRODUCT,
      transport: { kind: 'synthetic' },
    },
  ];
}
