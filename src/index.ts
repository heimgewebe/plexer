import { createServer, drainPendingRequests, processEvent, getPendingRequestCount } from './server';
import { config } from './config';
import {
  EVENT_PLEXER_DELIVERY_REPORT_V1,
  DEFAULT_RETRY_INTERVAL_MS,
  MIN_RETRY_DELAY_MS,
  REPORT_INTERVAL_MS,
} from './constants';
import { retryFailedEvents, getNextDueAt, initDelivery, getDeliveryMetrics } from './delivery';

const app = createServer();

// Initialize delivery system (recovery + metrics)
initDelivery().catch((err) => {
  console.error('Failed to initialize delivery system:', err);
});

// Periodic Delivery Report Event
setInterval(() => {
  if (process.env.NODE_ENV !== 'test') {
    const report = getDeliveryMetrics(getPendingRequestCount());
    processEvent({
      type: EVENT_PLEXER_DELIVERY_REPORT_V1,
      source: 'plexer',
      payload: report
    }).catch((err) => {
      console.error('Failed to send delivery report event:', err);
    });
  }
}, REPORT_INTERVAL_MS);

function scheduleRetry() {
  const nextDue = getNextDueAt();
  let delay = DEFAULT_RETRY_INTERVAL_MS;

  if (nextDue) {
    const now = Date.now();
    const dueTime = new Date(nextDue).getTime();
    const diff = dueTime - now;

    // Clamp delay between 5s and 60s
    delay = Math.min(DEFAULT_RETRY_INTERVAL_MS, Math.max(MIN_RETRY_DELAY_MS, diff));
  }

  // Add jitter (+/- 1s)
  delay += (Math.random() - 0.5) * 2000;

  // Ensure non-negative
  if (delay < MIN_RETRY_DELAY_MS) delay = MIN_RETRY_DELAY_MS;

  retryTimer = setTimeout(() => {
    retryFailedEvents()
      .catch((err) => {
        console.error('Failed to retry events:', err);
      })
      .finally(() => {
        if (!isShuttingDown) {
          scheduleRetry();
        }
      });
  }, delay);
}

let retryTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;

if (process.env.NODE_ENV !== 'test') {
  scheduleRetry();
}

const server = app.listen(config.port, config.host, () => {
  console.log(`Server is running on http://${config.host}:${config.port}`);
  console.log(`Environment: ${config.environment}`);
});

const shutdown = () => {
  console.log('Shutting down server...');
  isShuttingDown = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
  }
  server.close(async () => {
    console.log('Server closed. Draining pending requests...');
    await drainPendingRequests();
    console.log('Pending requests drained. Exiting.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
