import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const nodeDirectory = dirname(process.execPath);
const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
if (current.status !== 0 && !current.stderr.includes('no crontab')) throw new Error(current.stderr);
const line = `@reboot PATH=${nodeDirectory}:/usr/bin:/bin ${resolve(nodeDirectory, 'pm2')} resurrect >/dev/null 2>&1 # bzshow-icloud-sync`;
const lines = (current.stdout || '').split('\n').filter(x => x && !x.endsWith('# bzshow-icloud-sync'));
const result = spawnSync('crontab', ['-'], { input: [...lines, line, ''].join('\n'), encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr);
console.log('Server reboot recovery installed');
