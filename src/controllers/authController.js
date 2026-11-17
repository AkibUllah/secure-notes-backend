'use strict';

const bcrypt = require('bcryptjs');
const User = require('../models/User');
const HttpError = require('../utils/httpError');
const v = require('../utils/validate');
const { signToken } = require('../middleware/auth');

// Compared against when the email does not exist so that the response time does not
// reveal whether an account exists (mitigates user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', Number(process.env.BCRYPT_ROUNDS) || 12);

// POST /api/auth/register — public sign-up, always creates a regular "user".
async function register(req, res) {
  const body = v.body(req);
  const user = await User.create({
    name: v.string(body.name, 'name', { max: 100 }),
    email: v.email(body.email),
    password: v.password(body.password),
    interests: body.interests === undefined ? [] : v.interests(body.interests),
    role: 'user',
  });
  res.status(201).json({ token: signToken(user), user });
}

// POST /api/auth/login — findOne({ email }) uses the unique { email: 1 } index.
async function login(req, res) {
  const body = v.body(req);
  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    throw new HttpError(400, 'email and password are required');
  }
  const user = await User.findOne({ email: body.email.trim().toLowerCase() }).select('+password');
  const ok = user ? await user.comparePassword(body.password) : await bcrypt.compare(body.password, DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  res.json({ token: signToken(user), user });
}

// POST /api/auth/logout — revokes every token of the current user (all sessions) by bumping
// tokenVersion; updateOne on _id -> default _id index.
async function logout(req, res) {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  res.status(204).end();
}

module.exports = { register, login, logout };
