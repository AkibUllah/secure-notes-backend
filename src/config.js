'use strict';

require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/secure_notes',
  jwtSecret: process.env.JWT_SECRET,
  // '1h', '30m', ... or a number of seconds (a numeric *string* would be read as milliseconds).
  jwtExpiresIn: /^\d+$/.test(process.env.JWT_EXPIRES_IN || '') ? Number(process.env.JWT_EXPIRES_IN) : process.env.JWT_EXPIRES_IN || '1h',
  // Make the database indexes match exactly what is declared with schema.index()
  // (creates missing ones, drops any index that is not declared).
  syncIndexes: process.env.SYNC_INDEXES !== 'false',
  // Number of reverse-proxy hops to trust (e.g. 1 behind nginx); 0 = not behind a proxy.
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT) || 20,
  // Comma-separated frontend origins allowed to call the API from a browser.
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
};

// The placeholder from .env.example is public, so tokens signed with it could be forged.
const PLACEHOLDER_SECRET = 'change-me-to-a-long-random-secret-of-at-least-32-chars';
if (!config.jwtSecret || config.jwtSecret.length < 32 || config.jwtSecret === PLACEHOLDER_SECRET) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters (see .env.example)');
}

module.exports = config;
