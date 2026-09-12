const env = require('./src/config/env');
// Registers the pg type parsers before any pool is created. Loaded here rather
// than in config/database.js because migrations and the maintenance scripts come
// through this file too, and a date must mean the same thing in all of them.
require('./src/config/pgTypes');

module.exports = {
  development: {
    client: 'pg',
    connection: {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
    },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: './src/db/migrations',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: './src/db/seeds',
    },
  },

  production: {
    client: 'pg',
    connection: {
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      // SSL only when it is asked for.
      //
      // This used to be unconditional, and it made NODE_ENV=production unusable on the
      // normal deployment here: Postgres runs on the same box as the API
      // (DB_HOST=localhost) and a stock install has SSL switched off, so node-postgres
      // failed the handshake with "The server does not support SSL connections" and the
      // API could not reach its database at all. Switching to production — the one
      // change that turns on the secret guard and stops full error objects being
      // returned to clients — would have taken the whole system down.
      //
      // Set DB_SSL=true for a managed or remote database that requires TLS. A local
      // socket on the same host does not: there is no network for anyone to listen on.
      ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    },
    pool: {
      min: 2,
      max: 20,
    },
    migrations: {
      directory: './src/db/migrations',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: './src/db/seeds',
    },
  },
};
