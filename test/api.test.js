'use strict';

// End-to-end tests against a real MongoDB.
// TEST_MONGODB_URI defaults to mongodb://127.0.0.1:27017/secure_notes_test (database is dropped!).

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-1234';
process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.SYNC_INDEXES = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const db = require('../src/db');
const createApp = require('../src/app');
const User = require('../src/models/User');
const Note = require('../src/models/Note');
const Post = require('../src/models/Post');
const { buildInterestPipeline } = require('../src/controllers/interestController');
const { buildUserPostsPipeline } = require('../src/controllers/postController');

const uri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/secure_notes_test';
let server;
let base;

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const tokens = {};
const ids = {};

before(async () => {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await db.connect(uri);
  // Record every operation of the suite; the last test checks that none of them was a
  // collection scan or an in-memory sort.
  await mongoose.connection.db.command({ profile: 2 });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  // First admin is created directly (public registration can never create admins).
  const admin = await User.create({ name: 'Root', email: 'root@test.io', password: 'AdminPass1', role: 'admin' });
  ids.admin = String(admin._id);
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await db.disconnect();
});

// ---------------------------------------------------------------- indexes
test('only the required indexes exist, all declared via schema.index()', async () => {
  const keys = async (m) => (await m.collection.indexes()).map((i) => ({ key: i.key, unique: !!i.unique }));
  assert.deepEqual(await keys(User), [
    { key: { _id: 1 }, unique: false },
    { key: { email: 1 }, unique: true },
    { key: { interests: 1, name: 1, _id: 1 }, unique: false },
  ]);
  assert.deepEqual(await keys(Note), [
    { key: { _id: 1 }, unique: false },
    { key: { owner: 1, _id: -1 }, unique: false },
  ]);
  assert.deepEqual(await keys(Post), [
    { key: { _id: 1 }, unique: false },
    { key: { author: 1, _id: -1 }, unique: false },
  ]);
});

test('syncIndexes removes indexes that are not declared in the schema', async () => {
  await Note.collection.createIndex({ title: 1 });
  await Note.syncIndexes();
  const names = (await Note.collection.indexes()).map((i) => i.name);
  assert.deepEqual(names, ['_id_', 'owner_1__id_-1']);
});

