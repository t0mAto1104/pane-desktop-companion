import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { build } from 'vite';
import electron from 'electron';
import { buildMain } from './build.mjs';

const mac = process.platform === 'darwin';
if (!existsSync(mac ? 'native/bin/macos/pane-native' : 'native/bin/window-capture.exe')) {
  throw new Error(mac ? 'Run npm run build:native:mac first.' : 'Run npm run build:native first.');
}
await Promise.all([buildMain(), build()]);
const child = spawn(electron, ['.'], { stdio: 'inherit' });
process.once('SIGINT', () => child.kill());
child.on('exit', code => { process.exitCode = code ?? 1; });
