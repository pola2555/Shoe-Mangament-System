const knex = require('knex');
const knexConfig = require('../../knexfile');
const env = require('./env');

const db = knex(knexConfig[env.nodeEnv]);

module.exports = db;
