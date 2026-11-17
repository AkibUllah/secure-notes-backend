'use strict';

const HttpError = require('./httpError');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
// Sane upper bound; also keeps $skip within the 64-bit integer range MongoDB accepts.
const MAX_PAGE = 1_000_000;

// Only plain decimal digits are accepted ("0x10", "1e2", arrays, objects -> default).
function toPositiveInt(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n > 0 ? n : fallback;
}

// Parses ?page=&limit= into safe values used for skip/limit.
function parsePagination(query = {}) {
  const page = toPositiveInt(query.page, 1);
  if (page > MAX_PAGE) throw new HttpError(400, `page must be at most ${MAX_PAGE}`);
  const limit = Math.min(toPositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

function paginated(data, total, { page, limit }) {
  return {
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

module.exports = { parsePagination, paginated, DEFAULT_LIMIT, MAX_LIMIT, MAX_PAGE };
