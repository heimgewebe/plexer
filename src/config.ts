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
}

const envPort = process.env.PORT?.trim();
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

if (process.env.HEIMGEIST_URL) {
  try {
    // eslint-disable-next-line no-new
    new URL(process.env.HEIMGEIST_URL);
  } catch (error) {
    throw new Error(
      `Invalid HEIMGEIST_URL environment variable: ${process.env.HEIMGEIST_URL}`,
    );
  }
}

if (process.env.LEITSTAND_URL) {
  try {
    // eslint-disable-next-line no-new
    new URL(process.env.LEITSTAND_URL);
  } catch (error) {
    throw new Error(
      `Invalid LEITSTAND_URL environment variable: ${process.env.LEITSTAND_URL}`,
    );
  }
}

if (process.env.HAUSKI_URL) {
  try {
    // eslint-disable-next-line no-new
    new URL(process.env.HAUSKI_URL);
  } catch (error) {
    throw new Error(
      `Invalid HAUSKI_URL environment variable: ${process.env.HAUSKI_URL}`,
    );
  }
}

export const config: Config = {
  port: parsedPort,
  host: process.env.HOST || '0.0.0.0',
  environment: process.env.NODE_ENV || 'development',
  heimgeistUrl: process.env.HEIMGEIST_URL,
  leitstandUrl: process.env.LEITSTAND_URL,
  hauskiUrl: process.env.HAUSKI_URL,
  heimgeistToken: process.env.HEIMGEIST_TOKEN,
  leitstandToken:
    process.env.LEITSTAND_TOKEN || process.env.LEITSTAND_EVENTS_TOKEN,
  hauskiToken: process.env.HAUSKI_TOKEN || process.env.HAUSKI_EVENTS_TOKEN,
};
