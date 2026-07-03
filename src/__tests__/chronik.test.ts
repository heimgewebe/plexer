describe('Chronik delivery seam', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('builds the agent ledger ingest URL from a base URL', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildChronikAgentLedgerIngestUrl } = require('../chronik');

      expect(
        buildChronikAgentLedgerIngestUrl('https://chronik.example.test'),
      ).toBe('https://chronik.example.test/v1/ingest?domain=agent.ledger');
    });
  });

  it('preserves an existing /v1/ingest endpoint and sets the agent ledger domain', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildChronikAgentLedgerIngestUrl } = require('../chronik');

      expect(
        buildChronikAgentLedgerIngestUrl(
          'https://chronik.example.test/v1/ingest?domain=old',
        ),
      ).toBe('https://chronik.example.test/v1/ingest?domain=agent.ledger');
    });
  });

  it('skips delivery when CHRONIK_URL is missing', async () => {
    jest.doMock('../config', () => ({
      config: {
        chronikUrl: undefined,
        chronikToken: undefined,
      },
    }));

    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { deliverToChronikAgentLedger } = require('../chronik');
      const fetchMock = jest.fn();

      await expect(
        deliverToChronikAgentLedger({ kind: 'agent.run.completed' }, fetchMock),
      ).resolves.toMatchObject({ status: 'skipped', retryable: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('posts an event to Chronik agent.ledger with X-Auth when configured', async () => {
    jest.doMock('../config', () => ({
      config: {
        chronikUrl: 'https://chronik.example.test',
        chronikToken: 'test-token',
      },
    }));

    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { deliverToChronikAgentLedger } = require('../chronik');
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: 'Accepted',
      });
      const event = { kind: 'agent.run.completed', data: { result: 'ok' } };

      await expect(
        deliverToChronikAgentLedger(event, fetchMock),
      ).resolves.toMatchObject({ status: 'delivered', retryable: false });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://chronik.example.test/v1/ingest?domain=agent.ledger',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth': 'test-token',
          },
          body: JSON.stringify(event),
        }),
      );
    });
  });

  it('marks 5xx responses as retryable failures', async () => {
    jest.doMock('../config', () => ({
      config: {
        chronikUrl: 'https://chronik.example.test',
        chronikToken: undefined,
      },
    }));

    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { deliverToChronikAgentLedger } = require('../chronik');
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Unavailable',
      });

      await expect(
        deliverToChronikAgentLedger({ kind: 'agent.run.blocked' }, fetchMock),
      ).resolves.toMatchObject({
        status: 'retryable_failure',
        statusCode: 503,
        retryable: true,
      });
    });
  });

  it('marks validation-like 4xx responses as permanent failures', async () => {
    jest.doMock('../config', () => ({
      config: {
        chronikUrl: 'https://chronik.example.test',
        chronikToken: undefined,
      },
    }));

    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { deliverToChronikAgentLedger } = require('../chronik');
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      await expect(
        deliverToChronikAgentLedger({ kind: 'agent.run.started' }, fetchMock),
      ).resolves.toMatchObject({
        status: 'permanent_failure',
        statusCode: 400,
        retryable: false,
      });
    });
  });

  it('marks transport errors as retryable failures', async () => {
    jest.doMock('../config', () => ({
      config: {
        chronikUrl: 'https://chronik.example.test',
        chronikToken: undefined,
      },
    }));

    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { deliverToChronikAgentLedger } = require('../chronik');
      const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));

      await expect(
        deliverToChronikAgentLedger({ kind: 'agent.run.started' }, fetchMock),
      ).resolves.toMatchObject({
        status: 'retryable_failure',
        retryable: true,
        error: 'network down',
      });
    });
  });
});
