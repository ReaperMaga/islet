// Bundles the extension host code and the two webviews into dist/.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: {
      sidebar: 'src/webview/sidebar/main.ts',
      detail: 'src/webview/detail/main.ts',
      // Browser-only fake host for the dev/ preview pages; never loaded inside VS Code.
      mock: 'src/webview/mock/main.ts',
    },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    loader: { '.svg': 'text' },
  },
];

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
