export const EVENT_KNOWLEDGE_OBSERVATORY_PUBLISHED_V1 =
  'knowledge.observatory.published.v1';
export const EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1 =
  'integrity.summary.published.v1';

// Intentionally unversioned (notification-only event)
export const EVENT_INSIGHTS_DAILY_PUBLISHED = 'insights.daily.published';

export const BROADCAST_EVENTS = new Set([
  EVENT_KNOWLEDGE_OBSERVATORY_PUBLISHED_V1,
  EVENT_INTEGRITY_SUMMARY_PUBLISHED_V1,
]);
