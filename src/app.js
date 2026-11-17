'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Only trust X-Forwarded-For when actually behind a reverse proxy, otherwise clients could
  // spoof their IP and bypass the login rate limiter.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  // The frontend is a separate site, so the API only accepts browser calls from the origins listed
  // in CORS_ORIGIN. Auth uses a Bearer header (no cookies), so credentials are not enabled.
  app.use('/api', cors({ origin: config.corsOrigins, maxAge: 600 }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', routes);
  app.use('/api', notFound);

  // Lets someone opening the bare API URL see that it is running.
  app.get('/', (req, res) => res.json({ name: 'Secure Notes API', health: '/api/health' }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = createApp;
