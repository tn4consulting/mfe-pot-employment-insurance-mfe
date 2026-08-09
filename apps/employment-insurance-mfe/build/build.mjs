// Production/development build for the React employment-insurance
// remote. Replaces the `@angular-architects/native-federation:build`
// executor. Same shape as job-bank's/life-events' own
// build.mjs -- this app is a plain federation remote (not a host), so it
// needs both a federation build (for `./Component` and
// `./EiReportingStatusWidget`) and a standalone build (direct,
// non-federated access) -- see job-bank's build.mjs for the fuller story
// on why these are two genuinely separate esbuild invocations.
import { runEsBuildBuilder } from '@softarc/native-federation-esbuild';
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

const dev = process.argv.includes('--dev');
const outputPath = 'dist/apps/employment-insurance-mfe/browser';

await rm(outputPath, { recursive: true, force: true });
await mkdir(outputPath, { recursive: true });

await cp('apps/employment-insurance-mfe/public', outputPath, { recursive: true });
await cp('apps/employment-insurance-mfe/src/index.html', join(outputPath, 'index.html'));
await cp(require.resolve('es-module-shims'), join(outputPath, 'es-module-shims.js'));

// Deliberately NOT using @softarc/native-federation-esbuild's built-in
// `reactFrameworkPlugin()` wholesale -- see job-bank's build.mjs for the
// full explanation (stale React-19 file-replacement map).
// `needsCommonJsPlugin: true` keeps the shared react/react-dom chunks'
// CJS-interop working without it.
//
// `dev: true` here even in a production build -- deliberately NOT `dev`
// (the CLI-flag-derived value used below for the standalone bundle).
// This step's own minification is broken: confirmed the hard way
// (mfe-pot-shell, same underlying tooling) that a MINIFIED shared react.js
// chunk crashes at runtime ("TypeError: ... is not a function", every
// named React import resolving to `undefined`) while the default export
// stays correctly populated -- esbuild's minifier tree-shakes away the
// CJS module body `@chialab/esbuild-plugin-commonjs`'s named-export
// extraction depends on. `node-modules-bundler.js` hardcodes
// `minify: !dev` with no independent minify-only control, so the
// resulting `-dev.js`-suffixed filename on these specific vendor chunks
// (react.js, react-dom.js) is a cosmetic side effect of reusing the `dev`
// flag for this, not a sign anything else is running in dev mode -- this
// app's own standalone bundle below is still fully minified.
const result = await runEsBuildBuilder('apps/employment-insurance-mfe/federation.config.mjs', {
  workspaceRoot: process.cwd(),
  outputPath,
  tsConfig: 'apps/employment-insurance-mfe/tsconfig.federation.json',
  packageJson: 'package.json',
  dev: true,
  watch: false,
  adapterConfig: {
    plugins: [],
    frameworks: [{ needsCommonJsPlugin: true }],
  },
});
await result.close();

await esbuild.build({
  entryPoints: ['apps/employment-insurance-mfe/src/main.tsx'],
  outfile: join(outputPath, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  minify: !dev,
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
});

console.log(`employment-insurance-mfe built to ${outputPath} (${dev ? 'development' : 'production'})`);
