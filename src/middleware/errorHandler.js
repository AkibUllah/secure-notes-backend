'use strict';

const mongoose = require('mongoose');
const HttpError = require('../utils/httpError');

function notFound(req, _res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  let status = 500;
  let message = 'Internal server error';
  let details;

  if (err instanceof HttpError) {
    ({ status, message, details } = err);
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => e.message);
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err && err.code === 11000) {
    status = 409;
    message = `${Object.keys(err.keyPattern || err.keyValue || { value: 1 })[0]} already exists`;
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large';
  } else if (err && Number(err.status || err.statusCode) >= 400 && Number(err.status || err.statusCode) < 500) {
    // other client errors raised by Express / body-parser (malformed %-encoding in the URL,
    // unsupported charset, ...)
    status = Number(err.status || err.statusCode);
    message = err.expose ? err.message : 'Bad request';
  }

  if (status >= 500) console.error(err);

  res.status(status).json({ error: { message, ...(details ? { details } : {}) } });
}

module.exports = { notFound, errorHandler };
