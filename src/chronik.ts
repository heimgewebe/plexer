import { config } from './config';
import { HTTP_REQUEST_TIMEOUT_MS } from './constants';

export type ChronikDeliveryStatus =
  | 'delivered'
  | 'skipped'
  | 'retryable_failure'
  | 'permanent_failure';

export interface ChronikDeliveryResult {
  status: ChronikDeliveryStatus;
  url?: string;
  statusCode?: number;
  error?: string;
  retryable: boolean;
}

type FetchLike = typeof fetch;

export function buildChronikAgentLedgerIngestUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, '');

  if (pathname.endsWith('/v1/ingest')) {
    url.pathname = pathname;
  } else {
    url.pathname = `${pathname}/v1/ingest`;
  }

  url.searchParams.set('domain', 'agent.ledger');
  return url.toString();
}

export async function deliverToChronikAgentLedger(
  event: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<ChronikDeliveryResult> {
  if (!config.chronikUrl) {
    return {
      status: 'skipped',
      error: 'CHRONIK_URL missing',
      retryable: false,
    };
  }

  const url = buildChronikAgentLedgerIngestUrl(config.chronikUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.chronikToken) {
    headers['X-Auth'] = config.chronikToken;
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      return {
        status: 'delivered',
        url,
        statusCode: response.status,
        retryable: false,
      };
    }

    const retryable = response.status === 429 || response.status >= 500;

    return {
      status: retryable ? 'retryable_failure' : 'permanent_failure',
      url,
      statusCode: response.status,
      error: `${response.status} ${response.statusText}`.trim(),
      retryable,
    };
  } catch (error) {
    return {
      status: 'retryable_failure',
      url,
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}
