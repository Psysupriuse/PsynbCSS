// ============================================================
// Psy剪贴板 — 启动器
// 宿主环境(VSCode 等工具链)可能设置 ELECTRON_RUN_AS_NODE=1,
// 会让 Electron 以纯 Node 模式运行导致 app 未定义。
// 这里在启动前清除该变量,并直接调用 Electron 二进制。
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 读取 electron 包记录的二进制路径(与 electron 包 cli 逻辑一致)
const pathTxt = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
const electronExe = path.join(path.dirname(pathTxt), 'dist', fs.readFileSync(pathTxt, 'utf8').trim());

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 关键修复

const child = spawn(electronExe, ['.'], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code));
