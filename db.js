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
      role          TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS activities (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT NOT NULL,
      time             TEXT NOT NULL,
      location         TEXT NOT NULL,
      description      TEXT NOT NULL,
      max_participants INTEGER NOT NULL,
      needs_review     INTEGER NOT NULL DEFAULT 0,
      requirement      TEXT NOT NULL DEFAULT '',
      teacher_id       INTEGER NOT NULL REFERENCES users(id),
      created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS registrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL REFERENCES activities(id),
      student_id  INTEGER NOT NULL REFERENCES users(id),
      status      TEXT NOT NULL DEFAULT 'approved',
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
  migrate();
  seedIfEmpty();
  seedAdmin();
  return db;
}

// V1.0 数据库升级到 V2.0：补齐新增字段，并把报名表重建为支持「候补/审核状态」的新结构
function migrate() {
  // 迁移期间需重建 users/registrations 表，先关闭外键约束，避免引用表被 DROP 时失败
  db.exec('PRAGMA foreign_keys = OFF');
  const ensureColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');

  // 旧 users 表的角色 CHECK 不含 admin，需重建表以放宽角色枚举
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (usersSql && !String(usersSql.sql).includes("'admin'")) {
    db.exec(`
      DROP TABLE IF EXISTS users_new;
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO users_new (id, username, password_hash, role, active, created_at)
        SELECT id, username, password_hash, role, active, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  }

  ensureColumn('activities', 'needs_review', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('activities', 'requirement', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('registrations', 'status', "TEXT NOT NULL DEFAULT 'approved'");

  // 旧表用 UNIQUE(activity_id, student_id) 禁止同一学生多次报名，
  // V2.0 需允许「取消/未通过后重新报名」，因此重建表并改用部分唯一索引。
  const indexes = db.prepare("PRAGMA index_list('registrations')").all();
  const hasLegacyUnique = indexes.some((idx) => idx.name.startsWith('sqlite_autoindex_registrations'));
  if (hasLegacyUnique) {
    db.exec(`
      DROP TABLE IF EXISTS registrations_new;
      CREATE TABLE registrations_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id INTEGER NOT NULL REFERENCES activities(id),
        student_id  INTEGER NOT NULL REFERENCES users(id),
        status      TEXT NOT NULL DEFAULT 'approved',
        created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO registrations_new (id, activity_id, student_id, created_at, status)
        SELECT id, activity_id, student_id, created_at, 'approved' FROM registrations;
      DROP TABLE registrations;
      ALTER TABLE registrations_new RENAME TO registrations;
    `);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_active ON registrations(activity_id, student_id) WHERE status IN ('pending','approved','waiting')");
  db.exec('PRAGMA foreign_keys = ON');
}

// 内置系统管理员账号（注册页不开放管理员选项，密码可登录后修改）
function seedAdmin() {
  if (db.prepare("SELECT id FROM users WHERE role = 'admin'").get()) return;
  if (db.prepare("SELECT id FROM users WHERE username = 'admin'").get()) return;
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run('admin', hashPassword('admin123456'), 'admin');
}

function getDb() {
  return db;
}

module.exports = { initDb, getDb };
