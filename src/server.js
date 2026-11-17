'use strict';

const config = require('./config');
const db = require('./db');
const createApp = require('./app');

async function main() {
  await db.connect();
  const server = createApp().listen(config.port, () => {
    console.log(`Secure Notes API listening on http://localhost:${config.port}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => db.disconnect().finally(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
