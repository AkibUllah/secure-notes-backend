'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLES = ['user', 'admin'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    // Never returned by queries unless explicitly requested with .select('+password').
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'user' },
    interests: { type: [String], default: [] },
    // Embedded in every JWT; bumping it revokes all previously issued tokens (see middleware/auth.js).
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

// ---------------------------------------------------------------------------
// Indexes (the ONLY indexes on the users collection besides the default _id):
//
// 1. { email: 1 } unique
//    - POST /api/auth/login               -> findOne({ email })
//    - register / admin create / update   -> enforces unique emails (duplicate check)
//
// 2. { interests: 1, name: 1, _id: 1 } (multikey)
//    - Scenario 1, one group (GET /api/interests?interest=chess): $match { interests } +
//      $sort { name, _id } is a single index scan in name order (no in-memory sort).
//    - Scenario 1, overview (GET /api/interests): the leading $match
//      { interests: { $gt: '' } } uses the same index's prefix.
//
// Not needed (served by the default _id index):
//    - GET /api/users/:id, GET /api/profile, JWT auth lookup -> findById
//    - GET /api/users (admin list) -> sorted by _id (newest first), total via
//      estimatedDocumentCount() (collection metadata, no scan)
//    - Scenario 2 aggregation -> $match { _id }
// ---------------------------------------------------------------------------
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ interests: 1, name: 1, _id: 1 });

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;
  this.password = await bcrypt.hash(this.password, rounds);
  // Changing the password via save() (used by the seed script) also revokes old tokens.
  // The API uses User.updateById(), which does this atomically.
  if (!this.isNew) this.tokenVersion = (this.tokenVersion || 0) + 1;
});

// Applies a validated update atomically. A password change hashes the new password and
// increments tokenVersion in the SAME write, so with concurrent password changes the last
// writer holds both the current password and the highest tokenVersion; every token issued
// for an earlier password is revoked. Returns the updated user, or null if it doesn't exist.
userSchema.statics.updateById = async function updateById(id, updates) {
  const set = { ...updates };
  const update = { $set: set };
  if (updates.password !== undefined) {
    set.password = await bcrypt.hash(updates.password, Number(process.env.BCRYPT_ROUNDS) || 12);
    update.$inc = { tokenVersion: 1 };
  }
  return this.findOneAndUpdate({ _id: id }, update, { new: true, runValidators: true });
};

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.password;
    delete ret.tokenVersion;
    return ret;
  },
});

const User = mongoose.model('User', userSchema);

module.exports = User;
module.exports.ROLES = ROLES;
