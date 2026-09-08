import { SoundBasePlugin, runPlugin } from '@soundbase/plugin-shell';
import * as adapter from './adapter.js';

// The shell bootstrap. Byte-identical across every plugin: it wires whichever
// module factories adapter.js exports and nothing else, so a plugin that only
// serves spectrum analyzers, or only monitored devices, uses this same file.
class Plugin extends SoundBasePlugin {
  async discoverDevices() {
    return adapter.discoverDevices?.(this.config) ?? [];
  }
}

if (typeof adapter.createSpectrumAnalyzerAdapter === 'function') {
  Plugin.prototype.createSpectrumAnalyzerAdapter = function (device) {
    return adapter.createSpectrumAnalyzerAdapter(device, this.config);
  };
}

if (typeof adapter.createMonitoringAdapter === 'function') {
  Plugin.prototype.createMonitoringAdapter = function (device) {
    return adapter.createMonitoringAdapter(device, this.config);
  };
}

export default runPlugin(Plugin, {
  manifestPath: new URL('./soundbase-plugin.json', import.meta.url),
});
