import express, { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { config } from './config';
import { PlexerEvent } from './types';
import {
  BROADCAST_EVENTS,
  EVENT_INSIGHTS_DAILY_PUBLISHED,
  BEST_EFFORT_EVENTS,
} from './constants';
import { CONSUMERS } from './consumers';
import { getAuthHeaders } from './auth';
import { logger } from './logger';
import {
  saveFailedEvent,
  getDeliveryMetrics,
  validateDeliveryReport,
  validateEventEnvelope,
} from './delivery';

const MAX_STRING_LENGTH = 256;

const pendingFetches = new Set<Promise<void>>();

function tryJson(value: unknown): { json: string | undefined | null; error?: unknown } {
  try {
    const json = JSON.stringify(value);
    return { json };
  } catch (error) {
    return { json: null, error };
  }
}

function getPayloadSizeBytes(payloadJson: string | undefined | null): number | null {
  if (payloadJson === null) {
    return null;
  }
  if (payloadJson === undefined) {
    return 0;
  }

  return Buffer.byteLength(payloadJson, 'utf8');
}

function shouldForward(eventType: string, consumerKey: string): boolean {
  if (BROADCAST_EVENTS.has(eventType)) {
    return true;
  }
  return consumerKey === 'heimgeist';
}

export function getPendingRequestCount(): number {
  return pendingFetches.size;
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
    logger.warn(
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

  app.get('/status', (req: Request, res: Response) => {
    const report = getDeliveryMetrics(getPendingRequestCount());

    // Strict contract validation
    if (!validateDeliveryReport(report)) {
      logger.error(
        { errors: validateDeliveryReport.errors },
        'Delivery report failed contract validation',
      );
      // We still return it to not break ops, but log the violation
    }

    const responseEnvelope = {
      type: 'plexer.delivery.report.v1',
      source: 'plexer',
      payload: report,
    };

    // Validate overall envelope
    if (!validateEventEnvelope(responseEnvelope)) {
        logger.error(
            { errors: validateEventEnvelope.errors },
            'Delivery report envelope failed validation',
        );
    }

    res.json(responseEnvelope);
  });

  app.post(
    '/events',
    (
      req: Request<unknown, unknown, unknown>,
      res: Response,
    ) => {
      const body = req.body;

      // Basic structure check before access
      if (!body || typeof body !== 'object') {
         return res.status(400).json({
          status: 'error',
          message: 'Invalid event structure',
        });
      }

      const { type, source, payload } = body as unknown as PlexerEvent;

      if (typeof type !== 'string' || typeof source !== 'string') {
         return res.status(400).json({
          status: 'error',
          message: 'Type and source must be strings',
        });
      }

      // Normalize BEFORE schema validation
      const normalizedType = type.trim().toLowerCase();
      const normalizedSource = source.trim();

      const normalizedEvent = {
        type: normalizedType,
        source: normalizedSource,
        payload
      };

      // Validate against envelope schema
      if (!validateEventEnvelope(normalizedEvent)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid event envelope',
          errors: validateEventEnvelope.errors,
        });
      }

      if (
        normalizedType.length > MAX_STRING_LENGTH ||
        normalizedSource.length > MAX_STRING_LENGTH
      ) {
        return res.status(400).json({
          status: 'error',
          message: `Event must include non-empty type & source (max ${MAX_STRING_LENGTH} chars) and payload`,
        });
      }

      // Pre-check serialization to prevent silent drop
      try {
        JSON.stringify(payload);
      } catch (error) {
        return res.status(400).json({
          status: 'error',
          message: 'Payload must be JSON-serializable',
        });
      }

      // Process event (logging + forwarding)
      // Detached execution to not block response, but tracked in pendingFetches inside processEvent
      processEvent({ type: normalizedType, source: normalizedSource, payload }).catch(err => {
        logger.error({ err }, 'Error processing event');
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

    logger.error({ err }, 'Internal Server Error');
    res.status(500).json({
      status: 'error',
      message: 'Internal Server Error',
    });
  });

  return app;
}

export async function processEvent(event: PlexerEvent): Promise<void> {
  const { type, source, payload } = event;

  // Normalize undefined payload to null to ensure schema compliance (payload is required)
  const effectivePayload = payload === undefined ? null : payload;
  const { json: payloadJson, error: serializationError } = tryJson(effectivePayload);

  let payloadPreview = String(effectivePayload);

  if (typeof effectivePayload === 'object' && effectivePayload !== null) {
    payloadPreview = payloadJson ?? '[Circular or invalid payload]';
  }

  if (payloadPreview.length > 100) {
    payloadPreview = `${payloadPreview.slice(0, 100)}…`;
  }

  logger.info({
    type,
    source,
    payload: payloadPreview,
  }, 'Received event');

  // Soft-guard for notification-only events
  if (type === EVENT_INSIGHTS_DAILY_PUBLISHED) {
    const payloadBytes = getPayloadSizeBytes(payloadJson);
    if (payloadBytes === null) {
      logger.warn(
        `::warning:: ${EVENT_INSIGHTS_DAILY_PUBLISHED} payload size could not be computed (non-serializable payload)`,
      );
    } else if (payloadBytes > 1024) {
      logger.warn(
        `::warning:: ${EVENT_INSIGHTS_DAILY_PUBLISHED} payload exceeds 1KB notification-only limit (bytes=${payloadBytes})`,
      );
    }
  }

  // Strict Pass-through: Do not inject 'eventId' or timestamp into the forwarded body.
  // The contract requires the payload to remain untouched.
  let serializedEvent: string;

  if (payloadJson === null) {
    logger.error({ err: serializationError }, 'Failed to serialize event payload for forwarding');
    return;
  }

  // payloadJson cannot be undefined here because effectivePayload is never undefined
  // (JSON.stringify(null) === "null")
  serializedEvent = `{"type":${JSON.stringify(type)},"source":${JSON.stringify(source)},"payload":${payloadJson}}`;

  const eventId = randomUUID();

  CONSUMERS.forEach(({ key, label, url, token, authKind }) => {
    if (!url) return;

    if (!shouldForward(type, key)) {
      return;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        Object.assign(headers, getAuthHeaders(authKind, token, key));
      }

      const fetchPromise = fetch(url, {
        method: 'POST',
        headers,
        body: serializedEvent,
      })
        .then((response) => {
          const logData: Record<string, unknown> = {
            event_id: eventId,
            publisher: source,
            delivered_to: label,
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

          if (response.ok) {
            logger.info(logData, 'Event forwarded');
          } else {
            let errorMessage = `Failed to forward event to ${label}: ${response.status} ${response.statusText}`;
            if (response.status === 401 || response.status === 403) {
              errorMessage += ' (token rejected)';
            }

            const context: Record<string, unknown> = {
              status: response.status,
              label,
              type,
            };

            // Reliability Policy:
            // - Heimgeist: Critical push -> Queue on failure
            // - Others (Chronik, Leitstand, hausKI): Best-effort notification -> Log warn on failure
            // - BEST_EFFORT_EVENTS override: Always warn, never queue
            const isCriticalConsumer = key === 'heimgeist';
            const isBestEffortEvent = BEST_EFFORT_EVENTS.has(type);

            if (isBestEffortEvent || !isCriticalConsumer) {
              context.log_kind = 'best_effort_forward_failed';
              logger.warn(context, `[Best-Effort] ${errorMessage}`);
            } else {
              saveFailedEvent(
                {
                  type,
                  source,
                  payload,
                },
                key,
                errorMessage,
              ).catch((e) => logger.error({ err: e }, 'Failed to save failed event'));
              logger.error(context, errorMessage);
            }
          }
        })
        .catch((error) => {
          const errorMessage = `Error forwarding event to ${label}:`;
          const context: Record<string, unknown> = {
            label,
            type,
            error: error instanceof Error ? error.message : String(error),
          };

          // Reliability Policy (same as above)
          const isCriticalConsumer = key === 'heimgeist';
          const isBestEffortEvent = BEST_EFFORT_EVENTS.has(type);

          if (isBestEffortEvent || !isCriticalConsumer) {
            context.log_kind = 'best_effort_forward_failed';
            logger.warn(context, `[Best-Effort] ${errorMessage}`);
          } else {
            saveFailedEvent(
              {
                type,
                source,
                payload,
              },
              key,
              error instanceof Error ? error.message : String(error),
            ).catch((e) => logger.error({ err: e }, 'Failed to save failed event'));
            logger.error(context, errorMessage);
          }
        })
        .finally(() => {
          pendingFetches.delete(fetchPromise);
        });
      pendingFetches.add(fetchPromise);
    } catch (error) {
      logger.error({ err: error }, `Failed to initiate forward to ${label}`);
    }
  });
}
