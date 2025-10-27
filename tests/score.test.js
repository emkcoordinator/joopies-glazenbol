// Jest tests for scoring rules, including joker doubling
const Database = require('better-sqlite3');
const fs = require('fs');
const bcrypt = require('bcrypt');

const DB_PATH = 'test_glazenbol.db';

function setupDb() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);
  const schema = fs.readFileSync('schema.sql', 'utf8');
  db.exec(schema);
  // seed two users
  const hash = bcrypt.hashSync('pw', 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('alice', hash, 'player');
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('bob', hash, 'player');
  // season, round
  const s = db.prepare('INSERT INTO seasons (owner_id, name, year) VALUES ((SELECT id FROM users WHERE username = ?), ?, ?)').run('alice','S',2025);
  const seasonId = s.lastInsertRowid;
  const r = db.prepare('INSERT INTO rounds (season_id, round_number, super_round) VALUES (?, ?, ?)').run(seasonId, 1, 1);
  const roundId = r.lastInsertRowid;
  // Insert 8 matches; make match 3 the joker (is_joker = 1)
  const insert = db.prepare('INSERT INTO matches (round_id, home_team, away_team, odds_home, odds_away, odds_draw, is_joker) VALUES (?, ?, ?, ?, ?, ?, ?);');
  for (let i=0;i<8;i++){
    insert.run(roundId, `H${i}`, `A${i}`, 2.0, 3.0, 4.0, i===2 ? 1 : 0);
  }
  // set results: all home (1)
  db.prepare('UPDATE matches SET result = ?').run('1');
  // alice predicts all home (correct) -> alice should get sum of (odds_home * (is_joker?2:1))
  // bob predicts all away (wrong) -> bob should get sum of (-1 * (is_joker?2:1))
  const pidAlice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice').id;
  const pidBob = db.prepare('SELECT id FROM users WHERE username = ?').get('bob').id;
  const matchIds = db.prepare('SELECT id, is_joker FROM matches ORDER BY id').all();
  matchIds.forEach(m => {
    db.prepare('INSERT INTO predictions (player_id, match_id, prediction) VALUES (?, ?, ?)').run(pidAlice, m.id, '1');
    db.prepare('INSERT INTO predictions (player_id, match_id, prediction) VALUES (?, ?, ?)').run(pidBob, m.id, '2');
  });
  return db;
}

test('scoring with joker works', () => {
  const db = setupDb();
  const rows = db.prepare(`
    SELECT u.username,
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
      ),0) as score
    FROM users u
    LEFT JOIN predictions p ON p.player_id = u.id
    LEFT JOIN matches m ON m.id = p.match_id
    GROUP BY u.id
    ORDER BY u.username
  `).all();

  const aliceRow = rows.find(r => r.username === 'alice');
  const bobRow = rows.find(r => r.username === 'bob');

  // alice: 7 matches correct with odds_home=2.0 => 7*2.0 = 14, joker match correct gives 2.0*2 = 4 => total 18
  expect(aliceRow.score).toBeCloseTo(18);

  // bob: 7 matches wrong => 7 * -1 = -7, joker wrong => -2 => total -9
  expect(bobRow.score).toBeCloseTo(-9);
});
