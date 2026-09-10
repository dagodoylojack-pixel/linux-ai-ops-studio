#!/usr/bin/env node

/**
 * Prepare Electron build: stage dist/ and production node_modules
 * Runs after npm run build
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const stagingDir = path.join(projectRoot, 'release-resources');

console.log('[Prepare] Staging Electron build resources...');

try {
  // Remove old staging directory
  if (fs.existsSync(stagingDir)) {
    console.log(`[Prepare] Removing old ${stagingDir}`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  // Create staging directory
  fs.mkdirSync(stagingDir, { recursive: true });
  console.log(`[Prepare] Created ${stagingDir}`);

  // Copy package.json first (needed by npm ci)
  const packageJsonSrc = path.join(projectRoot, 'package.json');
  const packageJsonDst = path.join(stagingDir, 'package.json');
  fs.copyFileSync(packageJsonSrc, packageJsonDst);
  console.log(`[Prepare] Copied package.json`);

  // Copy dist/
  const distSrc = path.join(projectRoot, 'dist');
  const distDst = path.join(stagingDir, 'dist');
  if (fs.existsSync(distSrc)) {
    copyRecursive(distSrc, distDst);
    console.log(`[Prepare] Copied dist/ → release-resources/dist`);
  } else {
    throw new Error('dist/ not found. Run "npm run build" first.');
  }

  // Install production node_modules
  console.log('[Prepare] Installing production dependencies...');
  execSync('npm install --omit=dev --prefer-offline', {
    cwd: stagingDir,
    stdio: 'inherit',
  });
  console.log(`[Prepare] Installed production node_modules`);

  console.log('[Prepare] ✓ Staging complete');
  process.exit(0);
} catch (err) {
  console.error('[Prepare] ✗ Failed:', err.message);
  process.exit(1);
}

/**
 * Copy directory recursively
 */
function copyRecursive(src, dst) {
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
