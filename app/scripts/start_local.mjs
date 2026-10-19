// Local-only launcher. Production retains Wardrowbe's original deployment path.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = resolve(root, 'backend/.venv/bin/python');
if (!existsSync(python) || !existsSync(resolve(root, 'frontend/node_modules/next'))) {
  console.error('运行环境尚未安装，请按工作区 README 中的初始化步骤操作。');
  process.exit(1);
}
const envPath = resolve(root, 'frontend/.env.local');
if (!existsSync(envPath)) {
  writeFileSync(envPath, [
    'AIYI_LOCAL_WORKSPACE=true',
    'BACKEND_URL=http://127.0.0.1:8000',
    'DEV_MODE=true',
    'NEXTAUTH_URL=http://127.0.0.1:3000',
    `NEXTAUTH_SECRET=${randomBytes(32).toString('hex')}`,
    'NEXT_TELEMETRY_DISABLED=1',
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(envPath, 0o600);
}
for (const url of ['http://127.0.0.1:8000/api/v1/health', 'http://127.0.0.1:3000']) {
  try {
    await fetch(url, {signal: AbortSignal.timeout(1000)});
    console.error(`端口已有服务运行：${url}。若是爱衣橱，可以直接在浏览器打开；否则先结束占用端口的服务。`);
    process.exit(1);
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      console.error(`端口可能已有其他服务：${url}，请确认后再启动。`);
      process.exit(1);
    }
  }
}
const children = [
  spawn(python, ['scripts/start_backend.py'], {cwd: root, stdio: 'inherit'}),
  spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3000'], {
    cwd: resolve(root, 'frontend'), stdio: 'inherit', env: {...process.env, NEXT_TELEMETRY_DISABLED: '1'},
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) {
  child.on('error', error => {console.error(error.message); stop(1);});
  child.on('exit', code => {if (!stopping) stop(code || 1);});
}
console.log('\n爱衣橱本地框架正在启动。就绪后打开 http://127.0.0.1:3000\n按 Ctrl+C 同时停止网页与后端服务。\n');
