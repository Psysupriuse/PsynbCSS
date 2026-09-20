// 账号相关路由：注册、登录、登出
const express = require('express');
const { getDb } = require('./db');
const { hashPassword, verifyPassword } = require('./utils/password');
const { setFlash } = require('./middleware');

const router = express.Router();

router.get('/register', (req, res) => res.render('register'));
router.get('/login', (req, res) => res.render('login'));

// FR-01 注册：用户名唯一；两次密码一致；角色合法
router.post('/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const role = String(req.body.role || '');

  if (!username || !password || !confirm) {
    setFlash(req, 'error', '请填写完整的注册信息');
    return res.redirect('/register');
  }
  if (password !== confirm) {
    setFlash(req, 'error', '两次输入的密码不一致');
    return res.redirect('/register');
  }
  if (!['student', 'teacher'].includes(role)) {
    setFlash(req, 'error', '请选择有效的用户角色');
    return res.redirect('/register');
  }
  const exists = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    setFlash(req, 'error', '用户名已存在，请更换');
    return res.redirect('/register');
  }
  getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), role);
  setFlash(req, 'success', '注册成功，请登录');
  res.redirect('/login');
});

// FR-02 登录：校验通过写会话，按角色跳转
router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    setFlash(req, 'error', '用户名或密码错误');
    return res.redirect('/login');
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect(user.role === 'teacher' ? '/teacher' : '/student');
});

// FR-04 退出登录
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// FR-03 修改密码处理器（学生/教师个人中心 POST 复用）
function changePassword(req, res) {
  const current = String(req.body.current || '');
  const next = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  if (!verifyPassword(current, user.password_hash)) {
    setFlash(req, 'error', '当前密码不正确');
    return res.redirect('back');
  }
  if (!next || next !== confirm) {
    setFlash(req, 'error', '两次输入的新密码不一致');
    return res.redirect('back');
  }
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(next), user.id);
  setFlash(req, 'success', '密码修改成功');
  res.redirect('back');
}
router.changePassword = changePassword;

module.exports = router;
