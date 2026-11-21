import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { build } from 'vite';
import electron from 'electron';
import { buildMain } from './build.mjs';

if (!existsSync('native/bin/window-capture.exe')) throw new Error('Run npm run build:native first.');
await Promise.all([buildMain(), build()]);
const child = spawn(electron, ['.'], { stdio: 'inherit' });
process.once('SIGINT', () => child.kill());
child.on('exit', code => { process.exitCode = code ?? 1; });
