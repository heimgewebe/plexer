export interface Config {
  port: number;
  host: string;
  environment: string;
  heimgeistUrl?: string;
}

const parsedPort = parseInt(process.env.PORT || '3000', 10);

if (isNaN(parsedPort)) {
  throw new Error('Invalid PORT environment variable');
}

export const config: Config = {
  port: parsedPort,
  host: process.env.HOST || '0.0.0.0',
  environment: process.env.NODE_ENV || 'development',
  heimgeistUrl: process.env.HEIMGEIST_URL,
};
