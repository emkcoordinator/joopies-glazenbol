const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');

const db = new Database('glazenbol.db');
const app = express();
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'replace-with-secure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// Helpers for DB
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }

// Init: ensure schema exists (run schema.sql manually or call this on first run)
function initSchema() {
  const schema = `
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
  `;
  db.exec(schema);
}
initSchema();

// Auth helpers
async function createUser(username, password, role='player') {
  const hash = await bcrypt.hash(password, 10);
  return run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role]);
}
async function verifyUser(username, password) {
  const user = get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  return ok ? user : null;
}
function ensureAuth(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (role && req.session.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// POST /login
app.post('/login',
  body('username').isString().notEmpty(),
  body('password').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { username, password } = req.body;
    const user = await verifyUser(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    return res.json({ message: 'Login successful', redirect: user.role === 'organisator' ? '/organisator' : '/player' });
  }
);

// Organisator: open season
app.post('/organisator/:id/seasons', ensureAuth('organisator'),
  body('name').isString().notEmpty(),
  body('year').isInt({ min: 2000 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const ownerId = req.session.user.id;
    const { name, year } = req.body;
    const result = run('INSERT INTO seasons (owner_id, name, year, status) VALUES (?, ?, ?, ?)', [ownerId, name, year, 'open']);
    res.json({ message: 'Season opened', seasonId: result.lastInsertRowid });
  }
);

// Create round with validation & transaction
app.post('/organisator/:seasonId/rounds', ensureAuth('organisator'),
  body('roundNumber').isInt({ min: 1 }),
  body('matches').isArray({ min: 1 }),
  body('superRound').optional().isBoolean(),
  body('jokerMatchIndex').optional().isInt({ min: 0 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const seasonId = req.params.seasonId;
    const { roundNumber, matches, superRound = false, jokerMatchIndex = null } = req.body;

    // Super-round validation: exactly 8 matches and exactly one joker index between 0..7
    if (superRound) {
      if (matches.length !== 8) return res.status(400).json({ error: 'Super round must have exactly 8 matches' });
      if (jokerMatchIndex === null || jokerMatchIndex < 0 || jokerMatchIndex > 7) {
        return res.status(400).json({ error: 'Super round must include a jokerMatchIndex between 0 and 7' });
      }
    } else {
      if (matches.length !== 4) return res.status(400).json({ error: 'Regular round must have exactly 4 matches' });
    }

    const insertRound = db.prepare('INSERT INTO rounds (season_id, round_number, super_round) VALUES (?, ?, ?)');
    const insertMatch = db.prepare('INSERT INTO matches (round_id, home_team, away_team, odds_home, odds_away, odds_draw, is_joker) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction(() => {
      const r = insertRound.run(seasonId, roundNumber, superRound ? 1 : 0);
      const roundId = r.lastInsertRowid;
      matches.forEach((m, idx) => {
        const isJoker = (superRound && idx === jokerMatchIndex) ? 1 : 0;
        insertMatch.run(roundId, m.home, m.away, m.oddsHome || 1.0, m.oddsAway || 1.0, m.oddsDraw || 1.0, isJoker);
      });
      return roundId;
    });

    try {
      const roundId = transaction();
      res.json({ message: 'Round created', roundId });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create round', detail: err.message });
    }
  }
);

// Organizer fills a match result
app.post('/organisator/:seasonId/matches/:matchId/result', ensureAuth('organisator'),
  body('result').isIn(['1','2','3']),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const matchId = req.params.matchId;
    const { result } = req.body;
    const m = get('SELECT id FROM matches WHERE id = ?', [matchId]);
    if (!m) return res.status(404).json({ error: 'Match not found' });
    run('UPDATE matches SET result = ? WHERE id = ?', [result, matchId]);
    res.json({ message: 'Result recorded', matchId, result });
  }
);

// Player: make prediction
app.post('/player/rounds/:roundId/prediction', ensureAuth('player'),
  body('matchId').isInt(),
  body('prediction').isIn(['1','2','3']),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const playerId = req.session.user.id;
    const { matchId, prediction } = req.body;
    const match = get('SELECT id FROM matches WHERE id = ?', [matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    run('INSERT INTO predictions (player_id, match_id, prediction) VALUES (?, ?, ?)', [playerId, matchId, prediction]);
    res.json({ message: 'Prediction saved' });
  }
);

// Score calculation helper (applies joker doubling)
function calculatePlayerScores() {
  return all(`
    SELECT u.id as player_id, u.username,
    COALESCE(SUM(
      CASE
        WHEN p.prediction = m.result THEN
          (CASE WHEN p.prediction = '1' THEN m.odds_home
                WHEN p.prediction = '2' THEN m.odds_away
                WHEN p.prediction = '3' THEN m.odds_draw END)
          * (CASE WHEN m.is_joker = 1 THEN 2 ELSE 1 END)
        ELSE
          (-1 * (CASE WHEN m.is_joker = 1 THEN 2 ELSE 1 END))
      END
    ), 0) as score
    FROM users u
    LEFT JOIN predictions p ON p.player_id = u.id
    LEFT JOIN matches m ON m.id = p.match_id
    GROUP BY u.id
    ORDER BY score DESC
  `);
}

// Player standings
app.get('/player/standings', ensureAuth('player'), (req, res) => {
  const standings = calculatePlayerScores();
  res.json({ standings });
});

// Minimal route to list rounds and matches
app.get('/player/rounds', ensureAuth('player'), (req, res) => {
  const rows = all(`
    SELECT r.id as round_id, r.round_number, r.super_round, m.id as match_id, m.home_team, m.away_team, m.odds_home, m.odds_away, m.odds_draw, m.is_joker
    FROM rounds r JOIN matches m ON m.round_id = r.id
    ORDER BY r.round_number, m.id
  `);
  res.json({ rounds: rows });
});

// Close season
app.post('/organisator/:id/seasons/:seasonId/close', ensureAuth('organisator'), (req, res) => {
  const seasonId = req.params.seasonId;
  run('UPDATE seasons SET status = ? WHERE id = ?', ['closed', seasonId]);
  res.json({ message: 'Season closed', seasonId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Glazenbol server listening on ${PORT}`));
