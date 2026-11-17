'use strict';

const mongoose = require('mongoose');
const config = require('./config');
const User = require('./models/User');
const Note = require('./models/Note');
const Post = require('./models/Post');

// Indexes are managed explicitly through syncIndexes() so that the database only ever
// contains the indexes declared with schema.index() in the models.
mongoose.set('autoIndex', false);
mongoose.set('strictQuery', true);

async function connect(uri = config.mongoUri) {
  await mongoose.connect(uri);
  if (config.syncIndexes) {
    for (const model of [User, Note, Post]) {
      await model.syncIndexes();
    }
  }
  return mongoose.connection;
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = { connect, disconnect };
