describe('Deleted consumer decommission', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    jest.resetModules();
  });

  it('never activates Heimgeist or hausKI from legacy environment configuration', () => {
    process.env.HEIMGEIST_URL = 'https://heimgeist.example.com/events';
    process.env.HEIMGEIST_TOKEN = 'legacy-heimgeist-token';
    process.env.HAUSKI_URL = 'https://hauski.example.com/events';
    process.env.HAUSKI_TOKEN = 'legacy-hauski-token';

    jest.isolateModules(() => {
      const { config } = require('../config');
      const { CONSUMERS } = require('../consumers');

      expect(config.legacyHeimgeistForwarding).toBe(false);
      expect(config.heimgeistUrl).toBe('https://heimgeist.example.com/events');
      expect(config.hauskiUrl).toBe('https://hauski.example.com/events');

      const keys = CONSUMERS.map((consumer: { key: string }) => consumer.key);
      expect(keys).not.toContain('heimgeist');
      expect(keys).not.toContain('hauski');
      expect(keys).toEqual(['leitstand', 'chronik']);
    });
  });
});
