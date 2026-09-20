// 教师端：活动管理（发布/编辑/删除/名单/统计）、个人中心
const express = require('express');
const { getDb } = require('../db');
const { setFlash } = require('../middleware');
const { getActivityStatus, formatLocalTime } = require('../utils/activity-status');
const auth = require('../auth');

const router = express.Router();

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// 校验活动表单，返回 { data, errors }；errors 为空数组表示通过
function parseActivityForm(body) {
  const data = {
    title: String(body.title || '').trim(),
    time: String(body.time || '').trim(),
    location: String(body.location || '').trim(),
    description: String(body.description || '').trim(),
    max_participants: Number(body.max_participants),
  };
  const errors = [];
  if (!data.title) errors.push('请填写活动标题');
  if (!TIME_RE.test(data.time) || isNaN(new Date(data.time).getTime())) errors.push('活动时间格式应为 YYYY-MM-DD HH:MM');
  if (!data.location) errors.push('请填写活动地点');
  if (!data.description) errors.push('请填写活动简介');
  if (!Number.isInteger(data.max_participants) || data.max_participants < 1) errors.push('最大报名人数应为正整数');
  return { data, errors };
}

// 加载"本人"活动；不存在渲染 404，非本人渲染 403，均返回 null
function loadOwnActivity(req, res) {
  const activity = getDb().prepare('SELECT * FROM activities WHERE id = ?').get(Number(req.params.id));
  if (!activity) {
    res.status(404).render('404');
    return null;
  }
  if (activity.teacher_id !== req.session.user.id) {
    res.status(403).render('403', { message: '只能管理自己发布的活动' });
    return null;
  }
  return activity;
}

// 后台首页统计：总活动数、待开始、已结束（仅本人活动；时间字符串格式固定，可直接比较）
router.get('/', (req, res) => {
  const db = getDb();
  const now = formatLocalTime(new Date());
  const total = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE teacher_id = ?').get(req.session.user.id).c;
  const upcoming = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE teacher_id = ? AND time > ?')
    .get(req.session.user.id, now).c;
  res.render('teacher/dashboard', { total, upcoming, ended: total - upcoming });
});

// 活动管理列表（仅本人活动，含报名人数与状态）
router.get('/activities', (req, res) => {
  const rows = getDb().prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id) AS registered_count
    FROM activities a
    WHERE a.teacher_id = ?
    ORDER BY a.time DESC`).all(req.session.user.id);
  for (const a of rows) {
    a.status = getActivityStatus(a.time, a.registered_count, a.max_participants);
  }
  res.render('teacher/activities', { activities: rows });
});

router.get('/activities/new', (req, res) => {
  res.render('teacher/activity-form', {
    mode: 'new',
    activity: { title: '', time: '', location: '', description: '', max_participants: '' },
  });
});

// FR-09 创建新活动
router.post('/activities/new', (req, res) => {
  const { data, errors } = parseActivityForm(req.body);
  if (errors.length) {
    setFlash(req, 'error', errors.join('；'));
    return res.render('teacher/activity-form', { mode: 'new', activity: data });
  }
  getDb().prepare('INSERT INTO activities (title, time, location, description, max_participants, teacher_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(data.title, data.time, data.location, data.description, data.max_participants, req.session.user.id);
  setFlash(req, 'success', '活动创建成功');
  res.redirect('/teacher/activities');
});

// FR-10 编辑（仅本人活动）
router.get('/activities/:id/edit', (req, res) => {
  const activity = loadOwnActivity(req, res);
  if (!activity) return;
  res.render('teacher/activity-form', { mode: 'edit', activity });
});

router.post('/activities/:id/edit', (req, res) => {
  const activity = loadOwnActivity(req, res);
  if (!activity) return;
  const { data, errors } = parseActivityForm(req.body);
  if (errors.length) {
    setFlash(req, 'error', errors.join('；'));
    return res.render('teacher/activity-form', { mode: 'edit', activity: { ...data, id: activity.id } });
  }
  getDb().prepare('UPDATE activities SET title = ?, time = ?, location = ?, description = ?, max_participants = ? WHERE id = ?')
    .run(data.title, data.time, data.location, data.description, data.max_participants, activity.id);
  setFlash(req, 'success', '活动修改成功');
  res.redirect('/teacher/activities');
});

// FR-11 删除（仅本人活动；先删报名记录再删活动，避免残留数据）
router.post('/activities/:id/delete', (req, res) => {
  const activity = loadOwnActivity(req, res);
  if (!activity) return;
  getDb().prepare('DELETE FROM registrations WHERE activity_id = ?').run(activity.id);
  getDb().prepare('DELETE FROM activities WHERE id = ?').run(activity.id);
  setFlash(req, 'success', '活动已删除');
  res.redirect('/teacher/activities');
});

// 个人中心
router.get('/profile', (req, res) => res.render('teacher/profile'));
router.post('/profile', auth.changePassword);

module.exports = router;
