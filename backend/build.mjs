// Bundles each Lambda into one file under dist/. dist is committed so deploys need no build step.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};

await build({ ...common, entryPoints: ['src/guest-entry.mjs'], outfile: 'dist/guest/index.mjs' });
await build({ ...common, entryPoints: ['src/host-entry.mjs'], outfile: 'dist/host/index.mjs' });
console.log('built dist/guest and dist/host');
