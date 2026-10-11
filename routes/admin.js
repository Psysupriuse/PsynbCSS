// 系统管理员端：平台账号管理、全平台活动只读监督、个人中心
const express = require('express');
const { getDb } = require('../db');
const { getActivityStatus } = require('../utils/activity-status');
const { setFlash } = require('../middleware');
const auth = require('../auth');

const router = express.Router();

// 后台首页统计
router.get('/', (req, res) => {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const totalActivities = db.prepare('SELECT COUNT(*) AS c FROM activities').get().c;
  const disabledUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 0').get().c;
  res.render('admin/dashboard', { totalUsers, totalActivities, disabledUsers });
});

// 用户列表：展示账号、角色、状态，并支持停用/恢复（管理员账号不可操作）
router.get('/users', (req, res) => {
  const users = getDb().prepare(`
    SELECT id, username, role, active, created_at
    FROM users
    ORDER BY id ASC`).all();
  res.render('admin/users', { users });
});

router.post('/users/:id/toggle', (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).render('404');
  if (target.role === 'admin') {
    setFlash(req, 'error', '不能停用管理员账号');
    return res.redirect('/admin/users');
  }
  const next = target.active ? 0 : 1;
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(next, target.id);
  setFlash(req, 'success', `账号「${target.username}」已${next ? '恢复' : '停用'}`);
  res.redirect('/admin/users');
});

// 全平台活动只读监督：不提供编辑/删除，不代替教师处理报名
router.get('/activities', (req, res) => {
  const rows = getDb().prepare(`
    SELECT a.*, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status IN ('pending','approved')) AS registered_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'waiting') AS waiting_count
    FROM activities a
    JOIN users u ON u.id = a.teacher_id
    ORDER BY a.time DESC`).all();
  for (const a of rows) {
    a.status = getActivityStatus(a.time, a.registered_count, a.max_participants);
  }
  res.render('admin/activities', { activities: rows });
});

router.get('/activities/:id', (req, res) => {
  const activity = getDb().prepare(`
    SELECT a.*, u.username AS teacher_name,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status IN ('pending','approved')) AS registered_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'waiting') AS waiting_count
    FROM activities a
    JOIN users u ON u.id = a.teacher_id
    WHERE a.id = ?`).get(Number(req.params.id));
  if (!activity) return res.status(404).render('404');
  activity.status = getActivityStatus(activity.time, activity.registered_count, activity.max_participants);
  res.render('admin/activity-detail', { activity });
});

// 个人中心
router.get('/profile', (req, res) => res.render('admin/profile'));
router.post('/profile', auth.changePassword);

module.exports = router;