// ---------------------------------------------------------------- auth
test('register creates a regular user, hashes the password, returns a JWT', async () => {
  const r = await call('POST', '/auth/register', {
    body: { name: 'Alice', email: 'Alice@Test.io', password: 'password1', interests: ['Chess', 'reading', 'chess'], role: 'admin' },
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  assert.equal(r.body.user.role, 'user', 'role in the body must be ignored');
  assert.equal(r.body.user.email, 'alice@test.io');
  assert.deepEqual(r.body.user.interests, ['chess', 'reading']);
  assert.equal(r.body.user.password, undefined);
  tokens.alice = r.body.token;
  ids.alice = r.body.user._id;

  const stored = await User.findById(ids.alice).select('+password').lean();
  assert.notEqual(stored.password, 'password1');
  assert.match(stored.password, /^\$2[aby]\$/);
});

test('register validation and duplicate email', async () => {
  assert.equal((await call('POST', '/auth/register', { body: { name: 'X', email: 'bad', password: 'password1' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: { name: 'X', email: 'x@test.io', password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: { email: 'x@test.io', password: 'password1' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: '{bad json' })).status, 400);
  const tooLong = await call('POST', '/auth/register', { body: { name: 'X', email: 'x@test.io', password: 'é'.repeat(40) } });
  assert.equal(tooLong.status, 400, 'passwords over 72 bytes (bcrypt limit) are rejected');
  const dup = await call('POST', '/auth/register', { body: { name: 'A2', email: 'alice@test.io', password: 'password1' } });
  assert.equal(dup.status, 409);
});

test('login succeeds with correct credentials and fails generically otherwise', async () => {
  const ok = await call('POST', '/auth/login', { body: { email: 'root@test.io', password: 'AdminPass1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  assert.equal(ok.body.user.password, undefined);
  tokens.admin = ok.body.token;

  const wrong = await call('POST', '/auth/login', { body: { email: 'root@test.io', password: 'nope-nope' } });
  const missing = await call('POST', '/auth/login', { body: { email: 'ghost@test.io', password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error.message, missing.body.error.message);

  const injection = await call('POST', '/auth/login', { body: { email: { $gt: '' }, password: { $gt: '' } } });
  assert.equal(injection.status, 400);
});

test('protected routes require a valid token', async () => {
  assert.equal((await call('GET', '/notes')).status, 401);
  assert.equal((await call('GET', '/notes', { token: 'garbage' })).status, 401);
  const forged = require('jsonwebtoken').sign({ sub: ids.admin, role: 'admin' }, 'another-secret-another-secret-123456');
  assert.equal((await call('GET', '/notes', { token: forged })).status, 401);
  const none = require('jsonwebtoken').sign({ sub: ids.admin, role: 'admin' }, '', { algorithm: 'none' });
  assert.equal((await call('GET', '/notes', { token: none })).status, 401);
});

// ---------------------------------------------------------------- notes (user)
test('user can create, list (paginated), view, update and delete own notes', async () => {
  for (let i = 1; i <= 12; i++) {
    const r = await call('POST', '/notes', { token: tokens.alice, body: { title: `Note ${i}`, content: `c${i}` } });
    assert.equal(r.status, 201);
    assert.equal(r.body.note.owner, ids.alice);
  }
  const page1 = await call('GET', '/notes?page=1&limit=5', { token: tokens.alice });
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.length, 5);
  assert.deepEqual(page1.body.pagination, { page: 1, limit: 5, total: 12, totalPages: 3 });
  assert.equal(page1.body.data[0].title, 'Note 12', 'newest first');
  const page3 = await call('GET', '/notes?page=3&limit=5', { token: tokens.alice });
  assert.equal(page3.body.data.length, 2);
  assert.equal(page3.body.data[1].title, 'Note 1');

  const defaults = await call('GET', '/notes?page=abc&limit=99999', { token: tokens.alice });
  assert.equal(defaults.body.pagination.page, 1);
  assert.equal(defaults.body.pagination.limit, 100, 'limit is capped');

  const id = page1.body.data[0]._id;
  ids.aliceNote = id;
  assert.equal((await call('GET', `/notes/${id}`, { token: tokens.alice })).body.note.title, 'Note 12');
  const upd = await call('PATCH', `/notes/${id}`, { token: tokens.alice, body: { title: 'Edited', owner: ids.admin } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.note.title, 'Edited');
  assert.equal(upd.body.note.owner, ids.alice, 'owner cannot be changed');
  assert.equal((await call('PATCH', `/notes/${id}`, { token: tokens.alice, body: {} })).status, 400);
  assert.equal((await call('POST', '/notes', { token: tokens.alice, body: { content: 'no title' } })).status, 400);

  const del = await call('DELETE', `/notes/${page1.body.data[1]._id}`, { token: tokens.alice });
  assert.equal(del.status, 204);
  assert.equal((await call('GET', '/notes', { token: tokens.alice })).body.pagination.total, 11);
  assert.equal((await call('GET', '/notes/not-an-id', { token: tokens.alice })).status, 400);
});

test('users cannot see or modify other users notes', async () => {
  const bob = await call('POST', '/auth/register', { body: { name: 'Bob', email: 'bob@test.io', password: 'password1', interests: ['reading', 'hiking'] } });
  tokens.bob = bob.body.token;
  ids.bob = bob.body.user._id;
  await call('POST', '/notes', { token: tokens.bob, body: { title: 'Bob note' } });

  const list = await call('GET', '/notes', { token: tokens.bob });
  assert.equal(list.body.pagination.total, 1);
  assert.ok(list.body.data.every((n) => n.owner === ids.bob));

  assert.equal((await call('GET', `/notes/${ids.aliceNote}`, { token: tokens.bob })).status, 404);
  assert.equal((await call('PATCH', `/notes/${ids.aliceNote}`, { token: tokens.bob, body: { title: 'hacked' } })).status, 404);
  assert.equal((await call('DELETE', `/notes/${ids.aliceNote}`, { token: tokens.bob })).status, 404);
  assert.equal((await Note.findById(ids.aliceNote).lean()).title, 'Edited');

  assert.equal((await call('GET', '/notes/all', { token: tokens.bob })).status, 403);
});

// ---------------------------------------------------------------- admin
test('admin can view everyone\'s notes (paginated, filterable by owner) and any single note', async () => {
  await call('POST', '/notes', { token: tokens.admin, body: { title: 'Admin own note' } });
  const all = await call('GET', '/notes/all?limit=50', { token: tokens.admin });
  assert.equal(all.status, 200);
  assert.equal(all.body.pagination.total, 13);
  const owners = new Set(all.body.data.map((n) => n.owner._id));
  assert.deepEqual(owners, new Set([ids.alice, ids.bob, ids.admin]));
  assert.ok(all.body.data[0].owner.name);

  const bobs = await call('GET', `/notes/all?owner=${ids.bob}`, { token: tokens.admin });
  assert.equal(bobs.body.pagination.total, 1);
  assert.equal((await call('GET', '/notes/all?owner=zzz', { token: tokens.admin })).status, 400);

  const single = await call('GET', `/notes/${ids.aliceNote}`, { token: tokens.admin });
  assert.equal(single.status, 200);
  assert.equal(single.body.note.owner._id, ids.alice);

  // admin keeps the user capabilities on own notes
  const mine = await call('GET', '/notes', { token: tokens.admin });
  assert.equal(mine.body.pagination.total, 1);
});

test('admin can add, list, view, update and remove users', async () => {
  for (const [method, path] of [['GET', '/users'], ['POST', '/users'], ['GET', `/users/${ids.admin}`],
    ['PATCH', `/users/${ids.alice}`], ['DELETE', `/users/${ids.admin}`]]) {
    const r = await call(method, path, { token: tokens.alice, body: method === 'GET' ? undefined : { role: 'admin' } });
    assert.equal(r.status, 403, `${method} ${path} is admin-only`);
  }

  const created = await call('POST', '/users', {
    token: tokens.admin,
    body: { name: 'Carol', email: 'carol@test.io', password: 'password1', role: 'user', interests: ['chess', 'music'] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.password, undefined);
  ids.carol = created.body.user._id;
  assert.equal((await call('POST', '/users', { token: tokens.admin, body: { name: 'C', email: 'carol@test.io', password: 'password1' } })).status, 409);
  assert.equal((await call('POST', '/users', { token: tokens.admin, body: { name: 'C', email: 'c2@test.io', password: 'password1', role: 'root' } })).status, 400);

  const list = await call('GET', '/users?page=1&limit=2', { token: tokens.admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 2);
  assert.deepEqual(list.body.pagination, { page: 1, limit: 2, total: 4, totalPages: 2 });
  assert.equal(list.body.data[0].email, 'carol@test.io', 'newest first');
  assert.ok(list.body.data.every((u) => u.password === undefined && u.tokenVersion === undefined && u.__v === undefined));

  const one = await call('GET', `/users/${ids.carol}`, { token: tokens.admin });
  assert.equal(one.body.user.name, 'Carol');
  assert.equal((await call('GET', '/users/64b000000000000000000000', { token: tokens.admin })).status, 404);

  const carolLogin = await call('POST', '/auth/login', { body: { email: 'carol@test.io', password: 'password1' } });
  const upd = await call('PATCH', `/users/${ids.carol}`, { token: tokens.admin, body: { name: 'Caroline', role: 'admin', password: 'newpassword' } });
  assert.equal((await call('GET', '/profile', { token: carolLogin.body.token })).status, 401, 'admin password reset revokes tokens');
  assert.equal(upd.status, 200);
  assert.equal(upd.body.user.role, 'admin');
  const login = await call('POST', '/auth/login', { body: { email: 'carol@test.io', password: 'newpassword' } });
  assert.equal(login.status, 200, 'password changed by admin is hashed and usable');
  assert.equal((await call('PATCH', `/users/${ids.carol}`, { token: tokens.admin, body: { email: 'alice@test.io' } })).status, 409);

  for (const id of [ids.admin, ids.admin.toUpperCase()]) {
    assert.equal((await call('PATCH', `/users/${id}`, { token: tokens.admin, body: { role: 'user' } })).status, 400);
    assert.equal((await call('DELETE', `/users/${id}`, { token: tokens.admin })).status, 400);
  }
  assert.equal((await User.findById(ids.admin).lean()).role, 'admin', 'admin is still admin');

  // an admin changing their own password via /users/:id gets a fresh token (old one is revoked)
  const self = await call('PATCH', `/users/${ids.admin}`, { token: tokens.admin, body: { password: 'AdminPass2' } });
  assert.equal(self.status, 200);
  assert.ok(self.body.token);
  assert.equal((await call('GET', '/users', { token: tokens.admin })).status, 401);
  tokens.admin = self.body.token;
  assert.equal((await call('GET', '/users', { token: tokens.admin })).status, 200);

  await call('PATCH', `/users/${ids.carol}`, { token: tokens.admin, body: { role: 'user' } });
});

// ---------------------------------------------------------------- profile
test('user can view and update own profile; password change requires current password', async () => {
  const me = await call('GET', '/profile', { token: tokens.bob });
  assert.equal(me.body.user.email, 'bob@test.io');

  const bad = await call('PATCH', '/profile', { token: tokens.bob, body: { password: 'brandnewpass', currentPassword: 'wrong' } });
  assert.equal(bad.status, 400);
  const ok = await call('PATCH', '/profile', {
    token: tokens.bob,
    body: { name: 'Bobby', password: 'brandnewpass', currentPassword: 'password1', role: 'admin' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'Bobby');
  assert.equal(ok.body.user.role, 'user', 'users cannot escalate their own role');
  assert.equal(ok.body.user.tokenVersion, undefined);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'bob@test.io', password: 'brandnewpass' } })).status, 200);

  // the password change revoked the old token; the response carries a new one
  assert.equal((await call('GET', '/profile', { token: tokens.bob })).status, 401, 'old token revoked');
  assert.ok(ok.body.token);
  tokens.bob = ok.body.token;
  assert.equal((await call('GET', '/profile', { token: tokens.bob })).status, 200);

  // two concurrent password changes: only the token for the password that won stays valid
  const [r1, r2] = await Promise.all([
    call('PATCH', '/profile', { token: tokens.bob, body: { password: 'concurrent-1', currentPassword: 'brandnewpass' } }),
    call('PATCH', '/profile', { token: tokens.bob, body: { password: 'concurrent-2', currentPassword: 'brandnewpass' } }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const valid = [];
  for (const [r, pw] of [[r1, 'concurrent-1'], [r2, 'concurrent-2']]) {
    if ((await call('GET', '/profile', { token: r.body.token })).status === 200) valid.push(pw);
  }
  assert.equal(valid.length, 1, 'exactly one of the two new tokens survives');
  const login = await call('POST', '/auth/login', { body: { email: 'bob@test.io', password: valid[0] } });
  assert.equal(login.status, 200, 'the surviving token belongs to the password that is actually set');
  tokens.bob = login.body.token;

  // a name-only update does not revoke anything
  const nameOnly = await call('PATCH', '/profile', { token: tokens.bob, body: { name: 'Bobby' } });
  assert.equal(nameOnly.body.token, undefined);
  assert.equal((await call('GET', '/profile', { token: tokens.bob })).status, 200);
});

// ---------------------------------------------------------------- posts + Scenario 2
test('posts: authenticated users write, everyone reads', async () => {
  assert.equal((await call('POST', '/posts', { body: { title: 'anon' } })).status, 401);
  for (let i = 1; i <= 7; i++) {
    assert.equal((await call('POST', '/posts', { token: tokens.alice, body: { title: `Alice post ${i}` } })).status, 201);
  }
  const bobPost = await call('POST', '/posts', { token: tokens.bob, body: { title: 'Bob post', content: 'hi' } });
  ids.bobPost = bobPost.body.post._id;

  const feed = await call('GET', '/posts?limit=3');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.data.length, 3);
  assert.equal(feed.body.pagination.total, 8);
  assert.equal(feed.body.data[0].author.name, 'Bobby');

  assert.equal((await call('GET', `/posts/${ids.bobPost}`)).body.post.title, 'Bob post');
  assert.equal((await call('PATCH', `/posts/${ids.bobPost}`, { token: tokens.alice, body: { title: 'x' } })).status, 404);
  assert.equal((await call('DELETE', `/posts/${ids.bobPost}`, { token: tokens.alice })).status, 404);
  assert.equal((await call('PATCH', `/posts/${ids.bobPost}`, { token: tokens.bob, body: { title: 'Bob post!' } })).body.post.title, 'Bob post!');
});

test('Scenario 2: all posts of a particular user via one $lookup aggregation, paginated', async () => {
  const p1 = await call('GET', `/posts/user/${ids.alice}?page=1&limit=5`);
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body.author, { _id: ids.alice, name: 'Alice' });
  assert.deepEqual(p1.body.pagination, { page: 1, limit: 5, total: 7, totalPages: 2 });
  assert.equal(p1.body.data[0].title, 'Alice post 7', 'newest first');
  assert.ok(p1.body.data.every((p) => p.author === ids.alice));

  const p2 = await call('GET', `/posts/user/${ids.alice}?page=2&limit=5`);
  assert.deepEqual(p2.body.data.map((p) => p.title), ['Alice post 2', 'Alice post 1']);

  const none = await call('GET', `/posts/user/${ids.carol}`);
  assert.equal(none.status, 200);
  assert.equal(none.body.pagination.total, 0);
  assert.deepEqual(none.body.data, []);

  assert.equal((await call('GET', '/posts/user/64b000000000000000000000')).status, 404);
  assert.equal((await call('GET', '/posts/user/bad')).status, 400);
});

test('Scenario 2 production pipeline is served by indexes and only fetches the requested page', async () => {
  const pipeline = buildUserPostsPipeline(new mongoose.Types.ObjectId(ids.alice), { skip: 0, limit: 2 });
  const explain = await User.aggregate(pipeline).explain('executionStats');
  const s = JSON.stringify(explain);
  assert.equal(s.includes('COLLSCAN'), false);
  assert.ok(s.includes('IDHACK') || s.includes('EXPRESS_IXSCAN') || s.includes('"indexName":"_id_"'), 'users matched by _id');
  const lookups = explain.stages.filter((st) => st.$lookup);
  assert.equal(lookups.length, 2);
  for (const l of lookups) {
    assert.deepEqual(l.indexesUsed, ['author_1__id_-1']);
    assert.equal(l.collectionScans, 0);
  }
  // Alice has 7 posts; with limit 2 only 2 post documents may be fetched for the page.
  assert.equal(lookups[0].totalDocsExamined, 2, 'limit is pushed down to the index scan');
  assert.equal(lookups[1].totalDocsExamined, 0, 'count is answered from the index alone');
});

// ---------------------------------------------------------------- Scenario 1
test('Scenario 1: users grouped by interests with one collection.aggregate() call', async () => {
  // Interests now: alice [chess, reading], bob [reading, hiking], carol [chess, music], root []
  const spy = [];
  const original = User.collection.aggregate;
  User.collection.aggregate = function (...args) { spy.push('aggregate'); return original.apply(this, args); };
  const forbidden = ['find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct'];
  const originals = {};
  for (const m of forbidden) {
    originals[m] = User.collection[m];
    User.collection[m] = function (...args) { spy.push(m); return originals[m].apply(this, args); };
  }
  let r;
  try {
    r = await call('GET', '/interests?page=1&limit=10', { token: tokens.alice });
  } finally {
    User.collection.aggregate = original;
    for (const m of forbidden) User.collection[m] = originals[m];
  }
  // exactly: the authenticate middleware's one findById (findOne) + the single aggregate
  assert.deepEqual(spy.sort(), ['aggregate', 'findOne']);

  assert.equal(r.status, 200);
  const byInterest = Object.fromEntries(r.body.data.map((g) => [g.interest, g]));
  assert.deepEqual(Object.keys(byInterest).sort(), ['chess', 'hiking', 'music', 'reading']);
  assert.equal(byInterest.chess.count, 2);
  assert.deepEqual(byInterest.chess.users.map((u) => u.name).sort(), ['Alice', 'Caroline']);
  assert.equal(byInterest.reading.count, 2);
  assert.equal(byInterest.music.count, 1);
  assert.equal(byInterest.chess.users[0].email, undefined, 'regular users do not see emails');
  assert.deepEqual(r.body.pagination, { page: 1, limit: 10, total: 4, totalPages: 1 });
  assert.deepEqual(r.body.data.map((g) => g.interest), ['chess', 'reading', 'hiking', 'music'], 'sorted by count desc, name asc');

  const paged = await call('GET', '/interests?page=2&limit=3', { token: tokens.admin });
  assert.deepEqual(paged.body.data.map((g) => g.interest), ['music']);
  assert.ok(paged.body.data[0].users[0].email, 'admins see emails');

  // one group: all its members, paginated and sorted by name
  const filtered = await call('GET', '/interests?interest=Chess&limit=1', { token: tokens.alice });
  assert.equal(filtered.body.interest, 'chess');
  assert.deepEqual(filtered.body.data.map((u) => u.name), ['Alice']);
  assert.deepEqual(filtered.body.pagination, { page: 1, limit: 1, total: 2, totalPages: 2 });
  assert.equal(filtered.body.data[0].email, undefined);
  const filtered2 = await call('GET', '/interests?interest=chess&limit=1&page=2', { token: tokens.alice });
  assert.deepEqual(filtered2.body.data.map((u) => u.name), ['Caroline']);

  const empty = await call('GET', '/interests?interest=nothing', { token: tokens.alice });
  assert.deepEqual(empty.body, { interest: 'nothing', data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } });
  assert.equal((await call('GET', '/interests')).status, 401);
});

test('Scenario 1 production pipelines are index scans; one-group mode has no in-memory sort', async () => {
  for (const interest of [null, 'chess']) {
    const pipeline = buildInterestPipeline({ interest, skip: 0, limit: 10, isAdmin: true });
    const explain = await User.collection.aggregate(pipeline).explain();
    const s = JSON.stringify(explain);
    assert.ok(s.includes('"indexName":"interests_1_name_1__id_1"'), `index used (interest=${interest})`);
    assert.equal(s.includes('COLLSCAN'), false);
    if (interest) {
      assert.equal(/"stage":"SORT"/.test(s), false, 'no blocking SORT stage');
      assert.equal((explain.stages || []).some((st) => st.$sort), false, '$sort is absorbed into the index scan');
    }
  }
});

test('Scenario 1 stays bounded for a very popular interest', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `Fan ${String(i).padStart(2, '0')}`, email: `fan${i}@test.io`, password: 'x'.repeat(60), interests: ['popular'],
  }));
  await User.collection.insertMany(many);
  try {
    const overview = await call('GET', '/interests?limit=1', { token: tokens.alice });
    const g = overview.body.data[0];
    assert.equal(g.interest, 'popular');
    assert.equal(g.count, 40);
    assert.equal(g.users.length, 5, 'overview embeds only a bounded preview of members');
    const members = await call('GET', '/interests?interest=popular&limit=15&page=3', { token: tokens.alice });
    assert.equal(members.body.data.length, 10);
    assert.equal(members.body.data[0].name, 'Fan 30');
    assert.equal(members.body.data.at(-1).name, 'Fan 39');
    assert.equal(members.body.pagination.total, 40);
    assert.equal((await call('GET', '/interests?interest=popular&limit=15&page=4', { token: tokens.alice })).body.pagination.total, 40);

    // the page is read straight from the index: only skip+limit keys and `limit` documents
    const explain = await User.collection
      .aggregate(buildInterestPipeline({ interest: 'popular', skip: 10, limit: 5, isAdmin: true }))
      .explain('executionStats');
    const s = JSON.stringify(explain);
    const docs = [...s.matchAll(/"totalDocsExamined":(\d+)/g)].map((m) => Number(m[1]));
    const keys = [...s.matchAll(/"totalKeysExamined":(\d+)/g)].map((m) => Number(m[1]));
    assert.equal(docs[0], 5, 'only the requested page is fetched');
    assert.equal(keys[0], 15, 'the index scan stops after skip + limit');
    assert.equal(Math.max(...docs.slice(1)), 0, 'the total is counted from the index alone');
  } finally {
    await User.collection.deleteMany({ interests: 'popular' });
  }
});

// ---------------------------------------------------------------- cascade + revocation
test('deleting a user removes their notes and posts and invalidates their token', async () => {
  const r = await call('DELETE', `/users/${ids.bob}`, { token: tokens.admin });
  assert.equal(r.status, 204);
  assert.equal(await Note.countDocuments({ owner: ids.bob }), 0);
  assert.equal(await Post.countDocuments({ author: ids.bob }), 0);
  assert.equal((await call('GET', '/notes', { token: tokens.bob })).status, 401);
  assert.equal((await call('DELETE', `/users/${ids.bob}`, { token: tokens.admin })).status, 404);
});

test('admin can delete any post (moderation); unknown API routes 404', async () => {
  const p = await call('POST', '/posts', { token: tokens.alice, body: { title: 'to moderate' } });
  assert.equal((await call('DELETE', `/posts/${p.body.post._id}`, { token: tokens.admin })).status, 204);
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/nope', { token: tokens.alice })).status, 404);
});

test('edge cases: 404 vs 401, case-insensitive Bearer, blank interest filter, malformed query params', async () => {
  assert.equal((await call('GET', '/nope')).status, 404, 'unknown route is 404 even without a token');
  assert.equal((await call('GET', '/notes')).status, 401);
  const lower = await fetch(`${base}/api/notes`, { headers: { Authorization: `bearer ${tokens.alice}` } });
  assert.equal(lower.status, 200);
  const blank = await call('GET', '/interests?interest=%20%20', { token: tokens.alice });
  assert.equal(blank.status, 200);
  assert.ok(blank.body.pagination.total > 0, 'blank filter means no filter');
  assert.equal((await call('GET', '/interests?interest[]=a', { token: tokens.alice })).status, 400);
  const grows = await call('PATCH', '/profile', { token: tokens.alice, body: { interests: ['İ'.repeat(30)] } });
  assert.equal(grows.status, 400, 'interest length is checked after lower-casing');
  assert.equal((await call('GET', '/notes/all?owner[$ne]=1', { token: tokens.admin })).status, 400);
  const huge = '99999999999999999999';
  for (const path of [`/interests?page=${huge}`, `/posts/user/${ids.alice}?page=${huge}`, '/notes?page=1000001']) {
    assert.equal((await call('GET', path, { token: tokens.alice })).status, 400, `huge page rejected: ${path}`);
  }
  assert.equal((await call('GET', '/posts/%E0%A4%A')).status, 400, 'malformed %-encoding is a 400, not a 500');
  assert.equal((await call('GET', '/notes/%E0%A4%A', { token: tokens.alice })).status, 400);
  for (const q of ['page=1e2', 'page=0x2', 'page[]=2', 'limit=1e2', 'limit=0x10']) {
    const r = await call('GET', `/notes?${q}`, { token: tokens.alice });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.pagination.page, r.body.pagination.limit], [1, 10], `non-decimal ${q} falls back to the default`);
  }
  const weirdPage = await call('GET', '/notes?page[x]=1&limit=-5', { token: tokens.alice });
  assert.equal(weirdPage.status, 200);
  assert.equal(weirdPage.body.pagination.page, 1);
  assert.equal(weirdPage.body.pagination.limit, 10);
});

test('every list / GET query is index-backed with no collection scan and no in-memory sort', async () => {
  const owner = new mongoose.Types.ObjectId(ids.alice);
  const plans = {
    'login findOne({email})': User.find({ email: 'alice@test.io' }).limit(1).explain(),
    'findById (auth, profile, admin get)': User.find({ _id: owner }).explain(),
    'admin list users': User.find().sort({ _id: -1 }).skip(0).limit(10).explain(),
    'my notes': Note.find({ owner }).sort({ _id: -1 }).skip(0).limit(10).explain(),
    'count my notes': Note.collection.aggregate([{ $match: { owner } }, { $group: { _id: 1, n: { $sum: 1 } } }]).explain(),
    'admin all notes': Note.find().sort({ _id: -1 }).skip(0).limit(10).explain(),
    'get note': Note.find({ _id: owner }).explain(),
    'posts feed': Post.find().sort({ _id: -1 }).skip(0).limit(10).explain(),
    'get post': Post.find({ _id: owner }).explain(),
  };
  for (const [label, promise] of Object.entries(plans)) {
    const s = JSON.stringify(await promise);
    assert.equal(s.includes('COLLSCAN'), false, `${label}: no COLLSCAN`);
    assert.equal(/"stage":"SORT"/.test(s), false, `${label}: no in-memory SORT`);
  }
});

test('expired tokens are rejected; logout revokes the token on the server', async () => {
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ sub: ids.alice, ver: 0, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
  assert.equal((await call('GET', '/notes', { token: expired })).status, 401);

  const login = await call('POST', '/auth/login', { body: { email: 'alice@test.io', password: 'password1' } });
  const t = login.body.token;
  assert.equal((await call('GET', '/notes', { token: t })).status, 200);
  assert.equal((await call('POST', '/auth/logout', { token: t })).status, 204);
  assert.equal((await call('GET', '/notes', { token: t })).status, 401, 'token revoked by logout');
  assert.equal((await call('POST', '/auth/logout')).status, 401);
});

test('CORS: only the configured frontend origin may call the API from a browser', async () => {
  const preflight = (origin) => fetch(`${base}/api/notes`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  const ok = await preflight('http://localhost:5173');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(ok.headers.get('access-control-allow-headers'), /authorization/i);
  const evil = await preflight('https://evil.example');
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.equal((await root.json()).health, '/api/health');
});

test('MongoDB profiler: no operation in the whole suite was a collection scan or an in-memory sort', async () => {
  await mongoose.connection.db.command({ profile: 0 });
  const ops = await mongoose.connection.db.collection('system.profile')
    .find({ ns: { $not: /system\./ }, planSummary: { $exists: true } }).toArray();
  assert.ok(ops.length > 100, `profiled ${ops.length} operations`);
  // The only allowed in-memory sort: ordering the computed groups of the Scenario 1 overview
  // by member count. Those values are produced by $group during the query, so no index can
  // provide that order; it sorts one row per interest, never user documents.
  const sortsComputedGroups = (o) => Array.isArray(o.command && o.command.pipeline)
    && o.command.pipeline.some((st) => st.$group)
    && o.command.pipeline.findIndex((st) => st.$sort) > o.command.pipeline.findIndex((st) => st.$group);
  const bad = ops.filter((o) => /COLLSCAN/.test(o.planSummary) || (o.hasSortStage && !sortsComputedGroups(o)));
  assert.deepEqual(
    bad.map((o) => `${o.op} ${o.ns} ${o.planSummary} ${JSON.stringify(o.command || o.query || {}).slice(0, 200)}`),
    [],
  );
});
