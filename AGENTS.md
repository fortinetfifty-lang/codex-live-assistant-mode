# Project Instructions

This repository is intended to be public and English-only in code, docs, UI copy, commits, and issue templates.

## Product Boundaries

- Treat this as an unofficial local bridge for Codex CLI.
- Do not read, copy, transform, or expose Codex auth tokens.
- Keep the default server localhost-only.
- Keep Codex read-only unless a future task explicitly designs write-capable workspace mode.
- Do not commit `.env`, `.local/`, transcripts, provider keys, local logs, or Codex session files.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

## Verification

After UI or bridge changes, run `npm run typecheck` and `npm run build`. For UI changes, also inspect the app in a browser at `http://127.0.0.1:5173`.
