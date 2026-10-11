// 报名记录状态展示映射（V2.0 新增：报名状态不落字典，仅做展示映射）
const STATUS_MAP = {
  pending: { label: '待确认', color: 'warning' },
  approved: { label: '已通过', color: 'success' },
  rejected: { label: '未通过', color: 'danger' },
  waiting: { label: '候补中', color: 'info' },
  cancelled: { label: '已取消', color: 'secondary' },
};

function getRegistrationStatus(status) {
  return STATUS_MAP[status] || { label: status || '未知', color: 'secondary' };
}

module.exports = { getRegistrationStatus };
