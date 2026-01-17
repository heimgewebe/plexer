export const EVENT_KNOWLEDGE_OBSERVATORY_PUBLISHED_V1 =
  'knowledge.observatory.published.v1';

// Best-effort forwarding; primary integrity loop is pull-based (Chronik -> Release Assets)
export const EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1 =
  'integrity.summary.published.v1';

// Intentionally unversioned (notification-only event)
export const EVENT_INSIGHTS_DAILY_PUBLISHED = 'insights.daily.published';

export const BROADCAST_EVENTS = new Set([
  EVENT_KNOWLEDGE_OBSERVATORY_PUBLISHED_V1,
  EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1,
]);

// Events that must NOT block routing or trigger retries/alerts.
// Integrity is pull-based; events are optional hints.
export const BEST_EFFORT_EVENTS = new Set([
  EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1,
]);
