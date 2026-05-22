<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/a519c4d2-7c10-450a-97a9-6f7c8c71a79b

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `OPENROUTER_API_KEY` in [.env.local](.env.local) to your OpenRouter API key
3. Optionally set `OPENROUTER_MODEL` to the model name you want to use (default: `gpt-4.1-mini`).
4. Run the app:
   `npm run dev`

Optional: Use OpenRouter via API key instead of Gemini OAuth

- Set `OPENROUTER_API_KEY` in your environment or in `.env.local`.
- Optionally set `OPENROUTER_MODEL` to select the OpenRouter model you want to use
  (default: `gpt-4.1-mini`).
- The app sends AI prompts through OpenRouter to generate autonomous Linux
  operations plans and diagnostics.

Notes:
- The app now persists user-added server connection data in an encrypted SQLite
  database file (`.linux_ai_ops.sqlite3` by default).
- New servers created via the UI are stored with their connection metadata,
  including encrypted password or private key when provided.
- For production, keep `OPENROUTER_API_KEY` secret and do not commit it to source
  control.
- The app falls back to a simulated AI mode if `OPENROUTER_API_KEY` is not configured.

The server does not use Google OAuth anymore; it relies on OpenRouter API key
configuration for model-driven agent generation.
