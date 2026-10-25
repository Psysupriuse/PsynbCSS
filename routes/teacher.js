// 教师端：活动管理（发布/编辑/删除/名单审核/统计）、个人中心
const express = require('express');
const { getDb } = require('../db');
const { setFlash } = require('../middleware');
const { getActivityStatus, formatLocalTime } = require('../utils/activity-status');
const { getRegistrationStatus } = require('../utils/registration-status');
const { createMessage } = require('../utils/message');
const auth = require('../auth');

const router = express.Router();

// V3.0 活动类型选项（与学生端筛选共用同一份列表）
const CATEGORIES = ['校园服务', '文化艺术', '体育健康', '公益实践', '科普实践', '科技创新', '职业发展', '技能提升', '其他'];
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const OCCUPIED_SQL = "status IN ('pending','approved')";

// 校验活动表单，返回 { data, errors }；errors 为空数组表示通过
function parseActivityForm(body) {
  const data = {
    title: String(body.title || '').trim(),
    time: String(body.time || '').trim(),
    location: String(body.location || '').trim(),
    description: String(body.description || '').trim(),
    max_participants: Number(body.max_participants),
    needs_review: body.needs_review ? 1 : 0,
    requirement: String(body.requirement || '').trim(),
    category: String(body.category || '').trim() || '其他',
  };
  const errors = [];
  if (!data.title) errors.push('请填写活动标题');
  if (!TIME_RE.test(data.time) || isNaN(new Date(data.time).getTime())) errors.push('活动时间格式应为 YYYY-MM-DD HH:MM');
  if (!data.location) errors.push('请填写活动地点');
  if (!data.description) errors.push('请填写活动简介');
  if (!Number.isInteger(data.max_participants) || data.max_participants < 1) errors.push('最大报名人数应为正整数');
  if (!CATEGORIES.includes(data.category)) errors.push('请选择有效的活动类型');
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

function occupiedCount(db, activityId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE activity_id = ? AND ${OCCUPIED_SQL}`).get(activityId).c;
}

function waitingCount(db, activityId) {
  return db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE activity_id = ? AND status = 'waiting'").get(activityId).c;
}

// 报名被拒或取消后释放名额，把候补最早加入者递补为正式报名
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

// 后台首页统计：总活动数、待开始、已结束（仅本人活动）
router.get('/', (req, res) => {
  const db = getDb();
  const now = formatLocalTime(new Date());
  const total = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE teacher_id = ?').get(req.session.user.id).c;
  const upcoming = db.prepare('SELECT COUNT(*) AS c FROM activities WHERE teacher_id = ? AND time > ?')
    .get(req.session.user.id, now).c;
  res.render('teacher/dashboard', { total, upcoming, ended: total - upcoming });
});

// 活动管理列表（仅本人活动，含正式报名人数与候补人数）
router.get('/activities', (req, res) => {
  const rows = getDb().prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND ${OCCUPIED_SQL}) AS registered_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'waiting') AS waiting_count
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
    activity: { title: '', time: '', location: '', description: '', max_participants: '', needs_review: 0, requirement: '', category: '' },
    categories: CATEGORIES,
  });
});

// FR-09 创建新活动
router.post('/activities/new', (req, res) => {
  const { data, errors } = parseActivityForm(req.body);
  if (errors.length) {
    setFlash(req, 'error', errors.join('；'));
    return res.render('teacher/activity-form', { mode: 'new', activity: data });
  }
  getDb().prepare('INSERT INTO activities (title, time, location, description, max_participants, needs_review, requirement, category, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(data.title, data.time, data.location, data.description, data.max_participants, data.needs_review, data.requirement, data.category, req.session.user.id);
  setFlash(req, 'success', '活动创建成功');
  res.redirect('/teacher/activities');
});

// FR-10 编辑（仅本人活动）
router.get('/activities/:id/edit', (req, res) => {
  const activity = loadOwnActivity(req, res);
  if (!activity) return;
  res.render('teacher/activity-form', { mode: 'edit', activity, categories: CATEGORIES });
});

router.post('/activities/:id/edit', (req, res) => {
  const activity = loadOwnActivity(req, res);
  if (!activity) return;
  const { data, errors } = parseActivityForm(req.body);
  if (errors.length) {
    setFlash(req, 'error', errors.join('；'));
    return res.render('teacher/activity-form', { mode: 'edit', activity: { ...data, id: activity.id }, categories: CATEGORIES });
  }
  getDb().prepare('UPDATE activities SET title = ?, time = ?, location = ?, description = ?, max_participants = ?, needs_review = ?, requirement = ?, category = ? WHERE id = ?')
    .run(data.title, data.time, data.location, data.description, data.max_participants, data.needs_review, data.requirement, data.category, activity.id);
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

// FR-12 查看报名名单（仅本人活动）：展示状态，并对需审核活动的待确认报名执行通过/未通过
router.get('/activities/:id/roster', (req, res) => {
  const activity = loadOwnActivity(req, res);
  if (!activity) return;
  const students = getDb().prepare(`
    SELECT r.id AS registration_id, u.username, r.created_at, r.status
    FROM registrations r
    JOIN users u ON u.id = r.student_id
    WHERE r.activity_id = ?
    ORDER BY r.created_at ASC, r.id ASC`).all(activity.id);
  for (const s of students) {
    s.status_label = getRegistrationStatus(s.status);
  }
  res.render('teacher/roster', {
    activity,
    students,
    registeredCount: occupiedCount(getDb(), activity.id),
    waitingCount: waitingCount(getDb(), activity.id),
  });
});

// 审核报名：仅限本人活动、且状态为待确认的记录
router.post('/activities/:id/review', (req, res) => {
  const activity = loadOwnActivity(req, res);
  if (!activity) return;
  const db = getDb();
  const regId = Number(req.body.registration_id);
  const action = String(req.body.action || '');
  const rosterUrl = `/teacher/activities/${activity.id}/roster`;
  const reg = db.prepare('SELECT * FROM registrations WHERE id = ? AND activity_id = ?').get(regId, activity.id);
  if (!reg) {
    setFlash(req, 'error', '报名记录不存在');
    return res.redirect(rosterUrl);
  }
  if (reg.status !== 'pending') {
    setFlash(req, 'error', '该报名已处理，无需再次审核');
    return res.redirect(rosterUrl);
  }
  if (action === 'approve') {
    db.prepare("UPDATE registrations SET status = 'approved' WHERE id = ?").run(reg.id);
    createMessage(reg.student_id, `您报名的「${activity.title}」已通过审核`, activity.id);
    setFlash(req, 'success', `已通过「${activity.title}」的报名`);
  } else if (action === 'reject') {
    db.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ?").run(reg.id);
    createMessage(reg.student_id, `您报名的「${activity.title}」未通过审核`, activity.id);
    promoteNext(db, activity.id);
    setFlash(req, 'success', `已拒绝「${activity.title}」的报名`);
  } else {
    setFlash(req, 'error', '无效的审核操作');
  }
  res.redirect(rosterUrl);
});

// 个人中心
router.get('/profile', (req, res) => res.render('teacher/profile'));
router.post('/profile', auth.changePassword);

module.exports = router;
