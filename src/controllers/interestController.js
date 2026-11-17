'use strict';

const User = require('../models/User');
const v = require('../utils/validate');
const { parsePagination } = require('../utils/pagination');

// How many members are embedded in each group of the overview. Embedding every member
// would make one popular interest exceed MongoDB's 16 MB document limit, so the overview
// carries `count` + a bounded preview, and ?interest=<name> pages through ALL members.
const MEMBER_PREVIEW = 5;

// SCENARIO 1 — users grouped by interest. Both modes are ONE collection.aggregate() call.
//
// Index support: both pipelines start with a $match on `interests`, served by the
// multikey { interests: 1, name: 1, _id: 1 } index:
//   - one group { interests: '<name>' } + $sort { name, _id } -> one index scan that returns
//     the group's members already in name order (no in-memory sort).
//   - overview  { interests: { $gt: '' } } -> index bounds ("", {}) on the index prefix: only
//     users that have at least one interest are read. Grouping ALL users has to read every
//     user that has an interest, so when nearly every user has one this costs about the same
//     as a collection scan (slightly more: one index key per interest). Its benefit is only
//     that users without interests are skipped.
function buildInterestPipeline({ interest, skip, limit, isAdmin }) {
  // Admins see e-mails, regular users only see public profile data.
  const member = { _id: '$_id', name: '$name' };
  if (isAdmin) member.email = '$email';

  const page = (projection) => [
    {
      $facet: {
        metadata: [{ $count: 'total' }],
        data: [{ $skip: skip }, { $limit: limit }, { $project: projection }],
      },
    },
    { $project: { data: 1, total: { $ifNull: [{ $arrayElemAt: ['$metadata.total', 0] }, 0] } } },
  ];

  if (interest) {
    // One group: its members, paginated, sorted by name. $match + $sort + $skip + $limit run
    // as ONE index scan that stops after the requested page (no $facet here: it would stop
    // MongoDB from applying the limit to the scan). The total is appended by $unionWith as a
    // final { total } document, counted from the same index.
    return [
      { $match: { interests: interest } },
      { $sort: { name: 1, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: member },
      { $unionWith: { coll: User.collection.name, pipeline: [{ $match: { interests: interest } }, { $count: 'total' }] } },
    ];
  }

  // Overview: every interest with its member count and a bounded member preview, paginated.
  return [
    { $match: { interests: { $gt: '' } } },
    { $project: { name: 1, email: 1, interests: 1 } },
    { $unwind: '$interests' },
    {
      $group: {
        _id: '$interests',
        count: { $sum: 1 },
        users: { $firstN: { input: member, n: MEMBER_PREVIEW } },
      },
    },
    { $sort: { count: -1, _id: 1 } },
    ...page({ _id: 0, interest: '$_id', count: 1, users: 1 }),
  ];
}

// GET /api/interests?page=&limit=            -> groups: [{ interest, count, users (preview) }]
// GET /api/interests?interest=chess&page=&limit= -> { interest, data: members of that group }
async function groupByInterests(req, res) {
  const p = parsePagination(req.query);
  const raw = req.query.interest;
  const blank = raw === undefined || (typeof raw === 'string' && raw.trim() === '');
  const interest = blank ? null : v.interest(raw);

  const pipeline = buildInterestPipeline({ interest, skip: p.skip, limit: p.limit, isAdmin: req.user.role === 'admin' });
  const docs = await User.collection.aggregate(pipeline, { allowDiskUse: true }).toArray();

  let data;
  let total;
  if (interest) {
    // members..., then { total } (absent when the group is empty)
    const last = docs[docs.length - 1];
    const hasTotal = last && last._id === undefined && typeof last.total === 'number';
    data = hasTotal ? docs.slice(0, -1) : docs;
    total = hasTotal ? last.total : 0;
  } else {
    data = docs[0] ? docs[0].data : [];
    total = docs[0] ? docs[0].total : 0;
  }
  res.json({
    ...(interest ? { interest } : {}),
    data,
    pagination: { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) },
  });
}

module.exports = { groupByInterests, buildInterestPipeline, MEMBER_PREVIEW };
