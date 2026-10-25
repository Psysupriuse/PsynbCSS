const express = require('express');
const { getDb } = require('../db');
const { getActivityStatus } = require('../utils/activity-status');
const { getRegistrationStatus } = require('../utils/registration-status');
const { createMessage } = require('../utils/message');
const { setFlash } = require('../middleware');
const auth = require('../auth');

const router = express.Router();

// V3.0 活动类型选项（教师发布时填写，供学生端筛选）
const CATEGORIES = ['校园服务', '文化艺术', '体育健康', '公益实践', '科普实践', '科技创新', '职业发展', '技能提升', '其他'];

// V3.0 开始时间筛选：本周/本月/周末（均以本地时间计算）
function timeRangeFilter(key) {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'week') {
    const offset = (now.getDay() + 6) % 7; // 周一为一周起点
    const from = new Date(dayStart);
    from.setDate(from.getDate() - offset);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return [from, to];
  }
  if (key === 'month') {
    return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)];
  }
  if (key === 'weekend') {
    const from = new Date(dayStart);
    from.setDate(from.getDate() + ((6 - from.getDay()) + 7) % 7); // 最近的周六
    const to = new Date(from);
    to.setDate(to.getDate() + 2);
    return [from, to];
  }
  return null;
}

// 'YYYY-MM-DD HH:MM' 转本地时间（避免依赖浏览器对带空格格式的解析）
function parseLocal(timeStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(timeStr || ''));
  if (!m) return new Date(timeStr);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

