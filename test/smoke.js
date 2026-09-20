// 冒烟验证：对运行中的服务依次验证核心业务链路，任一步失败即报错退出
// 运行前提：npm start 已启动；运行方式：npm run smoke
const BASE = process.env.BASE_URL || 'http://localhost:3000';

// 带 cookie 的简易 HTTP 客户端（Node 24 内置 fetch）
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

async function main() {
  const suffix = Date.now(); // 用户名加时间戳，支持重复运行
  const teacher = makeClient();
  const student = makeClient();
  const student2 = makeClient();
  const futureTime = '2027-01-01 10:00';

  // 1. 注册教师与学生（FR-01）
  let res = await teacher.request('POST', '/register', {
    username: `tea_${suffix}`, password: 'pass123', confirm: 'pass123', role: 'teacher',
  });
  check(res.status === 302, '教师注册成功');
  res = await student.request('POST', '/register', {
    username: `stu_${suffix}`, password: 'pass123', confirm: 'pass123', role: 'student',
  });
  check(res.status === 302, '学生注册成功');

  // 2. 登录按角色跳转（FR-02）
  res = await teacher.request('POST', '/login', { username: `tea_${suffix}`, password: 'pass123' });
  check(res.status === 302 && res.headers.get('location') === '/teacher', '教师登录跳转 /teacher');
  res = await student.request('POST', '/login', { username: `stu_${suffix}`, password: 'pass123' });
  check(res.status === 302 && res.headers.get('location') === '/student', '学生登录跳转 /student');

  // 3. 教师创建活动（FR-09）
  res = await teacher.request('POST', '/teacher/activities/new', {
    title: `冒烟测试活动_${suffix}`, time: futureTime, location: '测试场地',
    description: '冒烟测试用活动', max_participants: '1',
  });
  check(res.status === 302, '教师创建活动成功');

  // 4. 学生端可见该活动（FR-05）
  res = await student.request('GET', '/student');
  const listText = await res.text();
  check(listText.includes(`冒烟测试活动_${suffix}`), '学生活动列表可见新活动');

  // 5. 学生报名成功；重复报名被拒（FR-07）
  // 从列表页提取新建活动的详情链接（标题卡片内的链接）
  const match = listText.match(new RegExp(`冒烟测试活动_${suffix}[\\s\\S]*?href="/student/activities/(\\d+)"`));
  check(match !== null, '能从列表页提取活动详情链接');
  const activityId = Number(match[1]);
  res = await student.request('POST', `/student/activities/${activityId}/register`, {});
  check(res.status === 302, '学生报名请求被接受');
  res = await student.request('GET', `/student/activities/${activityId}`);
  check((await res.text()).includes('已报名'), '详情页显示已报名');
  res = await student.request('POST', `/student/activities/${activityId}/register`, {});
  res = await student.request('GET', `/student/activities/${activityId}`);
  check((await res.text()).includes('不可重复报名'), '重复报名被拒绝');

  // 6. 满员拒绝（FR-07）：max_participants=1，第二个学生报名被拒
  res = await student2.request('POST', '/register', {
    username: `stu2_${suffix}`, password: 'pass123', confirm: 'pass123', role: 'student',
  });
  res = await student2.request('POST', '/login', { username: `stu2_${suffix}`, password: 'pass123' });
  res = await student2.request('POST', `/student/activities/${activityId}/register`, {});
  res = await student2.request('GET', `/student/activities/${activityId}`);
  check((await res.text()).includes('报名人数已满'), '满员报名被拒绝');

  // 7. 教师名单包含报名学生（FR-12）
  res = await teacher.request('GET', `/teacher/activities/${activityId}/roster`);
  check((await res.text()).includes(`stu_${suffix}`), '教师名单包含报名学生');

  // 8. 权限隔离（NFR-01）：学生访问教师后台 → 403
  res = await student.request('GET', '/teacher');
  check(res.status === 403, '学生访问教师后台返回 403');
  res = await student.request('GET', `/teacher/activities/${activityId}/roster`);
  check(res.status === 403, '学生访问名单页返回 403');

  // 9. 教师删除活动后学生端不可见（FR-11）
  res = await teacher.request('POST', `/teacher/activities/${activityId}/delete`, {});
  check(res.status === 302, '教师删除活动成功');
  res = await student.request('GET', '/student');
  check(!(await res.text()).includes(`冒烟测试活动_${suffix}`), '删除后学生端不再显示该活动');

  console.log('\n全部验证通过 ✔ 核心业务流程跑通');
}

main().catch((err) => {
  console.error(`✘ 异常: ${err.message}`);
  process.exit(1);
});
