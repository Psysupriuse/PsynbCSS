# 校园活动管理系统 V1.0

软件工程课程实验项目（基于工程意图的软件迭代开发实验）。Web 网站，蓝色系校园风格。

**解决的问题**：活动信息分散、Excel 手工统计报名效率低、报名无统一线上入口、用户身份无区分。V1.0 实现活动发布、浏览、报名的基础业务闭环。

## 技术栈

- Node.js v24（内置 node:sqlite 数据库、crypto.scrypt 密码哈希）
- Express 4 服务端渲染（EJS 模板）
- express-session 会话鉴权

## 角色

| 角色 | 权限 |
|---|---|
| 学生 | 浏览活动、查看详情、报名活动、查看我的报名、个人中心 |
| 教师 | 发布/编辑/删除自己的活动、查看报名名单、后台统计、个人中心 |

## 快速开始

```bash
npm install   # 安装依赖
npm start     # 启动服务，浏览器访问 http://localhost:3000
npm run smoke # 冒烟验证（需先启动服务）
```

演示账号（首次启动自动写入种子数据）：`teacher_demo / demo123456`

## 目录结构

```
app.js            入口：中间件、路由挂载、启动
db.js            SQLite 初始化、建表、种子数据
auth.js          注册/登录/登出/改密码路由
middleware.js    登录与角色校验中间件
routes/          学生端（student.js）、教师端（teacher.js）路由
utils/           密码哈希（password.js）、活动状态判定（activity-status.js）
views/           EJS 页面（student/ 学生端、teacher/ 教师端）
public/          静态资源（css/style.css 蓝色主题）
test/smoke.js    冒烟验证脚本
data/app.db      SQLite 数据文件（运行时生成，不入库）
devlog/          开发日志（每日记录）
docs/            标准文档（01需求/02技术设计/03设计规范/04执行步骤/05实现计划）
```

## 开发规范

- 按 `docs/04-开发执行步骤.md` 的 9 步迭代计划开发，每步独立 commit，提交历史反映系统逐步形成过程（`git log` 可查看）
- UI 配色与组件规范见 `docs/03-设计规范.md`
- 需求见 `docs/01-开发需求文档.md`，技术设计见 `docs/02-技术设计文档.md`
- AI 生成代码均经人工校验后提交

## V1.0 不实现（留给 V2.0）

活动审批、签到、评价、评论、图片上传、Excel 导出、管理员角色、短信邮件通知。
