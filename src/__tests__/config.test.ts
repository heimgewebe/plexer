describe('config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('uses default port when PORT is not set', () => {
    delete process.env.PORT;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { config } = require('../config');
      expect(config.port).toBe(3000);
    });
  });

  it('rejects non-numeric ports', () => {
    process.env.PORT = '3000abc';

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../config');
      });
    }).toThrow('Invalid PORT environment variable');
  });

  it('rejects out-of-range ports', () => {
    process.env.PORT = '70000';

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../config');
      });
    }).toThrow('Invalid PORT environment variable');
  });

  it('accepts ports with whitespace', () => {
    process.env.PORT = ' 3000 ';

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { config } = require('../config');
      expect(config.port).toBe(3000);
    });
  });

  it('uses default port when PORT is empty string', () => {
    process.env.PORT = '';

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { config } = require('../config');
      expect(config.port).toBe(3000);
    });
  });
});
