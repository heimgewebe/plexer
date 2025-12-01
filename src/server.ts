import express, { Express, Request, Response, NextFunction } from 'express';
import { config } from './config';

interface IncomingEvent {
  type: string;
  source: string;
  payload: unknown;
}

export function createServer(): Express {
  const app = express();

  app.use(express.json());

  app.get('/', (req: Request, res: Response) => {
    res.json({
      message: 'Welcome to plexer',
      environment: config.environment,
    });
  });

  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post(
    '/events',
    (
      req: Request<unknown, unknown, Partial<IncomingEvent>>,
      res: Response,
    ) => {
      const { type, source, payload } = req.body ?? {};

      if (
        typeof type !== 'string' ||
        !type.trim() ||
        typeof source !== 'string' ||
        !source.trim() ||
        typeof payload === 'undefined'
      ) {
        return res.status(400).json({
          status: 'error',
          message: 'Event must include non-empty type & source and payload',
        });
      }

      const payloadPreview =
        typeof payload === 'string' && payload.length > 200
          ? `${payload.slice(0, 200)}…`
          : payload;

      console.log('Received event', {
        type: type.trim(),
        source: source.trim(),
        payload: payloadPreview,
      });

      res.status(202).json({ status: 'accepted' });
    },
  );

  // Global error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack);
    res.status(500).json({
      status: 'error',
      message: 'Internal Server Error',
    });
  });

  return app;
}

export function startServer(): void {
  const app = createServer();

  const server = app.listen(config.port, config.host, () => {
    console.log(`Server is running on http://${config.host}:${config.port}`);
    console.log(`Environment: ${config.environment}`);
  });

  const shutdown = () => {
    console.log('Shutting down server...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
