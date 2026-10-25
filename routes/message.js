// 站内消息（V3.0 FR-V3-01）：学生查看消息、全部标为已读
const express = require('express');
const { listMessages, markAllRead } = require('../utils/message');
const { setFlash } = require('../middleware');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('student/messages', { messages: listMessages(req.session.user.id) });
});

router.post('/read-all', (req, res) => {
  markAllRead(req.session.user.id);
  setFlash(req, 'success', '已全部标为已读');
  res.redirect('/messages');
});

module.exports = router;
