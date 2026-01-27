export interface Config {
  port: number;
  host: string;
  environment: string;
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
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} environment variable: must be a positive integer`);
  }
  return parsed;
};

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

export const config: Config = {
  port: parsedPort,
  host: getEnv('HOST') || '0.0.0.0',
  environment: getEnv('NODE_ENV') || 'development',
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
};
