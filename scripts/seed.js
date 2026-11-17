'use strict';

// Usage:
//   npm run seed        -> creates (or resets) the admin account from ADMIN_* env vars
//   npm run seed:demo   -> WIPES the database, then creates the admin + demo users/notes/posts

require('dotenv').config();
const mongoose = require('mongoose');
const db = require('../src/db');
const User = require('../src/models/User');
const Note = require('../src/models/Note');
const Post = require('../src/models/Post');

const demo = process.argv.includes('--demo');

async function upsertAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'Admin@12345';
  let admin = await User.findOne({ email }).select('+password');
  if (!admin) admin = new User({ email });
  admin.set({ name: process.env.ADMIN_NAME || 'Admin', password, role: 'admin' });
  await admin.save();
  console.log(`Admin ready: ${email} (password from ADMIN_PASSWORD${process.env.ADMIN_PASSWORD ? '' : ', default: see README'})`);
  return admin;
}

async function seedDemo(admin) {
  const people = [
    ['Alice', ['chess', 'reading']],
    ['Bob', ['reading', 'hiking']],
    ['Carol', ['chess', 'music']],
    ['Dave', ['music', 'hiking', 'reading']],
    ['Eve', []],
  ];
  const users = [];
  for (const [name, interests] of people) {
    const u = await User.create({
      name,
      email: `${name.toLowerCase()}@example.com`,
      password: 'Password123',
      interests,
    });
    users.push(u);
  }
  admin.interests = ['chess'];
  await admin.save();

  for (const u of [admin, ...users]) {
    await Note.insertMany(
      Array.from({ length: 3 }, (_, i) => ({ owner: u._id, title: `${u.name}'s note #${i + 1}`, content: 'Private note' }))
    );
    await Post.insertMany(
      Array.from({ length: 2 }, (_, i) => ({ author: u._id, title: `${u.name}'s post #${i + 1}`, content: 'Public post' }))
    );
  }
  console.log('Demo users (password "Password123"):', users.map((u) => u.email).join(', '));
}

(async () => {
  await db.connect();
  if (demo) {
    await mongoose.connection.dropDatabase();
    await db.disconnect();
    await db.connect(); // recreate indexes on the empty database
  }
  const admin = await upsertAdmin();
  if (demo) await seedDemo(admin);
  await db.disconnect();
})().catch(async (err) => {
  console.error(err);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
