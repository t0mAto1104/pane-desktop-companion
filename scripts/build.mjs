import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';

export async function buildMain() {
  await bundle({
    entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outdir: 'dist/main',
    outExtension: { '.js': '.cjs' },
    external: ['electron'],
    legalComments: 'linked',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await Promise.all([buildMain(), buildRenderer()]);
}
