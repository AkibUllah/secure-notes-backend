'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const HttpError = require('../utils/httpError');
const asyncHandler = require('../utils/asyncHandler');

// The token holds the user id and the user's tokenVersion; the role is always read from
// the database, so it is not stored in the token.
function signToken(user) {
  return jwt.sign({ sub: String(user._id), ver: user.tokenVersion || 0 }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
  });
}

// Verifies the Bearer JWT and loads the current user (findById -> default _id index).
// Loading the user on every request means deleted users, role changes and password changes
// take effect immediately instead of waiting for the token to expire.
const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) throw new HttpError(401, 'Authentication required');

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }

  const user = typeof payload.sub === 'string' && /^[a-f\d]{24}$/i.test(payload.sub)
    ? await User.findById(payload.sub).lean()
    : null;
  // A token minted before the last password change carries an old tokenVersion.
  if (!user || (payload.ver || 0) !== (user.tokenVersion || 0)) {
    throw new HttpError(401, 'Invalid or expired token');
  }

  req.user = { id: String(user._id), _id: user._id, name: user.name, email: user.email, role: user.role };
  next();
});

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Forbidden'));
    next();
  };
}

const requireAdmin = requireRole('admin');

module.exports = { signToken, authenticate, requireRole, requireAdmin };
