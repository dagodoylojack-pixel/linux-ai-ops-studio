#!/usr/bin/env node

/**
 * Generate app icon from a minimal embedded PNG
 * Outputs: build/icon.png and build/icon.ico (minimal placeholder)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(__dirname, '..', 'build');

// Ensure build directory exists
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

// Minimal 64x64 PNG with gradient (emerald to blue) — base64 encoded
// This is a 64x64 RGB PNG with a simple gradient
const iconPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA0klEQVR4nO3QMQrCQBCG4QkKFhYWFha2tLAQsRLFRrRUsbEQxUaxN7ERRF8guOFxwpEEltl/fnZmZ3ZnZufKzMzMzMzMzMzMzMzM/MWq+nJVX1V1W1V3VfXxvu/fbdsOQRD8p27bpnVdk2XZ+Hw+H2maBkEQBMHPlWVZO51O3xUKhQL7/R7b7RbH4xG73Q7n85nH45HH4/FHhWLhnuMYhrHSNI0YhoHjOKRpymg04vV68Xq98Hq94nQ6cTqdqNfrQhAEQRAEQRAEQRAEQRAEQRAEQRAEQRAEQRD8gG63K4QQRJEXX5+CIAiCIAi+wRc4eCMsC/WzpQAAAABJRU5ErkJggg==';

const iconPngPath = path.join(buildDir, 'icon.png');
const iconIcoPath = path.join(buildDir, 'icon.ico');

try {
  // Write PNG
  fs.writeFileSync(iconPngPath, Buffer.from(iconPngBase64, 'base64'));
  console.log(`✓ Generated ${iconPngPath}`);

  // For ICO, we'll use the same PNG base64 but save as .ico
  // (electron-builder can convert .png to .ico automatically, but we'll provide both)
  fs.writeFileSync(iconIcoPath, Buffer.from(iconPngBase64, 'base64'));
  console.log(`✓ Generated ${iconIcoPath}`);

  console.log('✓ Icons generated successfully');
  process.exit(0);
} catch (err) {
  console.error('✗ Failed to generate icons:', err);
  process.exit(1);
}
