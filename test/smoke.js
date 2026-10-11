// 冒烟验证（V2.0）：覆盖报名/审核/取消/候补/管理员，并回归 V1.0 核心链路
// 运行前提：npm start 已启动；运行方式：npm run smoke
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
  const roster = await (await teacher.request('GET', `/teacher/activities/${reviewId}/roster`)).text();
  const regMatch = roster.match(new RegExp(`stu2_${suffix}[\\s\\S]*?name="registration_id" value="(\\d+)"`));
  check(regMatch !== null, '名单页出现待确认学生的审核表单');
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

  console.log('\n全部验证通过 ✔ V2.0 核心业务流程跑通');
}

main().catch((err) => {
  console.error(`✘ 异常: ${err.message}`);
  process.exit(1);
});
