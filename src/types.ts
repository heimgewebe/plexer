export interface PlexerEvent {
  type: string;
  source: string;
  payload: unknown;
}

export interface PlexerDeliveryReport {
  counts: {
    pending: number;
    failed: number;
  };
  last_error: string | null;
  last_retry_at: string | null;
}

export interface FailedEvent {
  consumerKey: string;
  event: PlexerEvent;
  retryCount: number;
  lastAttempt: string; // ISO date string
  nextAttempt: string; // ISO date string
  error: string;
}
