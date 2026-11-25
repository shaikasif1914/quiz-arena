'use strict';
/**
 * SQLite persistence (Node's built-in node:sqlite, no native dependencies).
 *
 *  rooms        one row per room; also holds the live game phase so a server restart can resume
 *  players      one row per person in a room (identity = client_id; token is derived server-side)
 *  games        one row per game played in a room (Play Again creates another)
 *  questions    the questions for a game, INCLUDING the correct answer (never sent to clients early)
 *  game_players who took part in a game (snapshot taken when the host presses Start)
 *  answers      one row per (game, question, player); the primary key makes double-submits impossible
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id               TEXT PRIMARY KEY,
  host_player_id   TEXT,
  category         TEXT    NOT NULL,
  num_questions    INTEGER NOT NULL,
  phase            TEXT    NOT NULL DEFAULT 'lobby',   -- lobby | starting | intro | question | reveal | finished
  game_id          INTEGER,
  game_no          INTEGER NOT NULL DEFAULT 0,
  q_index          INTEGER NOT NULL DEFAULT -1,
  phase_started_at INTEGER,
  phase_ends_at    INTEGER,
  used_questions   TEXT    NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id        TEXT PRIMARY KEY,
  room_id   TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  client_id TEXT    NOT NULL,
  nickname  TEXT    NOT NULL,
  avatar    INTEGER NOT NULL,
  state     TEXT    NOT NULL DEFAULT 'active',          -- active | left | kicked
  joined_at INTEGER NOT NULL,
  UNIQUE (room_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);
CREATE TABLE IF NOT EXISTS games (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  game_no       INTEGER NOT NULL,
  category      TEXT    NOT NULL,
  num_questions INTEGER NOT NULL,
  source        TEXT    NOT NULL,                       -- ai | ai+bank | bank
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE TABLE IF NOT EXISTS questions (
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  options     TEXT    NOT NULL,                         -- JSON array of 4 strings, in display order
  correct_idx INTEGER NOT NULL,
  difficulty  TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  PRIMARY KEY (game_id, idx)
);
CREATE TABLE IF NOT EXISTS game_players (
  game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (game_id, player_id)
);
CREATE TABLE IF NOT EXISTS answers (
  game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  q_idx        INTEGER NOT NULL,
  player_id    TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  choice       INTEGER NOT NULL,
  is_correct   INTEGER NOT NULL,
  points       INTEGER NOT NULL,
  time_ms      INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, q_idx, player_id)
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { openDb, tx };
