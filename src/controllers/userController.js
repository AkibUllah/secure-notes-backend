'use strict';

const User = require('../models/User');
const Note = require('../models/Note');
const Post = require('../models/Post');
const HttpError = require('../utils/httpError');
const v = require('../utils/validate');
const { signToken } = require('../middleware/auth');
const { parsePagination, paginated } = require('../utils/pagination');

// All handlers in this file are admin-only (enforced with requireAdmin in routes/index.js).

// GET /api/users?page=&limit=
// sort({ _id: -1 }) walks the default _id index (newest first, _id embeds creation time);
// estimatedDocumentCount() reads collection metadata, so no extra index is required.
async function listUsers(req, res) {
  const p = parsePagination(req.query);
  const [users, total] = await Promise.all([
    User.find().select('-tokenVersion').sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    User.estimatedDocumentCount(),
  ]);
  res.json(paginated(users, total, p)); // password is select:false, tokenVersion is excluded above
}

// POST /api/users — admin creates a user with any role.
async function createUser(req, res) {
  const body = v.body(req);
  const user = await User.create({
    name: v.string(body.name, 'name', { max: 100 }),
    email: v.email(body.email),
    password: v.password(body.password),
    role: body.role === undefined ? 'user' : v.role(body.role),
    interests: body.interests === undefined ? [] : v.interests(body.interests),
  });
  res.status(201).json({ user });
}

// GET /api/users/:id — findById -> default _id index.
async function getUser(req, res) {
  const user = await User.findById(v.objectId(req.params.id));
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user });
}

// PATCH /api/users/:id
async function updateUser(req, res) {
  const id = v.objectId(req.params.id);
  const updates = v.pickUpdates(req.body, {
    name: (x) => v.string(x, 'name', { max: 100 }),
    email: v.email,
    password: v.password,
    role: v.role,
    interests: v.interests,
  });

  // Prevent an admin from locking themselves out of the admin panel.
  if (id === req.user.id && updates.role && updates.role !== 'admin') {
    throw new HttpError(400, 'You cannot remove your own admin role');
  }

  // Atomic update: hashes a new password and revokes that user's tokens in the same write;
  // a duplicate email -> 409 via the unique index.
  const user = await User.updateById(id, updates);
  if (!user) throw new HttpError(404, 'User not found');
  // An admin changing their OWN password here would revoke their own token: issue a new one.
  const selfToken = id === req.user.id && updates.password !== undefined ? { token: signToken(user) } : {};
  res.json({ user, ...selfToken });
}

// DELETE /api/users/:id — also removes the user's notes and posts
// (deleteMany({ owner }) / deleteMany({ author }) use the compound indexes' prefixes).
async function deleteUser(req, res) {
  const id = v.objectId(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot delete your own account');

  // The user is removed first so their token stops working immediately (every request
  // re-loads the user); only then are their notes and posts removed, so a request from that
  // user cannot keep adding notes during the cleanup.
  const user = await User.findByIdAndDelete(id).lean();
  if (!user) throw new HttpError(404, 'User not found');
  await Promise.all([Note.deleteMany({ owner: user._id }), Post.deleteMany({ author: user._id })]);
  res.status(204).end();
}

module.exports = { listUsers, createUser, getUser, updateUser, deleteUser };
