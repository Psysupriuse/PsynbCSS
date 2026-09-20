// 登录与角色校验中间件
function requireLogin(req, res, next) {
  if (req.session.user) return next();
  return res.redirect('/login');
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session.user && req.session.user.role === role) return next();
    return res.status(403).render('403', { message: '没有权限访问该页面' });
  };
}

// 一次性操作提示：写入会话，下一次请求的视图读取后清除
function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

module.exports = {
  requireLogin,
  requireStudent: requireRole('student'),
  requireTeacher: requireRole('teacher'),
  setFlash,
};
