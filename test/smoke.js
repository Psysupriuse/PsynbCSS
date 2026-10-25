// 冒烟验证（V3.0）：回归 V1.0/V2.0 核心链路，并覆盖站内消息、筛选排序、提交防重、移动端适配
// 运行前提：npm start 已启动；运行方式：npm run smoke
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.BASE_URL || 'http://localhost:3000';

function makeClient() {
  let cookie = '';
  return {
    async request(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: body ? new URLSearchParams(body).toString() : undefined,
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return res;
    },
  };
}

function check(ok, message) {
  if (!ok) {
    console.error(`✘ 失败: ${message}`);
    process.exit(1);
  }
  console.log(`✔ ${message}`);
}

async function findActivityId(client, title) {
  const text = await (await client.request('GET', '/student')).text();
  const match = text.match(new RegExp(title + '[\\s\\S]*?href="/student/activities/(\\d+)"'));
  if (!match) throw new Error('未找到活动：' + title);
  return Number(match[1]);
}

async function main() {
  const suffix = Date.now();
  const teacher = makeClient();
  const student = makeClient();
  const student2 = makeClient();
  const futureTime = '2027-01-01 10:00';

  // 1. 注册与登录（FR-01/02）
  let res = await teacher.request('POST', '/register', {
    username: `tea_${suffix}`, password: 'pass123', confirm: 'pass123', role: 'teacher',
  });
  check(res.status === 302, '教师注册成功');
  res = await student.request('POST', '/register', {
    username: `stu_${suffix}`, password: 'pass123', confirm: 'pass123', role: 'student',
  });
  check(res.status === 302, '学生注册成功');
  res = await teacher.request('POST', '/login', { username: `tea_${suffix}`, password: 'pass123' });
  check(res.status === 302 && res.headers.get('location') === '/teacher', '教师登录跳转 /teacher');
  res = await student.request('POST', '/login', { username: `stu_${suffix}`, password: 'pass123' });
  check(res.status === 302 && res.headers.get('location') === '/student', '学生登录跳转 /student');

  // 2. 教师创建普通活动（FR-09）
  const normalTitle = `冒烟测试活动_${suffix}`;
  res = await teacher.request('POST', '/teacher/activities/new', {
    title: normalTitle, time: futureTime, location: '测试场地',
    description: '冒烟测试用活动', max_participants: '1',
  });
  check(res.status === 302, '教师创建活动成功');
  const activityId = await findActivityId(student, normalTitle);

  // 3. 报名与候补：普通活动直接通过；满员后进入候补
  res = await student.request('POST', `/student/activities/${activityId}/register`, {});
  check(res.status === 302, '学生报名请求被接受');
  let text = await (await student.request('GET', `/student/activities/${activityId}`)).text();
  check(text.includes('已通过'), '普通活动报名后显示已通过');
  res = await student.request('POST', `/student/activities/${activityId}/register`, {});
  text = await (await student.request('GET', `/student/activities/${activityId}`)).text();
  check(text.includes('不可重复报名'), '重复报名被拒绝');

  res = await student2.request('POST', '/register', {
    username: `stu2_${suffix}`, password: 'pass123', confirm: 'pass123', role: 'student',
  });
  res = await student2.request('POST', '/login', { username: `stu2_${suffix}`, password: 'pass123' });
  res = await student2.request('POST', `/student/activities/${activityId}/register`, {});
  text = await (await student2.request('GET', `/student/activities/${activityId}`)).text();
  check(text.includes('候补中'), '满员后报名自动进入候补');
  res = await student2.request('POST', `/student/activities/${activityId}/leave-waitlist`, {});
  text = await (await student2.request('GET', `/student/activities/${activityId}`)).text();
  check(text.includes('加入候补') && !text.includes('候补中'), '候补学生可退出候补');
  res = await student2.request('POST', `/student/activities/${activityId}/waitlist`, {});
  text = await (await student2.request('GET', `/student/activities/${activityId}`)).text();
  check(text.includes('候补中'), '退出后重新加入候补');

  // 4. 教师名单包含报名学生与候补学生（FR-12）
  text = await (await teacher.request('GET', `/teacher/activities/${activityId}/roster`)).text();
  check(text.includes(`stu_${suffix}`) && text.includes(`stu2_${suffix}`), '教师名单包含报名与候补学生');

  // 5. 取消报名并自动递补候补
  res = await student.request('POST', `/student/activities/${activityId}/cancel`, {});
  text = await (await student2.request('GET', `/student/activities/${activityId}`)).text();
  check(text.includes('已通过') && !text.includes('候补中'), '取消报名后候补学生自动递补');

  // 6. 需审核活动：报名进入待确认，教师通过后状态变化
  const reviewTitle = `冒烟审核活动_${suffix}`;
  res = await teacher.request('POST', '/teacher/activities/new', {
    title: reviewTitle, time: futureTime, location: '测试场地', description: '审核活动',
    max_participants: '1', needs_review: '1', requirement: '仅限大二学生',
  });
  check(res.status === 302, '教师创建需审核活动成功');
  const reviewId = await findActivityId(student2, reviewTitle);
  res = await student2.request('POST', `/student/activities/${reviewId}/register`, {});
  text = await (await student2.request('GET', `/student/activities/${reviewId}`)).text();
  check(text.includes('待确认'), '需审核活动报名后显示待确认');
  let roster = await (await teacher.request('GET', `/teacher/activities/${reviewId}/roster`)).text();
  let regMatch = roster.match(new RegExp(`stu2_${suffix}[\\s\\S]*?name="registration_id" value="(\\d+)"`));
  check(regMatch !== null, '名单页出现待确认学生的审核表单');
  res = await teacher.request('POST', `/teacher/activities/${reviewId}/review`, {
    registration_id: regMatch[1], action: 'reject',
  });
  check(res.status === 302, '教师拒绝报名');
  text = await (await student2.request('GET', `/student/activities/${reviewId}`)).text();
  check(text.includes('未通过') && text.includes('重新报名'), '未通过后学生可重新报名');
  res = await student2.request('POST', `/student/activities/${reviewId}/register`, {});
  roster = await (await teacher.request('GET', `/teacher/activities/${reviewId}/roster`)).text();
  regMatch = roster.match(new RegExp(`stu2_${suffix}[\\s\\S]*?name="registration_id" value="(\\d+)"`));
  check(regMatch !== null, '重新报名后再次进入待确认');
  res = await teacher.request('POST', `/teacher/activities/${reviewId}/review`, {
    registration_id: regMatch[1], action: 'approve',
  });
  check(res.status === 302, '教师通过报名');
  text = await (await student2.request('GET', `/student/activities/${reviewId}`)).text();
  check(text.includes('已通过'), '通过后学生详情显示已通过');

  // 7. 权限隔离（NFR-01）：学生不能访问教师/管理员页面
  res = await student.request('GET', '/teacher');
  check(res.status === 403, '学生访问教师后台返回 403');
  res = await student.request('GET', `/teacher/activities/${activityId}/roster`);
  check(res.status === 403, '学生访问名单页返回 403');
  res = await student.request('GET', '/admin');
  check(res.status === 403, '学生访问管理员后台返回 403');
  res = await teacher.request('GET', '/admin');
  check(res.status === 403, '教师访问管理员后台返回 403');

  // 8. 管理员：登录、查看页面、停用/恢复账号（停用后无法登录）
  const admin = makeClient();
  res = await admin.request('POST', '/login', { username: 'admin', password: 'admin123456' });
  check(res.status === 302 && res.headers.get('location') === '/admin', '管理员登录跳转 /admin');
  text = await (await admin.request('GET', '/admin/activities')).text();
  check(text.includes('活动监督'), '管理员活动监督页可访问');
  const stu3 = makeClient();
  res = await stu3.request('POST', '/register', {
    username: `stu3_${suffix}`, password: 'pass123', confirm: 'pass123', role: 'student',
  });
  check(res.status === 302, '注册待停用学生');
  const usersText = await (await admin.request('GET', '/admin/users')).text();
  const userMatch = usersText.match(new RegExp(`stu3_${suffix}[\\s\\S]*?action="/admin/users/(\\d+)/toggle"`));
  check(userMatch !== null, '管理员用户列表包含新学生');
  const userId = userMatch[1];
  res = await admin.request('POST', `/admin/users/${userId}/toggle`, {});
  check(res.status === 302, '管理员停用账号');
  res = await stu3.request('POST', '/login', { username: `stu3_${suffix}`, password: 'pass123' });
  res = await stu3.request('GET', '/student');
  check(res.status === 302 && res.headers.get('location') === '/login', '停用账号无法登录');

  // 9. 教师删除活动后学生端不可见（FR-11）
  res = await teacher.request('POST', `/teacher/activities/${activityId}/delete`, {});
  check(res.status === 302, '教师删除活动成功');
  text = await (await student.request('GET', '/student')).text();
  check(!text.includes(normalTitle), '删除后学生端不再显示该活动');

  // ---- V3.0 新增断言 ----

  // 10. 活动列表筛选与排序（FR-V3-02）
  const filterTitle = `冒烟筛选活动_${suffix}`;
  res = await teacher.request('POST', '/teacher/activities/new', {
    title: filterTitle, time: futureTime, location: '筛选场地', description: '筛选测试',
    max_participants: '1', category: '体育健康',
  });
  check(res.status === 302, '教师创建带类型的活动成功');
  const filterId = await findActivityId(student, filterTitle);

  text = await (await student.request('GET', `/student?category=${encodeURIComponent('体育健康')}`)).text();
  check(text.includes(filterTitle), '按活动类型筛选可命中目标活动');
  text = await (await student.request('GET', `/student?category=${encodeURIComponent('科技创新')}`)).text();
  check(!text.includes(filterTitle), '按其他类型筛选不命中目标活动');
  text = await (await student.request('GET', `/student?sort=slots`)).text();
  check(text.includes(filterTitle), '按剩余名额排序列表正常返回');
  text = await (await student.request('GET', '/student?time=weekend')).text();
  check(text.includes('校园活动'), '按周末筛选页面正常渲染');
  text = await (await student.request('GET', '/student')).text();
  check(text.includes('重置') && text.includes('全部类型'), '筛选表单包含类型选项与重置入口');

  // 11. 站内消息（FR-V3-01）：报名/候补/递补/审核均产生消息，未读数与已读生效
  text = await (await student.request('GET', '/messages')).text();
  check(text.includes('报名成功'), '报名成功后消息页有对应消息');
  let navText = await (await student.request('GET', '/student')).text();
  check(/消息\s*<span class="nav-badge">\d+<\/span>/.test(navText), '导航栏显示未读消息数徽标');
  res = await student.request('POST', '/messages/read-all', {});
  check(res.status === 302, '全部标为已读');
  navText = await (await student.request('GET', '/student')).text();
  check(!navText.includes('nav-badge'), '已读后导航栏不再显示未读徽标');

  // 候补递补产生的消息（先占满名额，再让学生2候补，学生取消后递补）
  res = await student.request('POST', `/student/activities/${filterId}/register`, {});
  text = await (await student.request('GET', `/student/activities/${filterId}`)).text();
  check(text.includes('已通过'), '筛选活动报名后显示已通过');
  res = await student2.request('POST', `/student/activities/${filterId}/register`, {});
  text = await (await student2.request('GET', `/student/activities/${filterId}`)).text();
  check(text.includes('候补中'), '名额满后第二个学生进入候补');
  res = await student.request('POST', `/student/activities/${filterId}/cancel`, {});
  text = await (await student2.request('GET', '/messages')).text();
  check(text.includes('候补转正'), '候补递补后学生收到站内消息');

  // 12. 报名提交防重复点击（FR-V3-03）：详情页表单带 js-submitting，main.js 负责禁用按钮
  text = await (await student.request('GET', `/student/activities/${filterId}`)).text();
  check(text.includes('js-submitting') && text.includes('加入候补'), '详情页报名类表单带防重复提交标记');
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  check(mainJs.includes('js-submitting') && mainJs.includes('disabled'), '前端脚本在提交期间禁用按钮');

  // 13. 已结束活动报名被明确拒绝（FR-V3-03：失败必须说明原因）
  const pastTitle = `冒烟已结束活动_${suffix}`;
  res = await teacher.request('POST', '/teacher/activities/new', {
    title: pastTitle, time: '2020-01-01 10:00', location: '测试场地',
    description: '已结束', max_participants: '5', category: '校园服务',
  });
  check(res.status === 302, '教师创建已结束活动成功');
  const pastId = await findActivityId(student, pastTitle);
  res = await student.request('POST', `/student/activities/${pastId}/register`, {});
  check(res.status === 302 && res.headers.get('location') === `/student/activities/${pastId}`, '已结束活动报名请求被拒绝');
  text = await (await student.request('GET', `/student/activities/${pastId}`)).text();
  check(text.includes('已结束，无法报名'), '已结束活动提示明确说明原因');

  // 14. 移动端适配（FR-V3-04）：样式含窄屏断点，表格改为卡片堆叠
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  check(css.includes('max-width: 768px'), '样式表包含 768px 移动端断点');
  const myText = await (await student.request('GET', '/student/my')).text();
  check(myText.includes('data-label'), '我的报名表格带移动端堆叠所需 data-label');

  console.log('\n全部验证通过 ✔ V3.0 核心业务流程跑通');
}
main().catch((err) => {
  console.error(`✘ 异常: ${err.message}`);
  process.exit(1);
});
