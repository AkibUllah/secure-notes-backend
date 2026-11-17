'use strict';

const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const HttpError = require('../utils/httpError');
const v = require('../utils/validate');
const { parsePagination, paginated } = require('../utils/pagination');

// Posts are visible to everyone (no authentication needed to read them).

// GET /api/posts?page=&limit= — public feed, newest first.
// sort({ _id: -1 }) -> default _id index; estimatedDocumentCount() -> metadata.
async function listPosts(req, res) {
  const p = parsePagination(req.query);
  const [posts, total] = await Promise.all([
    Post.find().sort({ _id: -1 }).skip(p.skip).limit(p.limit).populate('author', 'name').lean(),
    Post.estimatedDocumentCount(),
  ]);
  res.json(paginated(posts, total, p));
}

// SCENARIO 2 — all posts belonging to a particular user, in ONE aggregation pipeline that
// joins users -> posts with $lookup.
//   - $match { _id }                       -> users default _id index (IDHACK)
//   - $lookup 'posts' (author = user._id), $sort { _id: -1 }, $skip, $limit
//                                          -> posts { author: 1, _id: -1 } index: equality +
//                                             sort with no in-memory sort, and the limit is
//                                             applied to the index scan, so only the requested
//                                             page of posts is fetched.
//   - $lookup 'posts' with $count          -> the total, answered from the same index.
function buildUserPostsPipeline(userId, { skip, limit }) {
  return [
    { $match: { _id: userId } },
    {
      $lookup: {
        from: Post.collection.name,
        localField: '_id',
        foreignField: 'author',
        pipeline: [
          { $sort: { _id: -1 } },
          { $skip: skip },
          { $limit: limit },
          { $project: { title: 1, content: 1, author: 1, createdAt: 1, updatedAt: 1 } },
        ],
        as: 'posts',
      },
    },
    {
      $lookup: {
        from: Post.collection.name,
        localField: '_id',
        foreignField: 'author',
        pipeline: [{ $count: 'total' }],
        as: 'postCount',
      },
    },
    {
      $project: {
        _id: 0,
        author: { _id: '$_id', name: '$name' },
        total: { $ifNull: [{ $arrayElemAt: ['$postCount.total', 0] }, 0] },
        data: '$posts',
      },
    },
  ];
}

// GET /api/posts/user/:userId?page=&limit=
async function listUserPosts(req, res) {
  const userId = new mongoose.Types.ObjectId(v.objectId(req.params.userId, 'userId'));
  const p = parsePagination(req.query);

  const [result] = await User.aggregate(buildUserPostsPipeline(userId, p));

  if (!result) throw new HttpError(404, 'User not found');
  res.json({ author: result.author, ...paginated(result.data, result.total, p) });
}

// GET /api/posts/:id — findById -> default _id index.
async function getPost(req, res) {
  const post = await Post.findById(v.objectId(req.params.id)).populate('author', 'name').lean();
  if (!post) throw new HttpError(404, 'Post not found');
  res.json({ post });
}

// POST /api/posts (authenticated)
async function createPost(req, res) {
  const body = v.body(req);
  const post = await Post.create({
    author: req.user._id,
    title: v.string(body.title, 'title', { max: 200 }),
    content: body.content === undefined ? '' : v.string(body.content, 'content', { min: 0, max: 20000, trim: false }),
  });
  res.status(201).json({ post });
}

// PATCH /api/posts/:id — only the author can edit (filter on _id -> default _id index).
async function updatePost(req, res) {
  const id = v.objectId(req.params.id);
  const updates = v.pickUpdates(req.body, {
    title: (x) => v.string(x, 'title', { max: 200 }),
    content: (x) => v.string(x, 'content', { min: 0, max: 20000, trim: false }),
  });
  const post = await Post.findOneAndUpdate({ _id: id, author: req.user._id }, { $set: updates }, {
    new: true,
    runValidators: true,
  }).lean();
  if (!post) throw new HttpError(404, 'Post not found');
  res.json({ post });
}

// DELETE /api/posts/:id — the author, or an admin (moderation), can delete.
async function deletePost(req, res) {
  const id = v.objectId(req.params.id);
  const filter = req.user.role === 'admin' ? { _id: id } : { _id: id, author: req.user._id };
  const post = await Post.findOneAndDelete(filter);
  if (!post) throw new HttpError(404, 'Post not found');
  res.status(204).end();
}

module.exports = { listPosts, listUserPosts, getPost, createPost, updatePost, deletePost, buildUserPostsPipeline };
