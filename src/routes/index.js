'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const h = require('../utils/asyncHandler');
const { authenticate, requireAdmin } = require('../middleware/auth');
const auth = require('../controllers/authController');
const profile = require('../controllers/profileController');
const users = require('../controllers/userController');
const notes = require('../controllers/noteController');
const posts = require('../controllers/postController');
const interests = require('../controllers/interestController');

const router = express.Router();

// Brute-force protection for credential checks (15-minute windows, separate buckets).
// IPv6 clients are grouped per /56 network, so rotating addresses inside one network does
// not reset the counter.
const limiter = (opts = {}) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
  ...opts,
});
// Login: per IP, only wrong credentials (401) count; malformed requests and successes don't.
const loginLimiter = limiter({
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
});
// Registration: per IP, every attempt counts (a 409 reveals that an e-mail is registered).
const registerLimiter = limiter();
// Password change on PATCH /profile: per USER (not per IP, so users behind one NAT don't
// block each other), only requests that change the password are considered, and only a
// wrong currentPassword counts (the controller flags it in res.locals).
const passwordLimiter = limiter({
  keyGenerator: (req) => `user:${req.user.id}`,
  skip: (req) => !req.body || req.body.password === undefined,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => !res.locals.wrongCurrentPassword,
});

router.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---- Auth (public) ----
router.post('/auth/register', registerLimiter, h(auth.register));
router.post('/auth/login', loginLimiter, h(auth.login));
router.post('/auth/logout', authenticate, h(auth.logout));

// ---- Posts: reading is public, writing requires a login ----
router.get('/posts', h(posts.listPosts));
router.get('/posts/user/:userId', h(posts.listUserPosts)); // Scenario 2 ($lookup)
router.get('/posts/:id', h(posts.getPost));
router.post('/posts', authenticate, h(posts.createPost));
router.patch('/posts/:id', authenticate, h(posts.updatePost));
router.delete('/posts/:id', authenticate, h(posts.deletePost));

// ---- Everything below requires authentication ----
// (authentication is attached per path, not with router.use(), so unknown routes return 404)
router.use(['/profile', '/interests', '/notes', '/users'], authenticate);

// Own profile
router.get('/profile', h(profile.getProfile));
router.patch('/profile', passwordLimiter, h(profile.updateProfile));

// Scenario 1: users grouped by interests
router.get('/interests', h(interests.groupByInterests));

// Notes (role "user" capabilities, inherited by admins)
router.get('/notes', h(notes.listMyNotes));
router.get('/notes/all', requireAdmin, h(notes.listAllNotes)); // admin: everyone's notes
router.post('/notes', h(notes.createNote));
router.get('/notes/:id', h(notes.getNote));
router.patch('/notes/:id', h(notes.updateNote));
router.delete('/notes/:id', h(notes.deleteNote));

// User management (admin only)
router.get('/users', requireAdmin, h(users.listUsers));
router.post('/users', requireAdmin, h(users.createUser));
router.get('/users/:id', requireAdmin, h(users.getUser));
router.patch('/users/:id', requireAdmin, h(users.updateUser));
router.delete('/users/:id', requireAdmin, h(users.deleteUser));

module.exports = router;
