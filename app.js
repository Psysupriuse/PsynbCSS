// 校园活动管理系统 V1.0 入口（占位，后续任务逐步完善）
const express = require('express');
const path = require('node:path');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// 登录/注册页面（业务逻辑 Task 3 实现）
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

// 占位首页
app.get('/', (req, res) => res.send('<h1>校园活动管理系统 V1.0 开发中</h1>'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`校园活动管理系统已启动: http://localhost:${PORT}`));
