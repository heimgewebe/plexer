describe('Heimgeist consumer decommission', () => {
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

  it('does not activate Heimgeist even when legacy URL and token are configured', () => {
    process.env.HEIMGEIST_URL = 'https://heimgeist.example.com/events';
    process.env.HEIMGEIST_TOKEN = 'legacy-token';

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { config } = require('../config');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CONSUMERS } = require('../consumers');

      expect(config.legacyHeimgeistForwarding).toBe(false);
      expect(config.heimgeistUrl).toBe('https://heimgeist.example.com/events');

      const heimgeist = CONSUMERS.find(
        (consumer: { key: string }) => consumer.key === 'heimgeist',
      );
      expect(heimgeist).toBeDefined();
      expect(heimgeist.url).toBeUndefined();
      expect(heimgeist.token).toBeUndefined();
    });
  });
});
