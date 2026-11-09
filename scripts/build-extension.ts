import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist-extension');

async function buildExtension() {
  fs.mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [
      path.join(rootDir, 'extension/content.ts'),
      path.join(rootDir, 'extension/popup.ts'),
    ],
    outdir: outDir,
    bundle: true,
    format: 'iife',
    target: ['chrome114', 'firefox115'],
    minify: false,
  });

  fs.copyFileSync(
    path.join(rootDir, 'extension/manifest.json'),
    path.join(outDir, 'manifest.json')
  );
  fs.copyFileSync(
    path.join(rootDir, 'extension/popup.html'),
    path.join(outDir, 'popup.html')
  );

  fs.cpSync(path.join(rootDir, 'extension/icons'), path.join(outDir, 'icons'), { recursive: true });

  console.log('Built glogg Manifest V3 extension into dist-extension/');
}

buildExtension().catch((err) => {
  console.error(err);
  process.exit(1);
});
