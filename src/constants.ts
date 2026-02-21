export const EVENT_KNOWLEDGE_OBSERVATORY_PUBLISHED_V1 =
  'knowledge.observatory.published.v1';

// Best-effort forwarding; primary integrity loop is pull-based (Chronik -> Release Assets)
export const EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1 =
  'integrity.summary.published.v1';

// Intentionally unversioned (notification-only event)
export const EVENT_INSIGHTS_DAILY_PUBLISHED = 'insights.daily.published';

export const EVENT_PLEXER_DELIVERY_REPORT_V1 = 'plexer.delivery.report.v1';

export const BROADCAST_EVENTS = new Set([
  EVENT_KNOWLEDGE_OBSERVATORY_PUBLISHED_V1,
  EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1,
  EVENT_PLEXER_DELIVERY_REPORT_V1,
]);

// Events that must NOT block routing or trigger retries/alerts.
// Integrity is pull-based; events are optional hints.
export const BEST_EFFORT_EVENTS = new Set([
  EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1,
  EVENT_PLEXER_DELIVERY_REPORT_V1,
]);

export const HTTP_REQUEST_TIMEOUT_MS = 5000;

export const INITIAL_RETRY_DELAY_MS = 30000;
export const RETRY_JITTER_MAX_MS = 10000;
export const RETRY_BACKOFF_BASE_MS = 60000;
export const RETRY_BACKOFF_MAX_MS = 86400000; // 24 hours

export const LOCK_RETRIES = 3;

// For index.ts
export const DEFAULT_RETRY_INTERVAL_MS = 60000;
export const MIN_RETRY_DELAY_MS = 5000;
export const REPORT_INTERVAL_MS = 300000; // 5 minutes
