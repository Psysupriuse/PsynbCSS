// 教师端：活动管理（本任务仅页面框架，统计与列表 Task 6 接数据）
const express = require('express');
const auth = require('../auth');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('teacher/dashboard', { total: 0, upcoming: 0, ended: 0 });
});

router.get('/activities', (req, res) => {
  res.render('teacher/activities', { activities: [] });
});

router.get('/activities/new', (req, res) => {
  res.render('teacher/activity-form', {
    mode: 'new',
    activity: { title: '', time: '', location: '', description: '', max_participants: '' },
  });
});

// 个人中心
router.get('/profile', (req, res) => res.render('teacher/profile'));
router.post('/profile', auth.changePassword);

module.exports = router;
