/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Preload script — minimal sandbox bridge.
 * The UI runs as a regular SPA served by Express, no special IPC needed.
 */

// Intentionally minimal — all functionality goes through the Express server
console.log('[Preload] Sandbox enabled, renderer process ready');
