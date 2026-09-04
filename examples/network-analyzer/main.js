import { SoundBasePlugin, runPlugin } from '@soundbase/plugin-shell';
import { createSpectrumAnalyzerAdapter, discoverDevices } from './adapter.js';

class Plugin extends SoundBasePlugin {
  async discoverDevices() {
    return discoverDevices(this.config);
  }

  createSpectrumAnalyzerAdapter(device) {
    return createSpectrumAnalyzerAdapter(device, this.config);
  }
}

export default runPlugin(Plugin, {
  manifestPath: new URL('./soundbase-plugin.json', import.meta.url),
});
