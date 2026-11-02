import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const label = 'ru.bazabzshow.icloud-sync';
const root = resolve(import.meta.dirname, '..');
const agentsDir = join(homedir(), 'Library/LaunchAgents');
const target = join(agentsDir, `${label}.plist`);
const port = Number(process.env.PORT || 8766);

if (process.platform !== 'darwin') throw new Error('Автозапуск поддерживается только на macOS');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Неверный PORT');

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, 'src/server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PORT</key><string>${port}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(join(root, 'runtime/server.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, 'runtime/server-error.log'))}</string>
</dict></plist>
`;

await mkdir(agentsDir, { recursive: true });
await mkdir(join(root, 'runtime'), { recursive: true });
const uid = process.getuid();
spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
await writeFile(target, plist, { mode: 0o600 });
let result;
for (let attempt = 0; attempt < 8; attempt++) {
  result = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, target], { encoding: 'utf8' });
  if (result.status === 0) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (result.status !== 0) throw new Error(result.stderr.trim() || 'Не удалось включить автозапуск');
console.log(`Установлено для пользователя ${homedir()}: http://127.0.0.1:${port}`);
