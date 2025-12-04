import express, { Express, Request, Response, NextFunction } from 'express';
import { config } from './config';

interface IncomingEvent {
  type: string;
  source: string;
  payload: unknown;
}

const MAX_STRING_LENGTH = 256;

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
          message: 'Event must include type, source and payload',
        });
      }

      const { type, source, payload } = body as Record<string, unknown>;

      if (
        typeof type !== 'string' ||
        !type.trim() ||
        type.length > MAX_STRING_LENGTH ||
        typeof source !== 'string' ||
        !source.trim() ||
        source.length > MAX_STRING_LENGTH ||
        typeof payload === 'undefined'
      ) {
        return res.status(400).json({
          status: 'error',
          message: `Event must include non-empty type & source (max ${MAX_STRING_LENGTH} chars) and payload`,
        });
      }

      let payloadPreview = payload;
      try {
        if (typeof payload === 'object' && payload !== null) {
          payloadPreview = JSON.stringify(payload);
        } else {
          payloadPreview = String(payload);
        }

        if (typeof payloadPreview === 'string' && payloadPreview.length > 100) {
          payloadPreview = `${payloadPreview.slice(0, 100)}…`;
        }
      } catch (e) {
        payloadPreview = '[Circular or invalid payload]';
      }

      console.log('Received event', {
        type: type.trim(),
        source: source.trim(),
        payload: payloadPreview,
      });

      // Forward to Heimgeist if configured (Fire and Forget)
      if (config.heimgeistUrl) {
        fetch(config.heimgeistUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ type, source, payload }),
        })
          .then((response) => {
            if (!response.ok) {
              console.error(
                `Failed to forward event to Heimgeist: ${response.status} ${response.statusText}`,
              );
            }
          })
          .catch((error) => {
            console.error('Error forwarding event to Heimgeist:', error);
          });
      }

      res.status(202).json({ status: 'accepted' });
    },
  );

  // Global error handler
  app.use((err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid JSON',
      });
    }

    if (err.status === 413) {
      return res.status(413).json({
        status: 'error',
        message: 'Payload Too Large',
      });
    }

    console.error(err.stack);
    res.status(500).json({
      status: 'error',
      message: 'Internal Server Error',
    });
  });

  return app;
}
