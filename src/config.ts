export interface Config {
  port: number;
  host: string;
  environment: string;
  heimgeistUrl?: string;
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

export const config: Config = {
  port: parsedPort,
  host: process.env.HOST || '0.0.0.0',
  environment: process.env.NODE_ENV || 'development',
  heimgeistUrl: process.env.HEIMGEIST_URL,
};
