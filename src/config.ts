export interface Config {
  port: number;
  host: string;
  allowNonLoopback: boolean;
  environment: string;
  plexerToken?: string;
  ingressRateWindowMs: number;
  ingressPerClientRateLimit: number;
  ingressGlobalRateLimit: number;
  ingressPerClientMaxInFlight: number;
  ingressGlobalMaxInFlight: number;
  ingressMaxClients: number;
  heimgeistUrl?: string;
  leitstandUrl?: string;
  hauskiUrl?: string;
  heimgeistToken?: string;
  leitstandToken?: string;
  hauskiToken?: string;
  chronikUrl?: string;
  chronikToken?: string;
  dataDir: string;
  retryConcurrency: number;
  retryBatchSize: number;
  failedForwardsMaxBytes: number;
  failedForwardsMaxEntries: number;
  failedForwardsMaxAgeMs: number;
}

const getEnv = (name: string): string | undefined => {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const envPort = getEnv('PORT');
const rawPort = envPort || '3000';
const parsedPort = Number(rawPort);

const isValidPort =
  Number.isInteger(parsedPort) &&
  parsedPort > 0 &&
  parsedPort <= 65535 &&
  /^\d+$/.test(rawPort);

if (!isValidPort) {
  throw new Error('Invalid PORT environment variable');
}

const validateInt = (
  name: string,
  value: string | undefined,
  defaultValue: number,
): number => {
  if (!value) return defaultValue;
  const trimmed = value.trim();
  // Strict check: only digits allowed
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${name} environment variable: must be a positive integer`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name} environment variable: must be a positive integer`,
    );
  }
  return parsed;
};

