import express, { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { config } from './config';
import { PlexerEvent } from './types';
import {
  BROADCAST_EVENTS,
  EVENT_INSIGHTS_DAILY_PUBLISHED,
  BEST_EFFORT_EVENTS,
  HTTP_REQUEST_TIMEOUT_MS,
} from './constants';
import { CONSUMERS } from './consumers';
import { getAuthHeaders } from './auth';
import { logger } from './logger';
// NOTE: p-limit v3 is used because it supports CommonJS. v4+ is ESM-only.
import pLimit from 'p-limit';
import {
  saveFailedEvent,
  getDeliveryMetrics,
  validateDeliveryReport,
  validateEventEnvelope,
} from './delivery';
import { deliverToChronikAgentLedger } from './chronik';

const pendingFetches = new Set<Promise<void>>();
/**
 * Hardcoded fanout concurrency: limits burst load; tuned for small home deployments.
 * If future tuning is needed, reintroduce env var with validation + docs.
 */
const forwardLimit = pLimit(10);

type TryJsonResult =
  | { kind: 'ok'; json: string }
  | { kind: 'undefined' }
  | { kind: 'error'; error: unknown };

type PayloadSizeKind = 'json' | 'unavailable';

const ALLOWED_AGENT_RUN_EVENT_KEYS = new Set([
  'schema_version',
  'event_id',
  'kind',
  'ts',
  'source',
  'subject',
  'trust_tier',
  'status',
  'caused_by',
  'evidence_refs',
  'data',
  'corrects',
]);

const ALLOWED_AGENT_RUN_EVENT_KINDS = new Set([
  'agent.run.started',
  'agent.run.completed',
  'agent.run.blocked',
]);
const MAX_V1_EVENT_BYTES = 8192;
const ALLOWED_AGENT_RUN_DATA_KEYS = new Set([
  'result',
  'blocker_code',
  'summary',
  'duration_ms',
]);

function isValidV1AgentRunDataValue(key: string, value: unknown): boolean {
  if (key === 'duration_ms') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
  if (typeof value !== 'string') return false;
  return value.length <= (key === 'summary' ? 1024 : 256);
}

type V1ValidationResult =
  | { ok: true; eventJson: string; eventSize: number }
  | { ok: false; statusCode: number; message: string };

function validateV1AgentRunEvent(body: unknown): V1ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, statusCode: 400, message: 'Invalid event structure' };
  }

  const event = body as Record<string, unknown>;
  const disallowedEventKeys = Object.keys(event)
    .filter((key) => !ALLOWED_AGENT_RUN_EVENT_KEYS.has(key));
  if (disallowedEventKeys.length > 0) {
    return { ok: false, statusCode: 422, message: 'event contains unsupported keys' };
  }

  if (typeof event.kind !== 'string') {
    return { ok: false, statusCode: 400, message: 'kind must be a string' };
  }

  if (!ALLOWED_AGENT_RUN_EVENT_KINDS.has(event.kind)) {
    return { ok: false, statusCode: 422, message: 'Unsupported event kind' };
  }

  const data = event.data;
  if (data !== undefined) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, statusCode: 400, message: 'data must be an object when present' };
    }

    const dataRecord = data as Record<string, unknown>;
    const disallowedKeys = Object.keys(dataRecord)
      .filter((key) => !ALLOWED_AGENT_RUN_DATA_KEYS.has(key));
    if (disallowedKeys.length > 0) {
      return { ok: false, statusCode: 422, message: 'data contains unsupported keys' };
    }

    for (const [key, value] of Object.entries(dataRecord)) {
      if (!isValidV1AgentRunDataValue(key, value)) {
        return { ok: false, statusCode: 422, message: 'data contains invalid values' };
      }
    }
  }

  const jsonResult = tryJson(body);
  if (jsonResult.kind !== 'ok') {
    return { ok: false, statusCode: 400, message: 'Event must be JSON-serializable' };
  }

  const eventSize = getPayloadSizeBytes(jsonResult.json);
  if (eventSize > MAX_V1_EVENT_BYTES) {
    return { ok: false, statusCode: 413, message: 'Event payload too large' };
  }

  return { ok: true, eventJson: jsonResult.json, eventSize };
}

function tryJson(value: unknown): TryJsonResult {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? { kind: 'undefined' } : { kind: 'ok', json };
  } catch (error) {
    return { kind: 'error', error };
  }
}

