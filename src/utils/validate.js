'use strict';

const HttpError = require('./httpError');
const { ROLES } = require('../models/User');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

function fail(message) {
  throw new HttpError(400, message);
}

function objectId(value, field = 'id') {
  if (typeof value !== 'string' || !OBJECT_ID_RE.test(value)) fail(`${field} must be a valid id`);
  return value.toLowerCase(); // canonical form, so string comparisons with req.user.id are reliable
}

function string(value, field, { min = 1, max = 200, trim = true } = {}) {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const v = trim ? value.trim() : value;
  if (v.length < min) fail(min === 1 ? `${field} is required` : `${field} must be at least ${min} characters`);
  if (v.length > max) fail(`${field} must be at most ${max} characters`);
  return v;
}

function email(value) {
  const v = string(value, 'email', { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(v)) fail('email must be a valid email address');
  return v;
}

// bcrypt only uses the first 72 bytes of its input, so longer passwords are rejected
// instead of being silently truncated.
function password(value, field = 'password') {
  const v = string(value, field, { min: 8, max: 72, trim: false });
  if (Buffer.byteLength(v, 'utf8') > 72) fail(`${field} must be at most 72 bytes`);
  return v;
}

function role(value) {
  if (!ROLES.includes(value)) fail(`role must be one of: ${ROLES.join(', ')}`);
  return value;
}

// Interests are normalised (trimmed, lower-cased, de-duplicated) so that grouping by
// interest is consistent and a user is never counted twice in the same group.
// The length limit is checked AFTER lower-casing (some characters grow when lower-cased),
// so every stored interest is also a valid ?interest= filter value.
function interest(value) {
  const v = string(value, 'interest', { max: 200 }).toLowerCase();
  if (v.length > 50) fail('interest must be at most 50 characters');
  return v;
}

function interests(value) {
  if (!Array.isArray(value)) fail('interests must be an array of strings');
  if (value.length > 20) fail('interests can contain at most 20 items');
  const out = [];
  for (const item of value) {
    const v = interest(item);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// Copies only allowed keys; rejects requests that contain nothing to update.
function pickUpdates(body, validators) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('request body must be a JSON object');
  const updates = {};
  for (const [key, validator] of Object.entries(validators)) {
    if (body[key] !== undefined) updates[key] = validator(body[key]);
  }
  if (Object.keys(updates).length === 0) fail(`provide at least one of: ${Object.keys(validators).join(', ')}`);
  return updates;
}

function body(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail('request body must be a JSON object');
  return req.body;
}

module.exports = { objectId, string, email, password, role, interest, interests, pickUpdates, body };
