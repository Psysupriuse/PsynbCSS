// 学生端：活动浏览、报名、我的报名、个人中心
const express = require('express');
const { getDb } = require('../db');
const { getActivityStatus } = require('../utils/activity-status');
const { setFlash } = require('../middleware');
const auth = require('../auth');

const router = express.Router();

// FR-05 活动列表（可按标题/地点关键字筛选，含报名人数）
router.get('/', (req, res) => {
  const keyword = String(req.query.q || '').trim();
  const db = getDb();
  let sql = `
    SELECT a.*, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id) AS registered_count
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

// FR-06 活动详情（含当前学生是否已报名）
router.get('/activities/:id', (req, res) => {
  const db = getDb();
  const activity = db.prepare(`
    SELECT a.*, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id) AS registered_count,
      EXISTS(SELECT 1 FROM registrations r WHERE r.activity_id = a.id AND r.student_id = ?) AS registered_by_me
    FROM activities a
    JOIN users u ON u.id = a.teacher_id
    WHERE a.id = ?`).get(req.session.user.id, Number(req.params.id));
  if (!activity) return res.status(404).render('404');
  activity.status = getActivityStatus(activity.time, activity.registered_count, activity.max_participants);
  res.render('student/detail', { activity });
});

// FR-07 报名：已结束/已满员/重复报名均拒绝并提示
router.post('/activities/:id/register', (req, res) => {
  const db = getDb();
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(Number(req.params.id));
  if (!activity) return res.status(404).render('404');
  const backUrl = `/student/activities/${activity.id}`;

  if (new Date(activity.time) <= new Date()) {
    setFlash(req, 'error', '该活动已结束，无法报名');
    return res.redirect(backUrl);
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM registrations WHERE activity_id = ?').get(activity.id).c;
  if (count >= activity.max_participants) {
    setFlash(req, 'error', '该活动报名人数已满');
    return res.redirect(backUrl);
  }
  try {
    db.prepare('INSERT INTO registrations (activity_id, student_id) VALUES (?, ?)')
      .run(activity.id, req.session.user.id);
    setFlash(req, 'success', '报名成功');
  } catch (err) {
    // 唯一约束兜底：绕过前端的重复提交仍被拒绝
    if (String(err.message).includes('UNIQUE')) {
      setFlash(req, 'error', '您已报名该活动，不可重复报名');
    } else {
      throw err;
    }
  }
  res.redirect(backUrl);
});

// FR-08 我的报名记录（含活动状态）
router.get('/my', (req, res) => {
  const rows = getDb().prepare(`
    SELECT a.*, r.created_at AS registered_at, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r2 WHERE r2.activity_id = a.id) AS registered_count
    FROM registrations r
    JOIN activities a ON a.id = r.activity_id
    JOIN users u ON u.id = a.teacher_id
    WHERE r.student_id = ?
    ORDER BY r.created_at DESC`).all(req.session.user.id);
  for (const a of rows) {
    a.status = getActivityStatus(a.time, a.registered_count, a.max_participants);
  }
  res.render('student/my', { rows });
});

// 个人中心
router.get('/profile', (req, res) => res.render('student/profile'));
router.post('/profile', auth.changePassword);

module.exports = router;
