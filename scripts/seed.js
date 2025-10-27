// Seed script: creates an organiser and a few players, and one sample season/round
// Run with: node scripts/seed.js
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const db = new Database('glazenbol.db');

async function seed() {
  // Create tables if not exist (simple)
  const schema = require('fs').readFileSync('schema.sql', 'utf8');
  db.exec(schema);

  const createUser = (username, password, role) => {
    const hash = bcrypt.hashSync(password, 10);
    try {
      db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role);
      console.log('Created user', username);
    } catch (e) {
      console.log('Skipping existing user', username);
    }
  };

  createUser('organisator', 'organisatorpw', 'organisator');
  createUser('alice', 'alicepw', 'player');
  createUser('bob', 'bobpw', 'player');

  // Create a sample season if none exists
  const existing = db.prepare('SELECT id FROM seasons LIMIT 1').get();
  if (!existing) {
    const r = db.prepare('INSERT INTO seasons (owner_id, name, year) VALUES ((SELECT id FROM users WHERE username = ?), ?, ?)').run('organisator', 'Voorbeeldseizoen', 2025);
    const seasonId = r.lastInsertRowid;
    const rd = db.prepare('INSERT INTO rounds (season_id, round_number, super_round) VALUES (?, ?, ?)').run(seasonId, 1, 0);
    const roundId = rd.lastInsertRowid;
    // Add 4 sample matches
    const insertMatch = db.prepare('INSERT INTO matches (round_id, home_team, away_team, odds_home, odds_away, odds_draw) VALUES (?, ?, ?, ?, ?, ?);');
    insertMatch.run(roundId, 'Team A', 'Team B', 1.8, 3.2, 3.5);
    insertMatch.run(roundId, 'Team C', 'Team D', 2.1, 2.7, 3.0);
    insertMatch.run(roundId, 'Team E', 'Team F', 1.6, 4.0, 3.8);
    insertMatch.run(roundId, 'Team G', 'Team H', 2.0, 3.0, 3.2);
    console.log('Seeded season and round');
  } else {
    console.log('Season exists, skipping season seed');
  }
}

seed().then(() => console.log('Done')).catch(e => console.error(e));
