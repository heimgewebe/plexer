import express, { Express, Request, Response } from 'express';
import { config } from './config';

export function createServer(): Express {
  const app = express();

  app.use(express.json());

  app.get('/', (req: Request, res: Response) => {
    res.json({
      message: 'Welcome to Heimplex',
      environment: config.environment,
    });
  });

  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  return app;
}

export function startServer(): void {
  const app = createServer();

  app.listen(config.port, config.host, () => {
    console.log(`Server is running on http://${config.host}:${config.port}`);
    console.log(`Environment: ${config.environment}`);
  });
}
