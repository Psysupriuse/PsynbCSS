// 校园活动管理系统 V1.0 入口
const express = require('express');
const session = require('express-session');
const path = require('node:path');
const crypto = require('node:crypto');
const { initDb } = require('./db');
const authRouter = require('./auth');
const studentRouter = require('./routes/student');
const teacherRouter = require('./routes/teacher');
const { requireLogin, requireStudent, requireTeacher } = require('./middleware');

initDb();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
// 会话：密钥优先取环境变量，否则随机生成（重启后需重新登录）
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true },
}));

// 注入一次性提示与当前登录用户到所有视图
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  res.locals.currentUser = req.session.user || null;
  next();
});

app.use('/', authRouter);

// 根路径按登录状态与角色跳转
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect(req.session.user.role === 'teacher' ? '/teacher' : '/student');
});

// 学生/教师路由：登录 + 角色双重校验（NFR-01 权限隔离）
app.use('/student', requireLogin, requireStudent, studentRouter);
app.use('/teacher', requireLogin, requireTeacher, teacherRouter);

// 404 与统一错误处理
app.use((req, res) => res.status(404).render('404'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`校园活动管理系统已启动: http://localhost:${PORT}`));
