describe('config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env vars preserving object identity
    const currentKeys = Object.keys(process.env);
    for (const key of currentKeys) {
      if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
        delete process.env[key];
      }
    }
    for (const key of Object.keys(originalEnv)) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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

  describe('Listener and ingress security', () => {
    it('defaults to the IPv4 loopback listener', () => {
      delete process.env.HOST;
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.host).toBe('127.0.0.1');
      });
    });

    it('refuses a wide bind without explicit opt-in', () => {
      process.env.HOST = '0.0.0.0';
      process.env.PLEXER_TOKEN = 'configured-token';
      delete process.env.PLEXER_ALLOW_NON_LOOPBACK;
      expect(() => {
        jest.isolateModules(() => require('../config'));
      }).toThrow('Refusing non-loopback HOST without PLEXER_ALLOW_NON_LOOPBACK=true');
    });

    it('refuses a wide bind without active ingress auth', () => {
      process.env.HOST = '::';
      process.env.PLEXER_ALLOW_NON_LOOPBACK = 'true';
      delete process.env.PLEXER_TOKEN;
      expect(() => {
        jest.isolateModules(() => require('../config'));
      }).toThrow('Refusing non-loopback HOST without PLEXER_TOKEN');
    });

    it('allows a wide bind only with validated opt-in and a token', () => {
      process.env.HOST = '0.0.0.0';
      process.env.PLEXER_ALLOW_NON_LOOPBACK = 'true';
      process.env.PLEXER_TOKEN = 'configured-token';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.host).toBe('0.0.0.0');
        expect(config.allowNonLoopback).toBe(true);
        expect(config.plexerToken).toBe('configured-token');
      });
    });

    it('rejects an invalid non-loopback opt-in value', () => {
      process.env.PLEXER_ALLOW_NON_LOOPBACK = 'yes';
      expect(() => {
        jest.isolateModules(() => require('../config'));
      }).toThrow('Invalid PLEXER_ALLOW_NON_LOOPBACK');
    });

    it('recognizes the complete IPv4 loopback range and IPv6 loopback', () => {
      jest.isolateModules(() => {
        const { isLoopbackHost } = require('../config');
        expect(isLoopbackHost('127.42.0.9')).toBe(true);
        expect(isLoopbackHost('::1')).toBe(true);
        expect(isLoopbackHost('0.0.0.0')).toBe(false);
        expect(isLoopbackHost('192.168.1.2')).toBe(false);
      });
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

  describe('Event Forwarding Config', () => {
    it('accepts valid HEIMGEIST_URL', () => {
      process.env.HEIMGEIST_URL = 'https://heimgeist.example.com';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.heimgeistUrl).toBe('https://heimgeist.example.com');
      });
    });

    it('rejects invalid HEIMGEIST_URL', () => {
      process.env.HEIMGEIST_URL = 'not-a-url';
      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow('Invalid HEIMGEIST_URL');
    });

    it('accepts valid LEITSTAND_URL', () => {
      process.env.LEITSTAND_URL = 'https://leitstand.example.com/events';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.leitstandUrl).toBe('https://leitstand.example.com/events');
      });
    });

    it('rejects invalid LEITSTAND_URL', () => {
      process.env.LEITSTAND_URL = 'not-a-url';
      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow('Invalid LEITSTAND_URL');
    });

    it('accepts valid HAUSKI_URL', () => {
      process.env.HAUSKI_URL = 'https://hauski.example.com';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.hauskiUrl).toBe('https://hauski.example.com');
      });
    });

    it('rejects invalid HAUSKI_URL', () => {
      process.env.HAUSKI_URL = 'not-a-url';
      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow('Invalid HAUSKI_URL');
    });

    it('maps LEITSTAND_TOKEN correctly', () => {
      process.env.LEITSTAND_TOKEN = 'secret-token';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.leitstandToken).toBe('secret-token');
      });
    });

    it('maps LEITSTAND_EVENTS_TOKEN to leitstandToken as fallback', () => {
      delete process.env.LEITSTAND_TOKEN;
      process.env.LEITSTAND_EVENTS_TOKEN = 'events-token';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.leitstandToken).toBe('events-token');
      });
    });

    it('prefers LEITSTAND_TOKEN over LEITSTAND_EVENTS_TOKEN', () => {
      process.env.LEITSTAND_TOKEN = 'primary-token';
      process.env.LEITSTAND_EVENTS_TOKEN = 'fallback-token';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.leitstandToken).toBe('primary-token');
      });
    });

    it('maps HAUSKI_EVENTS_TOKEN to hauskiToken', () => {
      delete process.env.HAUSKI_TOKEN;
      process.env.HAUSKI_EVENTS_TOKEN = 'hauski-events-token';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.hauskiToken).toBe('hauski-events-token');
      });
    });

    it('accepts valid CHRONIK_URL', () => {
      process.env.CHRONIK_URL = 'https://chronik.example.com';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.chronikUrl).toBe('https://chronik.example.com');
      });
    });

    it('normalizes trailing slashes in CHRONIK_URL', () => {
      process.env.CHRONIK_URL = 'https://chronik.example.com/api/';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.chronikUrl).toBe('https://chronik.example.com/api');
      });
    });

    it('normalizes trailing slashes in HEIMGEIST_URL', () => {
      process.env.HEIMGEIST_URL = 'https://heimgeist.example.com/api/';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.heimgeistUrl).toBe('https://heimgeist.example.com/api');
      });
    });

    it('normalizes trailing slashes in LEITSTAND_URL', () => {
      process.env.LEITSTAND_URL = 'https://leitstand.example.com/events/';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.leitstandUrl).toBe('https://leitstand.example.com/events');
      });
    });

    it('normalizes trailing slashes in HAUSKI_URL', () => {
      process.env.HAUSKI_URL = 'https://hauski.example.com/';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.hauskiUrl).toBe('https://hauski.example.com');
      });
    });

    it('preserves query parameters when normalizing URLs', () => {
      process.env.CHRONIK_URL = 'https://chronik.example.com/api/?foo=bar';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.chronikUrl).toBe('https://chronik.example.com/api?foo=bar');
      });
    });

    it('preserves fragments when normalizing URLs', () => {
      process.env.HEIMGEIST_URL = 'https://heimgeist.example.com/api/#section';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.heimgeistUrl).toBe('https://heimgeist.example.com/api#section');
      });
    });

    it('preserves query parameters and fragments together', () => {
      process.env.LEITSTAND_URL = 'https://leitstand.example.com/events/?key=value#anchor';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.leitstandUrl).toBe('https://leitstand.example.com/events?key=value#anchor');
      });
    });

    it('rejects invalid CHRONIK_URL', () => {
      process.env.CHRONIK_URL = 'not-a-url';
      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow('Invalid CHRONIK_URL');
    });

    it('maps CHRONIK_TOKEN correctly', () => {
      process.env.CHRONIK_TOKEN = 'chronik-secret-token';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.chronikToken).toBe('chronik-secret-token');
      });
    });

    it('drops empty tokens after trimming', () => {
      process.env.HEIMGEIST_TOKEN = '    ';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.heimgeistToken).toBeUndefined();
      });
    });

    it('maps CHRONIK_EVENTS_TOKEN to chronikToken as fallback', () => {
      delete process.env.CHRONIK_TOKEN;
      process.env.CHRONIK_EVENTS_TOKEN = 'chronik-events-token';
      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.chronikToken).toBe('chronik-events-token');
      });
    });
  });

  describe('Retry Configuration', () => {
    it('uses defaults when env vars are not set', () => {
      delete process.env.RETRY_CONCURRENCY;
      delete process.env.RETRY_BATCH_SIZE;

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.retryConcurrency).toBe(5);
        expect(config.retryBatchSize).toBe(50);
      });
    });

    it('accepts valid integer strings', () => {
      process.env.RETRY_CONCURRENCY = '10';
      process.env.RETRY_BATCH_SIZE = '100';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.retryConcurrency).toBe(10);
        expect(config.retryBatchSize).toBe(100);
      });
    });

    it('accepts values with whitespace', () => {
      process.env.RETRY_CONCURRENCY = ' 5 ';
      process.env.RETRY_BATCH_SIZE = ' 50 ';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config.retryConcurrency).toBe(5);
        expect(config.retryBatchSize).toBe(50);
      });
    });

    it('rejects non-numeric values (strict check)', () => {
      process.env.RETRY_CONCURRENCY = '10abc'; // "10abc" would pass parseInt but fail strict check

      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow(/^Invalid RETRY_CONCURRENCY environment variable/);
    });

    it('rejects floats', () => {
      process.env.RETRY_BATCH_SIZE = '10.5';

      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow(/^Invalid RETRY_BATCH_SIZE environment variable/);
    });

    it('rejects zero', () => {
      process.env.RETRY_CONCURRENCY = '0';

      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow(/^Invalid RETRY_CONCURRENCY environment variable/);
    });

    it('rejects negative numbers', () => {
      process.env.RETRY_BATCH_SIZE = '-1';

      expect(() => {
        jest.isolateModules(() => {
          require('../config');
        });
      }).toThrow(/^Invalid RETRY_BATCH_SIZE environment variable/);
    });
  });

  describe('Ingress and retention limits', () => {
    it('loads explicit positive limits', () => {
      process.env.PLEXER_INGRESS_RATE_WINDOW_MS = '1000';
      process.env.PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT = '5';
      process.env.PLEXER_INGRESS_GLOBAL_RATE_LIMIT = '10';
      process.env.PLEXER_INGRESS_PER_CLIENT_MAX_IN_FLIGHT = '2';
      process.env.PLEXER_INGRESS_GLOBAL_MAX_IN_FLIGHT = '4';
      process.env.PLEXER_INGRESS_MAX_CLIENTS = '32';
      process.env.FAILED_FORWARDS_MAX_BYTES = '4096';
      process.env.FAILED_FORWARDS_MAX_ENTRIES = '12';
      process.env.FAILED_FORWARDS_MAX_AGE_MS = '60000';

      jest.isolateModules(() => {
        const { config } = require('../config');
        expect(config).toMatchObject({
          ingressRateWindowMs: 1000,
          ingressPerClientRateLimit: 5,
          ingressGlobalRateLimit: 10,
          ingressPerClientMaxInFlight: 2,
          ingressGlobalMaxInFlight: 4,
          ingressMaxClients: 32,
          failedForwardsMaxBytes: 4096,
          failedForwardsMaxEntries: 12,
          failedForwardsMaxAgeMs: 60000,
        });
      });
    });

    it('rejects a per-client rate above the global rate', () => {
      process.env.PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT = '11';
      process.env.PLEXER_INGRESS_GLOBAL_RATE_LIMIT = '10';
      expect(() => {
        jest.isolateModules(() => require('../config'));
      }).toThrow('PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT must not exceed');
    });

    it('rejects unsafe-integer retention limits', () => {
      process.env.FAILED_FORWARDS_MAX_BYTES = '9007199254740992';
      expect(() => {
        jest.isolateModules(() => require('../config'));
      }).toThrow('Invalid FAILED_FORWARDS_MAX_BYTES');
    });
  });
});