// 本地时间格式化为 'YYYY-MM-DD HH:MM'，与 activities.time 同格式，便于 SQL 比较
function fmt(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

// 占正式名额的报名状态：待确认 + 已通过（候补/取消/未通过不占名额）
const OCCUPIED_SQL = "status IN ('pending','approved')";
const ACTIVE_SQL = "status IN ('pending','approved','waiting')";

function occupiedCount(db, activityId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE activity_id = ? AND ${OCCUPIED_SQL}`).get(activityId).c;
}

function waitingCount(db, activityId) {
  return db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE activity_id = ? AND status = 'waiting'").get(activityId).c;
}

// 有人取消/被拒后释放名额，把候补中最早加入的学生递补为正式报名
function promoteNext(db, activityId) {
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return;
  if (occupiedCount(db, activityId) >= activity.max_participants) return;
  const next = db.prepare("SELECT * FROM registrations WHERE activity_id = ? AND status = 'waiting' ORDER BY created_at ASC, id ASC LIMIT 1").get(activityId);
  if (!next) return;
  db.prepare('UPDATE registrations SET status = ? WHERE id = ?')
    .run(activity.needs_review ? 'pending' : 'approved', next.id);
  createMessage(next.student_id, `您报名的「${activity.title}」已候补转正，报名成功`, activity.id);
}

// FR-05 活动列表（关键字/类型/开始时间筛选，可切换排序）
router.get('/', (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim(),
    category: String(req.query.category || '').trim(),
    time: String(req.query.time || '').trim(),
    sort: String(req.query.sort || '').trim(),
  };
  const db = getDb();
  let sql = `
    SELECT a.*, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND ${OCCUPIED_SQL}) AS registered_count
    FROM activities a
    JOIN users u ON u.id = a.teacher_id`;
  const params = [];
  const conds = [];
  if (filters.q) {
    conds.push('(a.title LIKE ? OR a.location LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  if (filters.category) {
    conds.push('a.category = ?');
    params.push(filters.category);
  }
  if (filters.time) {
    const range = timeRangeFilter(filters.time);
    if (range) {
      conds.push('a.time >= ? AND a.time < ?');
      params.push(fmt(range[0]), fmt(range[1]));
    }
  }
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  sql += filters.sort === 'slots'
    ? ' ORDER BY (a.max_participants - registered_count) DESC, a.time ASC'
    : ' ORDER BY a.time DESC';
  const activities = db.prepare(sql).all(...params);
  for (const a of activities) {
    a.status = getActivityStatus(a.time, a.registered_count, a.max_participants);
  }
  // 类型下拉只列系统中出现过的类型，保持顺序稳定
  const used = db.prepare('SELECT DISTINCT category FROM activities').all().map((r) => r.category);
  const categories = CATEGORIES.filter((c) => used.includes(c));
  res.render('student/index', { activities, filters, categories });
});
// FR-06 活动详情（含当前学生的报名/候补状态）
router.get('/activities/:id', (req, res) => {
  const db = getDb();
  const activityId = Number(req.params.id);
  const activity = db.prepare(`
    SELECT a.*, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND ${OCCUPIED_SQL}) AS registered_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'waiting') AS waiting_count
    FROM activities a
    JOIN users u ON u.id = a.teacher_id
    WHERE a.id = ?`).get(activityId);
  if (!activity) return res.status(404).render('404');
  activity.status = getActivityStatus(activity.time, activity.registered_count, activity.max_participants);
  const myRecord = db.prepare('SELECT * FROM registrations WHERE activity_id = ? AND student_id = ? ORDER BY id DESC LIMIT 1')
    .get(activityId, req.session.user.id);
  activity.myRecord = myRecord;
  activity.myRegStatus = myRecord ? getRegistrationStatus(myRecord.status) : null;
  res.render('student/detail', { activity });
});

// FR-07 报名：已结束/重复报名拒绝；名额满时自动进入候补；需审核活动进入待确认
router.post('/activities/:id/register', (req, res) => {
  const db = getDb();
  const activityId = Number(req.params.id);
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return res.status(404).render('404');
  const backUrl = `/student/activities/${activityId}`;

  if (parseLocal(activity.time) <= new Date()) {
    setFlash(req, 'error', '该活动已结束，无法报名');
    return res.redirect(backUrl);
  }
  const existing = db.prepare(`SELECT * FROM registrations WHERE activity_id = ? AND student_id = ? AND ${ACTIVE_SQL}`)
    .get(activityId, req.session.user.id);
  if (existing) {
    setFlash(req, 'error', existing.status === 'waiting' ? '您已在候补名单中，无需重复报名' : '您已报名该活动，不可重复报名');
    return res.redirect(backUrl);
  }

  try {
    if (occupiedCount(db, activityId) >= activity.max_participants) {
      db.prepare("INSERT INTO registrations (activity_id, student_id, status) VALUES (?, ?, 'waiting')")
        .run(activityId, req.session.user.id);
      setFlash(req, 'success', '该活动已满员，已进入候补名单，有人退出后将按顺序递补');
      createMessage(req.session.user.id, `您报名的「${activity.title}」已满员，已进入候补名单`, activityId);
    } else {
      db.prepare('INSERT INTO registrations (activity_id, student_id, status) VALUES (?, ?, ?)')
        .run(activityId, req.session.user.id, activity.needs_review ? 'pending' : 'approved');
      setFlash(req, 'success', activity.needs_review ? '报名成功，等待老师确认' : '报名成功');
      createMessage(req.session.user.id,
        activity.needs_review ? `您报名的「${activity.title}」已提交，等待老师确认` : `您报名的「${activity.title}」报名成功`,
        activityId);
    }
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      setFlash(req, 'error', '您已报名该活动，不可重复报名');
    } else {
      throw err;
    }
  }
  res.redirect(backUrl);
});

// 明确加入候补（名额已满时使用）
router.post('/activities/:id/waitlist', (req, res) => {
  const db = getDb();
  const activityId = Number(req.params.id);
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return res.status(404).render('404');
  const backUrl = `/student/activities/${activityId}`;

  if (parseLocal(activity.time) <= new Date()) {
    setFlash(req, 'error', '该活动已结束，无法加入候补');
    return res.redirect(backUrl);
  }
  const existing = db.prepare(`SELECT * FROM registrations WHERE activity_id = ? AND student_id = ? AND ${ACTIVE_SQL}`)
    .get(activityId, req.session.user.id);
  if (existing) {
    setFlash(req, 'error', existing.status === 'waiting' ? '您已在候补名单中' : '您已报名该活动，无需候补');
    return res.redirect(backUrl);
  }
  try {
    db.prepare("INSERT INTO registrations (activity_id, student_id, status) VALUES (?, ?, 'waiting')")
      .run(activityId, req.session.user.id);
    setFlash(req, 'success', '已加入候补名单，有人退出后将按顺序递补');
    createMessage(req.session.user.id, `您已加入「${activity.title}」候补名单`, activityId);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      setFlash(req, 'error', '您已在候补名单中');
    } else {
      throw err;
    }
  }
  res.redirect(backUrl);
});

// 取消正式报名（待确认/已通过），释放名额并自动递补候补
router.post('/activities/:id/cancel', (req, res) => {
  const db = getDb();
  const activityId = Number(req.params.id);
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return res.status(404).render('404');
  const backUrl = `/student/activities/${activityId}`;

  if (parseLocal(activity.time) <= new Date()) {
    setFlash(req, 'error', '活动已结束，无法取消报名');
    return res.redirect(backUrl);
  }
  const reg = db.prepare(`SELECT * FROM registrations WHERE activity_id = ? AND student_id = ? AND ${OCCUPIED_SQL}`)
    .get(activityId, req.session.user.id);
  if (!reg) {
    setFlash(req, 'error', '没有可取消的报名');
    return res.redirect(backUrl);
  }
  db.prepare("UPDATE registrations SET status = 'cancelled' WHERE id = ?").run(reg.id);
  promoteNext(db, activityId);
  setFlash(req, 'success', '已取消报名');
  res.redirect(backUrl);
});

// 退出候补
router.post('/activities/:id/leave-waitlist', (req, res) => {
  const db = getDb();
  const activityId = Number(req.params.id);
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!activity) return res.status(404).render('404');
  const backUrl = `/student/activities/${activityId}`;

  if (parseLocal(activity.time) <= new Date()) {
    setFlash(req, 'error', '活动已结束，无法退出候补');
    return res.redirect(backUrl);
  }
  const reg = db.prepare("SELECT * FROM registrations WHERE activity_id = ? AND student_id = ? AND status = 'waiting'")
    .get(activityId, req.session.user.id);
  if (!reg) {
    setFlash(req, 'error', '您不在候补名单中');
    return res.redirect(backUrl);
  }
  db.prepare("UPDATE registrations SET status = 'cancelled' WHERE id = ?").run(reg.id);
  setFlash(req, 'success', '已退出候补');
  res.redirect(backUrl);
});

// FR-08 我的报名记录（含报名状态与候补状态）
router.get('/my', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.*, r.id AS registration_id, r.status AS reg_status, r.created_at AS registered_at,
      u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r2 WHERE r2.activity_id = a.id AND ${OCCUPIED_SQL}) AS registered_count
    FROM registrations r
    JOIN activities a ON a.id = r.activity_id
    JOIN users u ON u.id = a.teacher_id
    WHERE r.student_id = ?
    ORDER BY r.created_at DESC, r.id DESC`).all(req.session.user.id);
  for (const a of rows) {
    a.activity_status = getActivityStatus(a.time, a.registered_count, a.max_participants);
    a.reg_status_label = getRegistrationStatus(a.reg_status);
  }
  res.render('student/my', { rows });
});

// 个人中心
router.get('/profile', (req, res) => res.render('student/profile'));
router.post('/profile', auth.changePassword);

module.exports = router;
