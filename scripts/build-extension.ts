import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Deterministic, dependency-free PKZIP (DEFLATE) writer for extension packaging. */
export function createZipArchive(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const crc = zlib.crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(8, 8); // method 8 = deflate
    local.writeUInt16LE(0, 10); // mod time (deterministic 1980-01-01)
    local.writeUInt16LE(0x0021, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function collectFiles(baseDir: string, relDir = ''): ZipEntry[] {
  const out: ZipEntry[] = [];
  const fullDir = path.join(baseDir, relDir);
  for (const name of fs.readdirSync(fullDir).sort()) {
    if (name.endsWith('.zip')) continue;
    const relPath = relDir ? `${relDir}/${name}` : name;
    const fullPath = path.join(baseDir, relPath);
    if (fs.statSync(fullPath).isDirectory()) out.push(...collectFiles(baseDir, relPath));
    else out.push({ name: relPath, data: fs.readFileSync(fullPath) });
  }
  return out;
}

export async function buildExtension(outDir = path.join(rootDir, 'dist-extension')) {
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

  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version: string };
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'extension/manifest.json'), 'utf8')) as Record<string, unknown>;
  manifest.version = pkg.version;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  fs.copyFileSync(
    path.join(rootDir, 'extension/popup.html'),
    path.join(outDir, 'popup.html')
  );

  fs.cpSync(path.join(rootDir, 'extension/icons'), path.join(outDir, 'icons'), { recursive: true });

  const zipName = `glogg-extension-v${pkg.version}.zip`;
  const zipPath = path.join(outDir, zipName);
  for (const stale of fs.readdirSync(outDir).filter((f) => f.endsWith('.zip') && f !== zipName)) {
    fs.rmSync(path.join(outDir, stale), { force: true });
  }
  const zipBuf = createZipArchive(collectFiles(outDir));
  fs.writeFileSync(zipPath, zipBuf);

  console.log(`Built glogg Manifest V3 extension v${pkg.version} into dist-extension/ (${zipName}, ${(zipBuf.length / 1024).toFixed(1)} KB)`);
  return { version: pkg.version, zipPath, bytes: zipBuf.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildExtension().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
