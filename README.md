# Secure Notes API

A note-taking REST API with JWT authentication, role-based access control (user / admin), pagination
on every list endpoint, a deliberately minimal set of MongoDB indexes, and two MongoDB aggregation
scenarios. The frontend is a separate repository: a small, plain HTML + JavaScript site (no
frameworks or templates) at https://github.com/AkibUllah/secure-notes-frontend.

**Live:** API: _added after deployment_ · Frontend: _added after deployment_

**Stack:** Node.js 18+ (tested on 18 and 22; the Docker image uses 22), Express 4, MongoDB 7 + Mongoose 8, `jsonwebtoken` (HS256), `bcryptjs`, `helmet`,
`express-rate-limit`.

---

## Requirement checklist

| Requirement (from the task) | Where |
|---|---|
| User: create / update / delete / list **own** notes | `src/controllers/noteController.js`, routes `/api/notes` |
| Admin inherits all user capabilities | Admins use the same `/api/notes` endpoints for their own notes |
| Admin: add / remove / update / list users | `src/controllers/userController.js`, routes `/api/users` (admin only) |
| Admin: view everyone's notes | `GET /api/notes/all` (+ `GET /api/notes/:id` for any note) |
| MongoDB + Mongoose | `src/models/*.js` |
| JWT authentication | `src/middleware/auth.js` |
| Secure password hashing | bcrypt (cost 12) in a `pre('save')` hook, `src/models/User.js` |
| Indexes defined with `schema.index()` | `src/models/User.js`, `Note.js`, `Post.js` (each index has a comment naming the queries it serves) |
| Pagination on **all** list operations | `?page=&limit=` on every list endpoint (`src/utils/pagination.js`) |
| Indexes for every list view | see [Indexing strategy](#indexing-strategy) |
| Indexes for every GET | see [Indexing strategy](#indexing-strategy) |
| Scenario 1: group users by interests, exactly one `collection.aggregate()` call | `src/controllers/interestController.js` → `buildInterestPipeline`, `GET /api/interests` |
| Scenario 2: posts of a user, one pipeline with `$lookup` | `src/controllers/postController.js` → `buildUserPostsPipeline`, `GET /api/posts/user/:userId` |
| Aggregations supported by indexes | `{ interests: 1, name: 1, _id: 1 }` for Scenario 1 and `{ author: 1, _id: -1 }` for Scenario 2, proven with `explain` (`npm run explain` and the tests). See [Indexing strategy](#indexing-strategy) for what the index does and does not speed up in the Scenario 1 overview |
| No unnecessary indexes | 4 custom indexes in total (2 on users, 1 on notes, 1 on posts); `syncIndexes()` drops any index not declared in a schema |
| Functional frontend | separate repo [secure-notes-frontend](https://github.com/AkibUllah/secure-notes-frontend) |

---

## Quick start

### Option A: Docker (API and MongoDB)

```bash
export JWT_SECRET=$(openssl rand -hex 32)             # required; compose refuses to start without it
docker compose up --build -d
docker compose exec api node scripts/seed.js          # create the admin account
# or: docker compose exec api node scripts/seed.js --demo   (WIPES the DB, adds demo data)
curl http://localhost:3000/api/health
```

### Option B: Local Node with your own MongoDB

```bash
cp .env.example .env        # set MONGODB_URI and a random JWT_SECRET (32+ characters; the placeholder is refused)
npm install
npm run seed                # creates/resets the admin from ADMIN_EMAIL / ADMIN_PASSWORD
npm run seed:demo           # optional: WIPES the DB and adds an admin, 5 users, notes and posts
npm start                   # API on http://localhost:3000
```

To use the frontend locally, clone the frontend repo and serve it on port 5173 (the default allowed
`CORS_ORIGIN`):

```bash
git clone https://github.com/AkibUllah/secure-notes-frontend && cd secure-notes-frontend
python3 -m http.server 5173     # or: npx serve -l 5173   → open http://localhost:5173
```

Default admin: `admin@example.com` / `Admin@12345`. Demo users (`alice@`, `bob@`, `carol@`, `dave@`,
`eve@example.com`) all use the password `Password123`.

Public registration always creates a `user`. Admins are created by the seed script or by another admin.

### Tests and index proof

```bash
TEST_MONGODB_URI=mongodb://127.0.0.1:27017/secure_notes_test npm test   # WARNING: drops that database
npm run seed:demo && npm run explain                                     # prints the winning plan of every query
```

`npm test` runs 26 end-to-end tests against a real MongoDB, in two files. `test/ratelimit.test.js` runs
in its own process with a low limit. The tests check:

- the exact set of indexes;
- auth, JWT tampering, token revocation (including two concurrent password changes) and query-injection attempts;
- note ownership isolation;
- admin capabilities, including the self-demotion/deletion guard;
- pagination maths and limits;
- both aggregation scenarios, including that Scenario 1 makes one `collection.aggregate()` call and nothing else, and stays bounded for a very popular interest;
- `explain` plans of the exact production pipelines. Scenario 1's one-group view and Scenario 2 fetch
  only the requested page, and their totals are counted from the index alone;
- the cascade delete when a user is removed, and server-side logout;
- the rate limits: only wrong credentials count for login, registrations have their own limit, and
  password changes are limited per user and count only a wrong `currentPassword`;
- **the MongoDB profiler.** It records every operation the API runs during the suite, and the last test
  fails if any of them was a collection scan or an in-memory sort. The single allowed exception is
  ordering the computed groups of the Scenario 1 overview by count.

---

## API reference

All request and response bodies are JSON. Authenticated endpoints need `Authorization: Bearer <token>`.
Errors look like `{ "error": { "message": "...", "details": [...] } }`.

Every list endpoint takes `?page=` (default 1, max 1,000,000) and `?limit=` (default 10, max 100) and returns:

```json
{ "data": [ ... ], "pagination": { "page": 1, "limit": 10, "total": 42, "totalPages": 5 } }
```

### Auth (rate-limited, see [Security](#security))
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | `name, email, password (8–72 characters; bcrypt reads at most 72 bytes), interests?[]` | Always role `user`. Returns `{ token, user }` |
| POST | `/api/auth/login` | `email, password` | Returns `{ token, user }` |
| POST | `/api/auth/logout` | (logged in) | Revokes all of the user's tokens on the server (`tokenVersion` + 1). Returns 204 |

### Profile (any logged-in user)
| Method | Path | Body |
|---|---|---|
| GET | `/api/profile` | |
| PATCH | `/api/profile` | `name?, interests?[], password? + currentPassword` (cannot change role or email). A password change revokes all existing tokens and the response includes a new `token` |

### Notes
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/notes` | user/admin | Own notes, newest first, paginated |
| POST | `/api/notes` | user/admin | `title, content?` |
| GET | `/api/notes/:id` | owner or admin | 404 for other users' notes, so note ids can't be probed |
| PATCH | `/api/notes/:id` | owner | `title?, content?` |
| DELETE | `/api/notes/:id` | owner | |
| GET | `/api/notes/all` | admin | Everyone's notes, paginated, optional `?owner=<userId>`, owner name and email populated |

### Users (admin only)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/users` | Paginated, newest first |
| POST | `/api/users` | `name, email, password, role?, interests?[]` |
| GET | `/api/users/:id` | |
| PATCH | `/api/users/:id` | `name?, email?, password?, role?, interests?[]` (an admin cannot demote themselves; a password change revokes that user's tokens) |
| DELETE | `/api/users/:id` | Also deletes that user's notes and posts (an admin cannot delete themselves) |

### Posts (reading is public)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/posts` | anyone | Public feed, newest first, paginated |
| GET | `/api/posts/user/:userId` | anyone | **Scenario 2**: one aggregation pipeline using `$lookup`, paginated, returns `{ author, data, pagination }` (404 if the user does not exist) |
| GET | `/api/posts/:id` | anyone | |
| POST | `/api/posts` | logged in | `title, content?` |
| PATCH | `/api/posts/:id` | author | |
| DELETE | `/api/posts/:id` | author or admin | |

### Interests
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/interests` | logged in | **Scenario 1** overview: `data: [{ interest, count, users }]`, groups paginated, sorted by count. `users` is a preview of up to 5 members |
| GET | `/api/interests?interest=chess` | logged in | **Scenario 1** single group: `{ interest, data: [members], pagination }`, all members of that interest, paginated and sorted by name |

Only admins see member emails.

---

## Indexing strategy

There are only **four custom indexes** in the whole database (besides the default `_id` index on each collection):

| Collection | Index | Queries it serves |
|---|---|---|
| users | `{ email: 1 }` **unique** | Login `findOne({ email })`, and enforcing unique emails on register, admin create and update |
| users | `{ interests: 1, name: 1, _id: 1 }` (multikey) | **Scenario 1**. For `?interest=chess`, the `$match` + `$sort { name, _id }` is one index scan returning members already in name order, with no in-memory sort. The overview's `{ interests: { $gt: '' } }` uses the index prefix |
| notes | `{ owner: 1, _id: -1 }` | A user listing their notes: `find({ owner }).sort({ _id: -1 })` with no in-memory sort, plus `countDocuments({ owner })`, which is answered from the index alone (COUNT_SCAN). Also serves the admin's `?owner=` filter and the cascade `deleteMany({ owner })` |
| posts | `{ author: 1, _id: -1 }` | **Scenario 2**: the `$lookup` on `author` followed by `$sort { _id: -1 }`, `$skip`, `$limit`. There is no in-memory sort and only the requested page is fetched. The total is counted from the index alone. Also serves the cascade `deleteMany({ author })` |

Every other read is served by the built-in `_id` index, so no other index is needed:

- `GET /api/users/:id`, `/api/notes/:id`, `/api/posts/:id`, `/api/profile`, the JWT user lookup on every
  request, and Scenario 2's `$match { _id }` all look documents up by `_id` (IDHACK).
- The admin user list, the admin list of everyone's notes, and the public post feed all sort by
  `{ _id: -1 }`. An ObjectId starts with its creation timestamp, so this gives "newest first" without
  an extra `createdAt` index. Their totals come from `estimatedDocumentCount()`, which reads collection
  metadata and needs no index.
- Updating and deleting a note or post filters on `{ _id, owner }` or `{ _id, author }`. The `_id` index
  narrows this to one document.

Design decisions:

- **Compound `{ owner: 1, _id: -1 }` instead of `{ owner: 1 }`.** A single-field index would match the
  documents but still need an in-memory SORT stage before skip/limit. The compound index returns the
  documents already in order.
- **No `createdAt` index.** Sorting by `_id` gives the same order for free.
- **No separate `{ owner: 1 }` / `{ author: 1 }` index for cascade deletes.** These are prefixes of the
  compound indexes, so they would be redundant.
- **`email` is unique through `schema.index({ email: 1 }, { unique: true })` only.** It is not also
  declared with `unique: true` on the field, which would create the same index a second time.
- **Index drift.** `mongoose.set('autoIndex', false)` is set, and on startup `syncIndexes()` makes the database
  hold exactly the indexes declared with `schema.index()`. It creates missing ones and drops any
  undeclared ones. Set `SYNC_INDEXES=false` to turn this off, for example in a production deployment where
  indexes are managed by migrations. With it off, the indexes must already exist, including the unique
  email index.
- **Why `name` and `_id` are in the interests index.** With `{ interests: 1 }` alone, the one-group view
  would find the members by index but then sort them in memory. Adding `name, _id` lets the same single
  index return them in order. It is still one index, not two.
- **What the interests index buys for the overview.** `{ interests: { $gt: '' } }` only skips users who
  have no interests. When nearly every user has interests the overview reads almost every user anyway,
  because grouping all users needs all of them.

`npm run explain` output on the demo data (the Scenario 1 and 2 entries explain the exact pipelines the API runs):

```
login: users.findOne({email})
    LIMIT <- PROJECTION_SIMPLE <- FETCH <- IXSCAN(email_1)
auth/profile/admin get user: users.findById
    PROJECTION_SIMPLE <- IDHACK
admin list users: users.find().sort({_id:-1})
    LIMIT <- PROJECTION_SIMPLE <- FETCH <- IXSCAN(_id_)
list my notes: notes.find({owner}).sort({_id:-1})
    LIMIT <- FETCH <- IXSCAN(owner_1__id_-1)
count my notes: notes.countDocuments({owner})
    COUNT_SCAN(owner_1__id_-1)
admin all notes: notes.find().sort({_id:-1})
    LIMIT <- FETCH <- IXSCAN(_id_)
admin notes by owner
    LIMIT <- FETCH <- IXSCAN(owner_1__id_-1)
get note: notes.findById
    IDHACK
update/delete own note: {_id, owner}
    FETCH <- IXSCAN(_id_)
public posts feed: posts.find().sort({_id:-1})
    LIMIT <- FETCH <- IXSCAN(_id_)
get post: posts.findById
    IDHACK
cascade delete posts: posts.deleteMany({author})
    FETCH <- IXSCAN(author_1__id_-1)
Scenario 1 overview: GET /api/interests
    PROJECTION_SIMPLE <- FETCH <- IXSCAN(interests_1_name_1__id_1)
Scenario 1 one group: GET /api/interests?interest=chess
    LIMIT <- PROJECTION_SIMPLE <- FETCH <- IXSCAN(interests_1_name_1__id_1)
Scenario 2: GET /api/posts/user/:id (limit 1)
    PROJECTION_SIMPLE <- IDHACK | $lookup(posts): indexesUsed=["author_1__id_-1"] collectionScans=0 docsExamined=1 | $lookup(postCount): indexesUsed=["author_1__id_-1"] collectionScans=0 docsExamined=0
```

---

## Aggregation pipelines

### Scenario 1: users grouped by interest

Each request is exactly one `User.collection.aggregate(pipeline).toArray()` call, with no `find`, `count`
or `distinct`. Grouping, sorting, the total count and the page all come from the same pipeline. The
pipeline is built by `buildInterestPipeline()`, which the tests and `npm run explain` also use.

Overview (`GET /api/interests`):

```js
[
  { $match: { interests: { $gt: '' } } },                 // IXSCAN (index prefix): users with >= 1 interest
  { $project: { name: 1, email: 1, interests: 1 } },
  { $unwind: '$interests' },
  { $group: {
      _id: '$interests',
      count: { $sum: 1 },
      users: { $firstN: { input: { _id: '$_id', name: '$name' /* + email for admins */ }, n: 5 } },
  } },
  { $sort: { count: -1, _id: 1 } },
  { $facet: {
      metadata: [{ $count: 'total' }],
      data: [{ $skip: skip }, { $limit: limit }, { $project: { _id: 0, interest: '$_id', count: 1, users: 1 } }],
  } },
  { $project: { data: 1, total: { $ifNull: [{ $arrayElemAt: ['$metadata.total', 0] }, 0] } } },
]
```

Each group embeds a bounded preview of its members (`$firstN`, in no particular order) rather than all of them. Embedding every
member would make the result for a popular interest exceed MongoDB's 16 MB document limit, and the
member list would be an unpaginated list.

One group (`GET /api/interests?interest=chess`) returns all of that group's members, paginated:

```js
[
  { $match: { interests: 'chess' } },          // one IXSCAN on interests_1_name_1__id_1, which
  { $sort: { name: 1, _id: 1 } },              // already returns this order, and stops after
  { $skip: skip }, { $limit: limit },          // skip + limit keys: only one page is fetched
  { $project: member },
  { $unionWith: { coll: 'users', pipeline: [   // + one final { total } document,
      { $match: { interests: 'chess' } }, { $count: 'total' } ] } },   // counted from the index alone
]
```

`$facet` is deliberately not used for this one. It would stop MongoDB from applying the limit to the
index scan, so every member of the group would be fetched on every page. On 2,000 members, page 3
reads 30 index keys and fetches 10 documents. The tests assert this with `executionStats`.

The overview still needs one in-memory step: it sorts the groups by `count`. Those counts are computed
by `$group` during the query, so no index can provide that order. That sort handles one row per
interest, never user documents.

Interests are trimmed, lower-cased and de-duplicated when they are written, so a user appears at most
once per group. Like every authenticated endpoint, the request also loads the caller by `_id` for
authentication; that lookup is not part of the view.

### Scenario 2: all posts of a user, using `$lookup`

Built by `buildUserPostsPipeline()`:

```js
User.aggregate([
  { $match: { _id: userId } },                                    // IDHACK on users
  { $lookup: {                                                    // the requested page of posts
      from: 'posts', localField: '_id', foreignField: 'author',   // IXSCAN author_1__id_-1, which
      pipeline: [{ $sort: { _id: -1 } }, { $skip }, { $limit }, { $project }],  // also gives the order
      as: 'posts',
  } },
  { $lookup: {                                                    // the total
      from: 'posts', localField: '_id', foreignField: 'author',
      pipeline: [{ $count: 'total' }],                            // counted from the index alone
      as: 'postCount',
  } },
  { $project: { _id: 0, author: { _id: '$_id', name: '$name' }, total: ..., data: '$posts' } },
])
```

Why two `$lookup` stages: a single `$lookup` whose sub-pipeline uses `$facet` to return both the page
and the count would also work. However, `$facet` stops MongoDB from applying the limit at the index scan,
so every one of the user's posts would be fetched on every page. Splitting the page and the count into
two `$lookup` stages keeps the whole thing in one pipeline and makes both stages cheap.

One pipeline returns the author, one page of their posts (newest first) and the total. The skip and
limit sit directly after the sort, so MongoDB applies them to the index scan and fetches only the
requested page. The tests assert this with `executionStats`. If the user does not exist the API returns
404, and a user with no posts gets `total: 0`.

---

## Security

- **Passwords** are hashed with bcrypt at cost 12. The password field has `select: false`, is removed
  in `toJSON`, and is never returned in a response.
- **Login** returns the same error whether the email is unknown or the password is wrong. For unknown
  emails it still runs a bcrypt compare against a dummy hash, so login responses don't reveal which
  accounts exist. Registration does necessarily reveal it: an email that is already taken returns 409.
  That is why the registration endpoint is rate-limited.
- **JWT** tokens use HS256 only, so `alg: none` and algorithm-confusion tokens are rejected. They expire
  after `JWT_EXPIRES_IN` (default 1h). The app refuses to start if the secret is shorter than 32 characters
  or is the public placeholder from `.env.example`.
- **The token** carries only the user id and a `tokenVersion`. Each request reloads the user by `_id`,
  so deleting a user or changing their role takes effect immediately. A password change stores the new
  hash and increments `tokenVersion` in one atomic update, which revokes every earlier token, even when
  two password changes happen at the same time. The person who made the change gets a new token back.
- **Access control:**
  - `requireAdmin` guards all user-management routes.
  - Ownership checks are built into the queries themselves (`{ _id, owner }`).
  - Other users' notes return 404 rather than 403.
  - Users cannot change their own role, and an admin cannot demote or delete themselves. Ids are
    normalised to lower case, so the same id in upper case can't be used to get around this.
- **Input validation:** every field is type-checked as a string or an array of strings. This blocks
  operator-injection payloads such as `{ "email": { "$gt": "" } }`. Ids are checked to be 24-character
  hex, lengths are limited, request bodies are limited to 100 kB, and fields that clients may not set
  (for example `owner` or `role` on register) are ignored.
- **Rate limiting:** each limit allows 20 per 15 minutes. IPv6 clients are grouped per /56 network, so
  rotating addresses doesn't reset the count.
  - **Login:** per IP. Only wrong credentials (401) count; malformed requests and successful logins
    don't.
  - **Registration:** per IP. Every attempt counts.
  - **Password change on `PATCH /api/profile`:** per user. Only a wrong `currentPassword` counts, and
    other profile edits are never limited.

  Set `TRUST_PROXY=1` only when running behind a reverse proxy; otherwise clients could fake their IP
  to get around the per-IP limits.
- **Logout** (`POST /api/auth/logout`) revokes the token on the server, so a copied token stops working.
  This ends all of that user's sessions.
- **Headers and CORS:** `helmet` sets security headers. Browsers may only call the API from the
  origins listed in `CORS_ORIGIN`. Authentication uses a Bearer header, not cookies, so there is no
  CSRF exposure.
- **Frontend:** the frontend sets its own Content-Security-Policy: scripts only from its own origin,
  no inline scripts and no `eval`, and API calls only to the backend. It renders everything with
  `textContent`, so user content cannot inject HTML or scripts.

## Known trade-offs

- **Tests run in order:** the API tests share users and tokens, so they must run as one file rather than
  one test at a time.
- **Paging:** pagination uses skip/limit, which is simple and fine at this scale. On very deep pages,
  keyset pagination on `_id` would be faster.
- **Deleting a user:** this runs as separate operations rather than a transaction, because transactions
  need a replica set. The user is deleted first, so their token stops working at once, and then their
  notes and posts are deleted. A request from that user that had already passed authentication just
  before the delete could still leave a stray note.
- **Last admin:** an admin cannot demote or delete themselves. Two admins demoting each other at the same
  moment could still leave no admin. Guarding that atomically needs a transaction, or an admin count that
  would need an extra index on `role`. Running `npm run seed` restores an admin.
- **The Scenario 1 overview reads every user who has an interest.** Grouping all users needs all of
  them. `{ interests: { $gt: '' } }` lets the index skip only users with no interests. When nearly every
  user has interests, this costs slightly more than a plain collection scan, because there is one index
  key per interest. The index really earns its place in the one-group view.
- **The `?interest=` one-group view and the wider index.** The spec only asks for "users grouped by
  interests". The one-group view exists because embedding every member in every group would break the
  16 MB document limit and leave the member lists unpaginated. The `name, _id` index keys exist only to
  serve that view's sort. If a reviewer prefers the strict minimum, the index can be reduced to
  `{ interests: 1 }`, at the cost of an in-memory sort in that view.
- **"Exactly one `aggregate()` call" for Scenario 1.** The view itself is one aggregate call. As with
  every logged-in request, authentication also loads the caller by `_id` beforehand.
- **Public post reading:** reading posts is public by design ("visible to everyone"). As a result,
  `GET /api/posts/user/:id` shows the author's name and returns 404 for a user id that doesn't exist.

## Deployment

The live API runs on Render (free tier) with MongoDB Atlas (free tier); the frontend is a static site.

| Render setting | Value |
|---|---|
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Environment | `MONGODB_URI` (Atlas), `JWT_SECRET` (32+ random characters), `CORS_ORIGIN` (frontend URL), `TRUST_PROXY=1`, `NODE_VERSION=22` |

After the first deploy, create the admin once by running `npm run seed` locally with `MONGODB_URI`
pointing at Atlas. On the free tier the API sleeps when idle, so the first request can take about a minute.

## Project layout

```
src/
  app.js, server.js, config.js, db.js
  models/        User.js, Note.js, Post.js         (schemas and schema.index() definitions)
  controllers/   auth, profile, user (admin), note, post (Scenario 2), interest (Scenario 1)
  middleware/    auth.js (JWT and roles), errorHandler.js
  routes/        index.js
  utils/         pagination.js, validate.js, httpError.js, asyncHandler.js
scripts/         seed.js, explain.js
test/            api.test.js                       (node:test, end-to-end against MongoDB)
```
