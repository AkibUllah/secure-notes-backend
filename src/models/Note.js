'use strict';

const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    content: { type: String, default: '', maxlength: 20000 },
  },
  { timestamps: true, versionKey: false }
);

// ---------------------------------------------------------------------------
// Indexes (the ONLY index on the notes collection besides the default _id):
//
// { owner: 1, _id: -1 }
//    - GET /api/notes (user lists own notes): find({ owner }).sort({ _id: -1 })
//      -> equality on owner + sort on _id, no in-memory sort; countDocuments({ owner })
//    - GET /api/notes/all?owner=<id> (admin lists one user's notes): same query shape
//    - DELETE /api/users/:id cascade: deleteMany({ owner })
//
// Not needed (served by the default _id index):
//    - GET/PATCH/DELETE /api/notes/:id -> lookups by _id (+ owner check)
//    - GET /api/notes/all (admin lists everyone's notes) -> sort({ _id: -1 }),
//      total via estimatedDocumentCount()
// ---------------------------------------------------------------------------
noteSchema.index({ owner: 1, _id: -1 });


module.exports = mongoose.model('Note', noteSchema);