const validateBoolean = (
  name: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean => {
  if (!value) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name} environment variable: must be true or false`);
};

/** Only literal loopback listener names/addresses are treated as local-only. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!ipv4Match) return false;
  const octets = ipv4Match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

const validateUrl = (name: string, value?: string): string | undefined => {
  if (!value) return undefined;

  try {
    const url = new URL(value);

    // Normalize pathname only: remove trailing slashes, but keep "/" for root.
    let pathname = url.pathname;
    if (pathname !== '/') {
      pathname = pathname.replace(/\/+$/, '');
    }

    // Special case: if pathname is just "/" and no search/hash, return origin only
    if (pathname === '/' && !url.search && !url.hash) {
      return url.origin;
    }

    // Recompose (preserve search + hash)
    return `${url.origin}${pathname}${url.search}${url.hash}`;
  } catch (error) {
    throw new Error(`Invalid ${name} environment variable: ${value}`);
  }
};

const heimgeistUrl = validateUrl('HEIMGEIST_URL', getEnv('HEIMGEIST_URL'));
const leitstandUrl = validateUrl('LEITSTAND_URL', getEnv('LEITSTAND_URL'));
const hauskiUrl = validateUrl('HAUSKI_URL', getEnv('HAUSKI_URL'));
const chronikUrl = validateUrl('CHRONIK_URL', getEnv('CHRONIK_URL'));

const retryConcurrency = validateInt(
  'RETRY_CONCURRENCY',
  getEnv('RETRY_CONCURRENCY'),
  5,
);
const retryBatchSize = validateInt(
  'RETRY_BATCH_SIZE',
  getEnv('RETRY_BATCH_SIZE'),
  50,
);

const host = getEnv('HOST') || '127.0.0.1';
const plexerToken = getEnv('PLEXER_TOKEN');
const allowNonLoopback = validateBoolean(
  'PLEXER_ALLOW_NON_LOOPBACK',
  getEnv('PLEXER_ALLOW_NON_LOOPBACK'),
  false,
);

if (!isLoopbackHost(host)) {
  if (!allowNonLoopback) {
    throw new Error(
      'Refusing non-loopback HOST without PLEXER_ALLOW_NON_LOOPBACK=true',
    );
  }
  if (!plexerToken) {
    throw new Error('Refusing non-loopback HOST without PLEXER_TOKEN');
  }
}

const ingressRateWindowMs = validateInt(
  'PLEXER_INGRESS_RATE_WINDOW_MS',
  getEnv('PLEXER_INGRESS_RATE_WINDOW_MS'),
  60_000,
);
const ingressPerClientRateLimit = validateInt(
  'PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT',
  getEnv('PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT'),
  120,
);
const ingressGlobalRateLimit = validateInt(
  'PLEXER_INGRESS_GLOBAL_RATE_LIMIT',
  getEnv('PLEXER_INGRESS_GLOBAL_RATE_LIMIT'),
  1_200,
);
const ingressPerClientMaxInFlight = validateInt(
  'PLEXER_INGRESS_PER_CLIENT_MAX_IN_FLIGHT',
  getEnv('PLEXER_INGRESS_PER_CLIENT_MAX_IN_FLIGHT'),
  8,
);
const ingressGlobalMaxInFlight = validateInt(
  'PLEXER_INGRESS_GLOBAL_MAX_IN_FLIGHT',
  getEnv('PLEXER_INGRESS_GLOBAL_MAX_IN_FLIGHT'),
  64,
);
const ingressMaxClients = validateInt(
  'PLEXER_INGRESS_MAX_CLIENTS',
  getEnv('PLEXER_INGRESS_MAX_CLIENTS'),
  1_024,
);

if (ingressPerClientRateLimit > ingressGlobalRateLimit) {
  throw new Error(
    'PLEXER_INGRESS_PER_CLIENT_RATE_LIMIT must not exceed PLEXER_INGRESS_GLOBAL_RATE_LIMIT',
  );
}
if (ingressPerClientMaxInFlight > ingressGlobalMaxInFlight) {
  throw new Error(
    'PLEXER_INGRESS_PER_CLIENT_MAX_IN_FLIGHT must not exceed PLEXER_INGRESS_GLOBAL_MAX_IN_FLIGHT',
  );
}

const failedForwardsMaxBytes = validateInt(
  'FAILED_FORWARDS_MAX_BYTES',
  getEnv('FAILED_FORWARDS_MAX_BYTES'),
  16 * 1024 * 1024,
);
const failedForwardsMaxEntries = validateInt(
  'FAILED_FORWARDS_MAX_ENTRIES',
  getEnv('FAILED_FORWARDS_MAX_ENTRIES'),
  10_000,
);
const failedForwardsMaxAgeMs = validateInt(
  'FAILED_FORWARDS_MAX_AGE_MS',
  getEnv('FAILED_FORWARDS_MAX_AGE_MS'),
  7 * 24 * 60 * 60 * 1_000,
);

export const config: Config = {
  port: parsedPort,
  host,
  allowNonLoopback,
  environment: getEnv('NODE_ENV') || 'development',
  plexerToken,
  ingressRateWindowMs,
  ingressPerClientRateLimit,
  ingressGlobalRateLimit,
  ingressPerClientMaxInFlight,
  ingressGlobalMaxInFlight,
  ingressMaxClients,
  heimgeistUrl,
  leitstandUrl,
  hauskiUrl,
  chronikUrl,
  heimgeistToken: getEnv('HEIMGEIST_TOKEN'),
  leitstandToken:
    getEnv('LEITSTAND_TOKEN') || getEnv('LEITSTAND_EVENTS_TOKEN'),
  hauskiToken: getEnv('HAUSKI_TOKEN') || getEnv('HAUSKI_EVENTS_TOKEN'),
  chronikToken: getEnv('CHRONIK_TOKEN') || getEnv('CHRONIK_EVENTS_TOKEN'),
  dataDir: getEnv('PLEXER_DATA_DIR') || 'data',
  retryConcurrency,
  retryBatchSize,
  failedForwardsMaxBytes,
  failedForwardsMaxEntries,
  failedForwardsMaxAgeMs,
};
