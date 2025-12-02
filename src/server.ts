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
      req: Request<unknown, unknown, unknown>,
      res: Response,
    ) => {
      const body = req.body;

      if (
        !body ||
        typeof body !== 'object' ||
        !('type' in body) ||
        !('source' in body) ||
        !('payload' in body)
      ) {
        return res.status(400).json({
          status: 'error',
          message: 'Event must include non-empty type & source and payload',
        });
      }

      const { type, source, payload } = body as Record<string, unknown>;

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

