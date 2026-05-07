import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/index.js',
  external: ['pg', 'pg-native'],
  sourcemap: true,
  minify: false,
  // Resolve .js imports to .ts sources (TypeScript ESM convention)
  plugins: [],
});

console.log('Build complete: dist/index.js');
