'use strict';

const mongoose = require('mongoose');
const Note = require('../models/Note');
const HttpError = require('../utils/httpError');
const v = require('../utils/validate');
const { parsePagination, paginated } = require('../utils/pagination');

const OWNER_FIELDS = 'name email';

// GET /api/notes?page=&limit= — the current user's own notes, newest first.
// find({ owner }).sort({ _id: -1 }) and countDocuments({ owner }) -> { owner: 1, _id: -1 } index.
async function listMyNotes(req, res) {
  const p = parsePagination(req.query);
  const filter = { owner: req.user._id };
  const [notes, total] = await Promise.all([
    Note.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.limit).lean(),
    Note.countDocuments(filter),
  ]);
  res.json(paginated(notes, total, p));
}

// GET /api/notes/all?page=&limit=&owner= — admin: everyone's notes (optionally one owner).
// No owner filter -> sort on the default _id index + estimatedDocumentCount().
// owner filter    -> { owner: 1, _id: -1 } index.
// populate('owner') -> find({ _id: { $in: [...] } }) on users -> default _id index.
async function listAllNotes(req, res) {
  const p = parsePagination(req.query);
  const filter = {};
  if (req.query.owner !== undefined && req.query.owner !== '') {
    filter.owner = new mongoose.Types.ObjectId(v.objectId(req.query.owner, 'owner'));
  }
  const [notes, total] = await Promise.all([
    Note.find(filter).sort({ _id: -1 }).skip(p.skip).limit(p.limit).populate('owner', OWNER_FIELDS).lean(),
    filter.owner ? Note.countDocuments(filter) : Note.estimatedDocumentCount(),
  ]);
  res.json(paginated(notes, total, p));
}

// POST /api/notes
async function createNote(req, res) {
  const body = v.body(req);
  const note = await Note.create({
    owner: req.user._id,
    title: v.string(body.title, 'title', { max: 200 }),
    content: body.content === undefined ? '' : v.string(body.content, 'content', { min: 0, max: 20000, trim: false }),
  });
  res.status(201).json({ note });
}

// GET /api/notes/:id — findById -> default _id index.
// Users may only read their own notes; admins may read anyone's.
async function getNote(req, res) {
  const id = v.objectId(req.params.id);
  const note = await Note.findById(id).populate('owner', OWNER_FIELDS).lean();
  const ownerId = note && note.owner ? String(note.owner._id || note.owner) : null;
  if (!note || (ownerId !== req.user.id && req.user.role !== 'admin')) {
    throw new HttpError(404, 'Note not found'); // 404 (not 403) so note ids cannot be probed
  }
  res.json({ note });
}

// PATCH /api/notes/:id — only the owner can update (filter on _id -> default _id index).
async function updateNote(req, res) {
  const id = v.objectId(req.params.id);
  const updates = v.pickUpdates(req.body, {
    title: (x) => v.string(x, 'title', { max: 200 }),
    content: (x) => v.string(x, 'content', { min: 0, max: 20000, trim: false }),
  });
  const note = await Note.findOneAndUpdate({ _id: id, owner: req.user._id }, { $set: updates }, {
    new: true,
    runValidators: true,
  }).lean();
  if (!note) throw new HttpError(404, 'Note not found');
  res.json({ note });
}

// DELETE /api/notes/:id — only the owner can delete (filter on _id -> default _id index).
async function deleteNote(req, res) {
  const id = v.objectId(req.params.id);
  const note = await Note.findOneAndDelete({ _id: id, owner: req.user._id });
  if (!note) throw new HttpError(404, 'Note not found');
  res.status(204).end();
}

module.exports = { listMyNotes, listAllNotes, createNote, getNote, updateNote, deleteNote };
