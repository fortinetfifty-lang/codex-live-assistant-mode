# Security Policy

## Supported Use

This project is designed for local use on `127.0.0.1`.

Do not expose the server directly to the public internet. If you run it on a VPS, put it behind authentication, TLS, firewall rules, and a private network boundary.

## Secrets

Never commit `.env`, OpenRouter API keys, Codex auth files, logs, transcripts, or local session data.

The app does not read Codex auth tokens. It only invokes the locally installed Codex CLI.

## Codex Bridge

The MVP uses read-only Codex execution by default. Future write-capable modes should be opt-in, visibly labeled, and protected by stronger workspace and command boundaries.

## Reporting Issues

For public repos, open a security advisory or private issue if the repository host supports it. Avoid posting secrets, logs with private transcripts, or local filesystem paths in public issues.
