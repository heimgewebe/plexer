import { createServer, drainPendingRequests } from './server';
import { config } from './config';
import { retryFailedEvents } from './delivery';

const app = createServer();
const RETRY_INTERVAL_MS = 60 * 1000;

function scheduleRetry() {
  setTimeout(() => {
    retryFailedEvents()
      .catch((err) => {
        console.error('Failed to retry events:', err);
      })
      .finally(() => {
        scheduleRetry();
      });
  }, RETRY_INTERVAL_MS);
}

scheduleRetry();

const server = app.listen(config.port, config.host, () => {
  console.log(`Server is running on http://${config.host}:${config.port}`);
  console.log(`Environment: ${config.environment}`);
});

const shutdown = () => {
  console.log('Shutting down server...');
  server.close(async () => {
    console.log('Server closed. Draining pending requests...');
    await drainPendingRequests();
    console.log('Pending requests drained. Exiting.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
