'use strict';

// Prints the winning query plan for every query/aggregation the API runs, to show that
// each one is served by an index (IXSCAN / IDHACK / EXPRESS_IXSCAN, never COLLSCAN),
// and lists every index that exists in the database.
// Run against a database that has data, e.g. after `npm run seed:demo`.

require('dotenv').config();
const db = require('../src/db');
const User = require('../src/models/User');
const Note = require('../src/models/Note');
const Post = require('../src/models/Post');
const { buildInterestPipeline } = require('../src/controllers/interestController');
const { buildUserPostsPipeline } = require('../src/controllers/postController');

function stages(plan, out = []) {
  if (!plan || typeof plan !== 'object') return out;
  if (plan.stage) out.push(plan.indexName ? `${plan.stage}(${plan.indexName})` : plan.stage);
  for (const key of ['inputStage', 'queryPlan', 'winningPlan']) if (plan[key]) stages(plan[key], out);
  if (Array.isArray(plan.inputStages)) plan.inputStages.forEach((s) => stages(s, out));
  return out;
}

function planOf(explain) {
  const qp = explain.queryPlanner || (explain.stages && explain.stages[0].$cursor && explain.stages[0].$cursor.queryPlanner);
  return qp ? stages(qp.winningPlan).join(' <- ') : JSON.stringify(explain).slice(0, 200);
}

function lookupInfo(explain) {
  return (explain.stages || [])
    .filter((x) => x.$lookup)
    .map((s) => ` | $lookup(${s.$lookup.as}): indexesUsed=${JSON.stringify(s.indexesUsed)} collectionScans=${s.collectionScans} docsExamined=${s.totalDocsExamined}`)
    .join('');
}

(async () => {
  await db.connect();
  const user = await User.findOne({ role: { $ne: 'admin' } }).lean() || (await User.findOne().lean());
  const note = await Note.findOne().lean();
  const post = await Post.findOne().lean();
  if (!user || !note || !post) throw new Error('No data: run `npm run seed:demo` first');

  const checks = [
    ['login: users.findOne({email})', User.find({ email: user.email }).limit(1).explain()],
    ['auth/profile/admin get user: users.findById', User.find({ _id: user._id }).explain()],
    ['admin list users: users.find().sort({_id:-1})', User.find().sort({ _id: -1 }).skip(0).limit(10).explain()],
    ['list my notes: notes.find({owner}).sort({_id:-1})', Note.find({ owner: user._id }).sort({ _id: -1 }).limit(10).explain()],
    // countDocuments(filter) runs this aggregation internally
    ['count my notes: notes.countDocuments({owner})', Note.collection.aggregate([{ $match: { owner: user._id } }, { $group: { _id: 1, n: { $sum: 1 } } }]).explain()],
    ['admin all notes: notes.find().sort({_id:-1})', Note.find().sort({ _id: -1 }).limit(10).explain()],
    ['admin notes by owner', Note.find({ owner: user._id }).sort({ _id: -1 }).limit(10).explain()],
    ['get note: notes.findById', Note.find({ _id: note._id }).explain()],
    ['update/delete own note: {_id, owner}', Note.find({ _id: note._id, owner: note.owner }).explain()],
    ['public posts feed: posts.find().sort({_id:-1})', Post.find().sort({ _id: -1 }).limit(10).explain()],
    ['get post: posts.findById', Post.find({ _id: post._id }).explain()],
    ['cascade delete posts: posts.deleteMany({author})', Post.find({ author: user._id }).explain()],
    // The exact pipelines the API runs (built by the same functions the controllers use):
    ['Scenario 1 overview: GET /api/interests', User.collection.aggregate(buildInterestPipeline({ interest: null, skip: 0, limit: 10, isAdmin: true })).explain()],
    ['Scenario 1 one group: GET /api/interests?interest=chess', User.collection.aggregate(buildInterestPipeline({ interest: 'chess', skip: 0, limit: 10, isAdmin: true })).explain()],
    ['Scenario 2: GET /api/posts/user/:id (limit 1)', User.aggregate(buildUserPostsPipeline(post.author, { skip: 0, limit: 1 })).explain('executionStats')],
  ];

  for (const [label, promise] of checks) {
    const explain = await promise;
    console.log(`${label}\n    ${planOf(explain)}${lookupInfo(explain)}`);
  }

  console.log('\nIndexes in the database:');
  for (const model of [User, Note, Post]) {
    const idx = await model.collection.indexes();
    console.log(`  ${model.collection.name}: ${idx.map((i) => JSON.stringify(i.key) + (i.unique ? ' unique' : '')).join(', ')}`);
  }
  await db.disconnect();
})().catch(async (err) => {
  console.error(err);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
