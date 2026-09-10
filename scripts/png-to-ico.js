#!/usr/bin/env node

/**
 * Convert PNG to ICO using to-ico
 */

import toIcoPkg from 'to-ico';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const toIco = toIcoPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pngPath = path.join(__dirname, '..', 'build', 'icon.png');
const icoPath = path.join(__dirname, '..', 'build', 'icon.ico');

(async () => {
  try {
    const pngBuffer = fs.readFileSync(pngPath);
    const icoBuffer = await toIco([pngBuffer]);
    fs.writeFileSync(icoPath, icoBuffer);

    console.log(`✓ Converted ${pngPath} → ${icoPath}`);
  } catch (err) {
    console.error('✗ Conversion failed:', err.message);
    process.exit(1);
  }
})();
