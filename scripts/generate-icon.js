#!/usr/bin/env node

/**
 * Generate 256x256 PNG app icon with gradient
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(__dirname, '..', 'build');
const iconPngPath = path.join(buildDir, 'icon.png');

// Ensure build directory exists
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

(async () => {
  try {
    // Create 256x256 gradient image (emerald to blue)
    // SVG is the simplest way to create a gradient
    const svg = `
      <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#059669;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#2563eb;stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="256" height="256" fill="url(#grad)"/>
        <circle cx="128" cy="128" r="60" fill="rgba(255,255,255,0.2)"/>
        <circle cx="128" cy="128" r="40" fill="rgba(255,255,255,0.3)"/>
      </svg>
    `;

    await sharp(Buffer.from(svg))
      .png()
      .toFile(iconPngPath);

    console.log(`✓ Generated 256x256 PNG icon at ${iconPngPath}`);
    process.exit(0);
  } catch (err) {
    console.error('✗ Failed to generate icon:', err.message);
    process.exit(1);
  }
})();
