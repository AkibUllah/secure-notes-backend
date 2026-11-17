'use strict';

// Rate limiting, in its own process (node --test runs each file separately) with a low limit.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-1234';
process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const db = require('../src/db');
const createApp = require('../src/app');

const uri = (process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/secure_notes_test') + '_ratelimit';
let server;
let base;

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status;
}

before(async () => {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await db.connect(uri);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await db.disconnect();
});

test('login: only wrong credentials count; malformed requests and successes do not', async () => {
  assert.equal(await call('POST', '/auth/register', { body: { name: 'A', email: 'a@t.io', password: 'password1' } }), 201);
  for (let i = 0; i < 5; i++) assert.equal(await call('POST', '/auth/login', { body: { email: 'a@t.io', password: 'password1' } }), 200);
  for (let i = 0; i < 5; i++) assert.equal(await call('POST', '/auth/login', { body: { email: 1 } }), 400);
  assert.equal(await call('POST', '/auth/login', { body: { email: 'a@t.io', password: 'password1' } }), 200, 'still allowed');
  for (let i = 0; i < 3; i++) assert.equal(await call('POST', '/auth/login', { body: { email: 'a@t.io', password: 'wrong-pass' } }), 401);
  assert.equal(await call('POST', '/auth/login', { body: { email: 'a@t.io', password: 'password1' } }), 429, 'locked after 3 failures');
});

test('register has its own bucket', async () => {
  // a@t.io was registered above (1 of 3); two more fit, the fourth is limited
  assert.equal(await call('POST', '/auth/register', { body: { name: 'B', email: 'b@t.io', password: 'password1' } }), 201);
  assert.equal(await call('POST', '/auth/register', { body: { name: 'C', email: 'c@t.io', password: 'password1' } }), 201);
  assert.equal(await call('POST', '/auth/register', { body: { name: 'D', email: 'd@t.io', password: 'password1' } }), 429);
});

test('password changes: per user, only wrong currentPassword counts, other profile edits unaffected', async () => {
  const user = await mongoose.connection.db.collection('users').findOne({ email: 'b@t.io' });
  const other = await mongoose.connection.db.collection('users').findOne({ email: 'c@t.io' });
  const jwt = require('jsonwebtoken');
  const tb = jwt.sign({ sub: String(user._id), ver: 0 }, process.env.JWT_SECRET);
  const tc = jwt.sign({ sub: String(other._id), ver: 0 }, process.env.JWT_SECRET);

  for (let i = 0; i < 5; i++) assert.equal(await call('PATCH', '/profile', { token: tb, body: { name: '' } }), 400); // not counted
  for (let i = 0; i < 3; i++) {
    assert.equal(await call('PATCH', '/profile', { token: tb, body: { password: 'newpassword', currentPassword: 'nope-nope' } }), 400);
  }
  assert.equal(await call('PATCH', '/profile', { token: tb, body: { password: 'newpassword', currentPassword: 'password1' } }), 429);
  assert.equal(await call('PATCH', '/profile', { token: tb, body: { name: 'Still editable' } }), 200, 'non-password edits still work');
  assert.equal(await call('PATCH', '/profile', { token: tc, body: { password: 'newpassword', currentPassword: 'password1' } }), 200, 'other users unaffected');
});