function getPayloadSizeBytes(payloadJson: string): number {
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
    '/v1/events',
    async (
      req: Request<unknown, unknown, unknown>,
      res: Response,
    ) => {
      const validation = validateV1AgentRunEvent(req.body);
      if (!validation.ok) {
        return res.status(validation.statusCode).json({
          status: 'error',
          message: validation.message,
        });
      }

      const delivery = await deliverToChronikAgentLedger(req.body);
      logger.info({
        kind: (req.body as Record<string, unknown>).kind,
        delivery_status: delivery.status,
        retryable: delivery.retryable,
        event_size: validation.eventSize,
      }, 'Processed v1 event');

      if (delivery.status === 'delivered') {
        return res.status(202).json({ status: 'accepted' });
      }

      if (delivery.status === 'skipped') {
        return res.status(503).json({
          status: 'error',
          message: 'Chronik delivery is not configured',
          retryable: false,
        });
      }

      if (delivery.retryable) {
        return res.status(503).json({
          status: 'error',
          message: 'Chronik delivery failed',
          retryable: true,
        });
      }

      return res.status(502).json({
        status: 'error',
        message: 'Chronik rejected event',
        retryable: false,
      });
    },
  );

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

  // Normalize undefined payload to null to keep a stable event shape (payload is required).
  // Note: JSON.stringify can still return undefined for values like functions/symbols.
  const effectivePayload = payload === undefined ? null : payload;
  const jsonResult = tryJson(effectivePayload);

  const payloadSize = jsonResult.kind === 'ok' ? getPayloadSizeBytes(jsonResult.json) : null;
  const payloadSizeKind: PayloadSizeKind = jsonResult.kind === 'ok' ? 'json' : 'unavailable';

  logger.info({
    type,
    source,
    payload_size: payloadSize,
    payload_size_kind: payloadSizeKind,
  }, 'Received event');

  // Soft-guard for notification-only events
  if (type === EVENT_INSIGHTS_DAILY_PUBLISHED) {
    if (jsonResult.kind !== 'ok') {
      logger.warn(
        `::warning:: ${EVENT_INSIGHTS_DAILY_PUBLISHED} payload size could not be computed (not JSON-encodable or circular)`,
      );
    } else {
      const payloadBytes = getPayloadSizeBytes(jsonResult.json);
      if (payloadBytes > 1024) {
        logger.warn(
          `::warning:: ${EVENT_INSIGHTS_DAILY_PUBLISHED} payload exceeds 1KB notification-only limit (bytes=${payloadBytes})`,
        );
      }
    }
  }

  // Strict Pass-through: Do not inject 'eventId' or timestamp into the forwarded body.
  // The contract requires the payload to remain untouched (except normalization of undefined to null for schema compliance).
  let serializedEvent: string;

  if (jsonResult.kind === 'error') {
    logger.error({ err: jsonResult.error }, 'Failed to serialize event payload for forwarding');
    return;
  }

  if (jsonResult.kind === 'undefined') {
    // This happens if payload contains non-serializable types like functions or symbols
    logger.error(
      { payloadType: typeof effectivePayload },
      'Payload serialized to undefined; dropping event to preserve contract semantics',
    );
    return;
  }

  serializedEvent = `{"type":${JSON.stringify(type)},"source":${JSON.stringify(source)},"payload":${jsonResult.json}}`;

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

      const fetchPromise = forwardLimit(() => fetch(url, {
        method: 'POST',
        headers,
        body: serializedEvent,
        signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
      }))
        .then(async (response) => {
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
              await saveFailedEvent(
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
        .catch(async (error) => {
          const errorDetail = error instanceof Error ? error.message : String(error);
          const errorMessage = `Error forwarding event to ${label}: ${errorDetail}`;
          const context: Record<string, unknown> = {
            label,
            type,
            error: errorDetail,
          };

          // Reliability Policy (same as above)
          const isCriticalConsumer = key === 'heimgeist';
          const isBestEffortEvent = BEST_EFFORT_EVENTS.has(type);

          if (isBestEffortEvent || !isCriticalConsumer) {
            context.log_kind = 'best_effort_forward_failed';
            logger.warn(context, `[Best-Effort] ${errorMessage}`);
          } else {
            await saveFailedEvent(
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
