import express, { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { config } from './config';

const MAX_STRING_LENGTH = 256;

const pendingFetches = new Set<Promise<void>>();

function shouldForward(eventType: string, consumerKey: string): boolean {
  if (
    eventType === 'knowledge.observatory.published.v1' ||
    eventType === 'integrity.summary.published.v1'
  ) {
    return true;
  }
  return consumerKey === 'heimgeist';
}

export async function drainPendingRequests(timeoutMs = 5000): Promise<void> {
  if (pendingFetches.size === 0) return;

  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<string>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const allFinished = Promise.all(Array.from(pendingFetches))
    .then(() => 'done')
    .finally(() => {
      clearTimeout(timeoutHandle);
    });

  const result = await Promise.race([allFinished, timeoutPromise]);

  if (result === 'timeout') {
    console.log(
      `Drain timeout after ${timeoutMs}ms (pending=${pendingFetches.size})`,
    );
  }
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
          message: 'Event must include type, source and payload',
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
          message: `Event must include non-empty type & source (max ${MAX_STRING_LENGTH} chars) and payload`,
        });
      }

      const normalizedType = type.trim();
      const normalizedSource = source.trim();

      if (
        normalizedType.length > MAX_STRING_LENGTH ||
        normalizedSource.length > MAX_STRING_LENGTH
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
        type: normalizedType,
        source: normalizedSource,
        payload: payloadPreview,
      });

      // Soft-guard for notification-only events
      if (normalizedType === 'insights.daily.published') {
        const payloadSize = JSON.stringify(payload).length;
        if (payloadSize > 1024) {
          console.warn(
            `::warning:: insights.daily.published payload exceeds 1KB notification-only limit (size=${payloadSize})`,
          );
        }
      }

      // Strict Pass-through: Do not inject 'eventId' or timestamp into the forwarded body.
      // The contract requires the payload to remain untouched.
      let serializedEvent: string;
      try {
        serializedEvent = JSON.stringify({
          type: normalizedType,
          source: normalizedSource,
          payload,
        });
      } catch (error) {
        console.error('Failed to serialize event payload for forwarding', error);
        return res.status(400).json({
          status: 'error',
          message: 'Payload must be JSON-serializable',
        });
      }

      const eventId = randomUUID();
      const consumers: Array<{
        key: string;
        label: string;
        url?: string;
        token?: string;
      }> = [
        {
          key: 'heimgeist',
          label: 'Heimgeist',
          url: config.heimgeistUrl,
          token: config.heimgeistToken,
        },
        {
          key: 'leitstand',
          label: 'Leitstand',
          url: config.leitstandUrl,
          token: config.leitstandToken,
        },
        {
          key: 'hauski',
          label: 'hausKI',
          url: config.hauskiUrl,
          token: config.hauskiToken,
        },
        {
          key: 'chronik',
          label: 'Chronik',
          url: config.chronikUrl,
          token: config.chronikToken,
        },
      ];

      consumers.forEach(({ key, label, url, token }) => {
        if (!url) return;

        if (!shouldForward(normalizedType, key)) {
          return;
        }

        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (token) {
            headers.Authorization = `Bearer ${token}`;
          }

          const fetchPromise = fetch(url, {
            method: 'POST',
            headers,
            body: serializedEvent,
          })
            .then((response) => {
              const logData: Record<string, unknown> = {
                event_id: eventId,
                publisher: normalizedSource,
                delivered_to: label,
                status: response.ok ? 'success' : 'failure',
                statusCode: response.status,
                auth: !!token,
              };

              if (
                typeof payload === 'object' &&
                payload !== null &&
                'repo' in payload
              ) {
                logData.repo = (payload as Record<string, unknown>).repo;
              }

              console.log('Event forwarded', logData);
              if (!response.ok) {
                let errorMessage = `Failed to forward event to ${label}: ${response.status} ${response.statusText}`;
                if (response.status === 401 || response.status === 403) {
                  errorMessage += ' (token rejected)';
                }
                console.error(errorMessage);
              }
            })
            .catch((error) => {
              const logData: Record<string, unknown> = {
                event_id: eventId,
                publisher: normalizedSource,
                delivered_to: label,
                status: 'error',
              };

              if (
                typeof payload === 'object' &&
                payload !== null &&
                'repo' in payload
              ) {
                logData.repo = (payload as Record<string, unknown>).repo;
              }

              console.log('Event forwarded', logData);
              console.error(`Error forwarding event to ${label}:`, error);
            })
            .finally(() => {
              pendingFetches.delete(fetchPromise);
            });
          pendingFetches.add(fetchPromise);
        } catch (error) {
          console.error(`Failed to initiate forward to ${label}:`, error);
        }
      });

      res.status(202).json({ status: 'accepted' });
    },
  );

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      status: 'error',
      message: 'Not Found',
      path: req.path,
      method: req.method,
    });
  });

  // Global error handler
  app.use((err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid JSON',
      });
    }

    if (err.status === 413 || (err as any).statusCode === 413) {
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
