// 学生端：活动浏览、报名/候补、取消报名、我的报名、个人中心
const express = require('express');
const { getDb } = require('../db');
const { getActivityStatus } = require('../utils/activity-status');
const { getRegistrationStatus } = require('../utils/registration-status');
const { setFlash } = require('../middleware');
const auth = require('../auth');

const router = express.Router();

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
}

// FR-05 活动列表（可按标题/地点关键字筛选，正式报名人数用于满员判定）
router.get('/', (req, res) => {
  const keyword = String(req.query.q || '').trim();
  const db = getDb();
  let sql = `
    SELECT a.*, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND ${OCCUPIED_SQL}) AS registered_count
    FROM activities a
    JOIN users u ON u.id = a.teacher_id`;
  const params = [];
  if (keyword) {
    sql += ' WHERE a.title LIKE ? OR a.location LIKE ?';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  sql += ' ORDER BY a.time DESC';
  const activities = db.prepare(sql).all(...params);
  for (const a of activities) {
    a.status = getActivityStatus(a.time, a.registered_count, a.max_participants);
  }
  res.render('student/index', { activities, keyword });
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

  if (new Date(activity.time) <= new Date()) {
    setFlash(req, 'error', '该活动已结束，无法报名');
    return res.redirect(backUrl);
  }
  const existing = db.prepare(`SELECT * FROM registrations WHERE activity_id = ? AND student_id = ? AND ${ACTIVE_SQL}`)
    .get(activityId, req.session.user.id);
  if (existing) {
    setFlash(req, 'error', existing.status === 'waiting' ? '您已在候补名单中' : '您已报名该活动，不可重复报名');
    return res.redirect(backUrl);
  }

  try {
    if (occupiedCount(db, activityId) >= activity.max_participants) {
      db.prepare("INSERT INTO registrations (activity_id, student_id, status) VALUES (?, ?, 'waiting')")
        .run(activityId, req.session.user.id);
      setFlash(req, 'success', '活动已满员，已进入候补名单');
    } else {
      db.prepare('INSERT INTO registrations (activity_id, student_id, status) VALUES (?, ?, ?)')
        .run(activityId, req.session.user.id, activity.needs_review ? 'pending' : 'approved');
      setFlash(req, 'success', activity.needs_review ? '报名成功，等待老师确认' : '报名成功');
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

  if (new Date(activity.time) <= new Date()) {
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

  if (new Date(activity.time) <= new Date()) {
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

  if (new Date(activity.time) <= new Date()) {
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
