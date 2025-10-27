-- SQLite schema for Joopie’s Glazenbol (same as server init; kept here for migrations)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('player','organisator'))
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT,
  year INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  FOREIGN KEY(owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL,
  round_number INTEGER,
  super_round INTEGER DEFAULT 0,
  FOREIGN KEY(season_id) REFERENCES seasons(id)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  odds_home REAL DEFAULT 1.0,
  odds_away REAL DEFAULT 1.0,
  odds_draw REAL DEFAULT 1.0,
  is_joker INTEGER DEFAULT 0,
  result TEXT,
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  match_id INTEGER NOT NULL,
  prediction TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(player_id) REFERENCES users(id),
  FOREIGN KEY(match_id) REFERENCES matches(id)
);
