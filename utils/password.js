// scrypt 加盐密码哈希（Node 内置，无额外依赖）
const crypto = require('node:crypto');

// 生成 'salt:hash' 格式的密码哈希
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// 校验密码；格式不对或密码不符均返回 false
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
