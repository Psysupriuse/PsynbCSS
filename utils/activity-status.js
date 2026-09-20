// 活动状态判定与时间格式化（状态不落库，查询时计算）
function formatLocalTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

// 判定优先级：已结束 > 已满员 > 未开始（docs/02 第 4 节、docs/03 3.5）
function getActivityStatus(timeStr, currentCount, maxParticipants) {
  if (new Date(timeStr) <= new Date()) {
    return { key: 'ended', label: '已结束', color: 'warning' };
  }
  if (currentCount >= maxParticipants) {
    return { key: 'full', label: '已满员', color: 'danger' };
  }
  return { key: 'upcoming', label: '未开始', color: 'success' };
}

module.exports = { formatLocalTime, getActivityStatus };
