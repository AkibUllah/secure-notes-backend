'use strict';

const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    content: { type: String, default: '', maxlength: 20000 },
  },
  { timestamps: true, versionKey: false }
);

// ---------------------------------------------------------------------------
// Indexes (the ONLY index on the posts collection besides the default _id):
//
// { author: 1, _id: -1 }
//    - Scenario 2 aggregation (GET /api/posts/user/:userId): the $lookup
//      (foreignField: 'author') followed by $sort { _id: -1 } inside the lookup
//      pipeline is an index scan on this index (equality + sort, no in-memory sort).
//    - DELETE /api/users/:id cascade: deleteMany({ author })
//
// Not needed (served by the default _id index):
//    - GET /api/posts (public feed) -> sort({ _id: -1 }), estimatedDocumentCount()
//    - GET/PATCH/DELETE /api/posts/:id -> lookups by _id
// ---------------------------------------------------------------------------
postSchema.index({ author: 1, _id: -1 });


module.exports = mongoose.model('Post', postSchema);
