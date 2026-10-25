// 站内消息（V3.0 FR-V3-01）：报名/候补/审核结果变化时通知学生
const { getDb } = require('../db');

// 写入一条站内消息；activityId 可为空（与具体活动无关的消息）
function createMessage(userId, content, activityId = null) {
  getDb().prepare('INSERT INTO messages (user_id, activity_id, content) VALUES (?, ?, ?)')
    .run(userId, activityId, content);
}

// 未读消息数（导航徽标用）
function unreadCount(userId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND is_read = 0').get(userId).c;
}

// 消息列表（按时间倒序，新的在前）
function listMessages(userId) {
  return getDb().prepare(`
    SELECT m.*, a.title AS activity_title
    FROM messages m
    LEFT JOIN activities a ON a.id = m.activity_id
    WHERE m.user_id = ?
    ORDER BY m.id DESC
    LIMIT 100`).all(userId);
}

function markAllRead(userId) {
  getDb().prepare('UPDATE messages SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
}

module.exports = { createMessage, unreadCount, listMessages, markAllRead };
