// 学生端：活动浏览、报名、个人中心
const express = require('express');
const { getDb } = require('../db');
const { getActivityStatus } = require('../utils/activity-status');
const auth = require('../auth');

const router = express.Router();

// FR-05 活动列表（可按标题/地点关键字筛选）
// 注：报名计数子查询待 registrations 表建立后（Task 7）换回真实统计
router.get('/', (req, res) => {
  const keyword = String(req.query.q || '').trim();
  const db = getDb();
  let sql = `
    SELECT a.*, u.username AS teacher_name, 0 AS registered_count
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

// FR-06 活动详情
router.get('/activities/:id', (req, res) => {
  const db = getDb();
  const activity = db.prepare(`
    SELECT a.*, u.username AS teacher_name, 0 AS registered_count, 0 AS registered_by_me
    FROM activities a
    JOIN users u ON u.id = a.teacher_id
    WHERE a.id = ?`).get(Number(req.params.id));
  if (!activity) return res.status(404).render('404');
  activity.status = getActivityStatus(activity.time, activity.registered_count, activity.max_participants);
  res.render('student/detail', { activity });
});

// 个人中心
router.get('/profile', (req, res) => res.render('student/profile'));
router.post('/profile', auth.changePassword);

module.exports = router;
