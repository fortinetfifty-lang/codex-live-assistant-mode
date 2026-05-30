# Windows Codex Notification Workaround

Some Codex Desktop builds on Windows can show an Electron dialog when an old
Codex toast notification is clicked:

```text
Error launching app
Unable to find Electron app at C:\Program Files\WindowsApps\OpenAI.Codex_...\type=click&tag=...
Cannot find module 'C:\Program Files\WindowsApps\OpenAI.Codex_...\type=click&tag=...'
```

This is a Codex Desktop / Windows toast activation issue. It is not caused by
Codex Live Assistant Mode reading credentials, leaking data, or launching that
WindowsApps path directly.

## What this app does

The local bridge starts its own Codex CLI child processes with desktop
notifications disabled:

```text
desktop.notifications-turn-mode="never"
desktop.notifications-permissions-enabled=false
desktop.notifications-questions-enabled=false
```

That prevents bridge-created Codex turns from creating the problematic toast
notifications.

## If old notifications still crash

Old global Codex Desktop notifications may still exist in Windows Notification
Center, or Codex Desktop itself may still be configured to create new
notifications outside this bridge. If clicking a notification still opens the
Electron error dialog:

1. Clear existing Codex notifications from Windows Notification Center.
2. Restart Codex Desktop.
3. Temporarily disable Codex Desktop notifications in your local Codex config:

```toml
[desktop]
notifications-turn-mode = "never"
notifications-permissions-enabled = false
notifications-questions-enabled = false
```

This is a local workaround only. Restore your previous notification settings if
you want Codex Desktop notifications back after the upstream issue is fixed.

