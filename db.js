// SQLite 初始化与连接（Node 24 内置 node:sqlite）
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { hashPassword } = require('./utils/password');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

let db;

// 首次建库时写入演示教师与示例活动，便于学生端页面展示
// 演示账号：teacher_demo / demo123456（README 记录）
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM activities').get().c;
  if (count > 0) return;
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run('teacher_demo', hashPassword('demo123456'), 'teacher');
  const teacher = db.prepare("SELECT id FROM users WHERE username = 'teacher_demo'").get();
  const sample = [
    ['校园迎新晚会', '2026-10-15 19:00', '大学生活动中心', '欢迎新同学，节目表演与互动环节。', 200],
    ['篮球友谊赛', '2026-09-25 16:00', '东区篮球场', '计算机学院 vs 机械学院，欢迎观赛。', 50],
    ['图书馆读书分享会', '2026-09-10 14:00', '图书馆报告厅', '分享一本好书，交流阅读心得。', 80],
  ];
  const insert = db.prepare('INSERT INTO activities (title, time, location, description, max_participants, teacher_id) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of sample) insert.run(...row, teacher.id);
}

function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('student','teacher')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS activities (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT NOT NULL,
      time             TEXT NOT NULL,
      location         TEXT NOT NULL,
      description      TEXT NOT NULL,
      max_participants INTEGER NOT NULL,
      teacher_id       INTEGER NOT NULL REFERENCES users(id),
      created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  seedIfEmpty();
  return db;
}

function getDb() {
  return db;
}

module.exports = { initDb, getDb };
