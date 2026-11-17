'use strict';

const User = require('../models/User');
const HttpError = require('../utils/httpError');
const v = require('../utils/validate');
const { signToken } = require('../middleware/auth');

// GET /api/profile — findById -> default _id index.
async function getProfile(req, res) {
  const user = await User.findById(req.user._id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user });
}

// PATCH /api/profile — a user can change their own name, interests and password.
// Email and role are only changeable by an admin.
async function updateProfile(req, res) {
  const updates = v.pickUpdates(req.body, {
    name: (x) => v.string(x, 'name', { max: 100 }),
    interests: v.interests,
    password: v.password,
  });

  const user = await User.findById(req.user._id).select('+password');
  if (!user) throw new HttpError(404, 'User not found');

  if (updates.password !== undefined) {
    const current = req.body.currentPassword;
    if (typeof current !== 'string' || !(await user.comparePassword(current))) {
      res.locals.wrongCurrentPassword = true; // counted by the password rate limiter
      throw new HttpError(400, 'currentPassword is incorrect');
    }
  }

  const updated = await User.updateById(user._id, updates);
  if (!updated) throw new HttpError(404, 'User not found');
  // A password change revokes all existing tokens, so hand this session a new one.
  res.json({ user: updated, ...(updates.password !== undefined ? { token: signToken(updated) } : {}) });
}

module.exports = { getProfile, updateProfile };
