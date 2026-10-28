import { randomBytes } from 'node:crypto';
import { createCloudProvider } from './cloud.js';
import { createEvolutionProvider } from './evolution.js';

// Simulador: permite usar e testar o sistema inteiro sem um WhatsApp conectado.
function createSimulatorProvider() {
  return {
    name: 'simulator',
    async send() {
      return { waId: 'sim-' + randomBytes(6).toString('hex') };
    },
    async status() {
      return { connected: true, state: 'simulador' };
    },
  };
}

export function createProvider(settings) {
  switch (settings.wa_provider) {
    case 'cloud': return createCloudProvider(settings);
    case 'evolution': return createEvolutionProvider(settings);
    case 'simulator': return createSimulatorProvider();
    default: return null;
  }
}
