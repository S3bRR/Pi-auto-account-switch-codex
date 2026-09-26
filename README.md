# Pi Codex Account Switcher

## About

A Pi extension for ordered, automatic failover between multiple authenticated ChatGPT Codex accounts. When the active account reaches a confirmed usage limit, the extension selects the next account and continues the same main-session task without adding a fake `continue` message, changing models, or replaying completed tool results.

Built for **Pi 0.87.1** and **Node.js 22+**.

## Install

```bash
pi install git:github.com/S3bRR/Pi-auto-account-switch-codex
```

If Pi is already open, run `/reload` once. For future updates:

```bash
pi update git:github.com/S3bRR/Pi-auto-account-switch-codex
```

Then run `/reload` in any Pi session that was already open.

## Set up

Existing Codex OAuth credentials in Pi are discovered automatically; reinstalling this extension does not delete or replace them.

1. Run `/accounts`.
2. Include the accounts that should participate and arrange their priority.
3. Choose **Save order**. A nonempty saved order enables automatic failover.
4. Select the account you want to use now.

Example order: **B → A → C**. If B reaches its usage limit, Pi tries A, then C. A configured Pi launch starts with the first usable account in the saved order. Startup does not open a blocking account prompt.

If an account is not already saved in Pi:

- `/connect` — add it through Pi's native browser OAuth.
- `/connect device` — add it through Pi's native device authorization.
- `/accounts import` — copy accounts already stored by OpenCode.

## Commands

| Command | Action |
|---|---|
| `/accounts` | Open the account picker; first use configures priority |
| `/accounts order` | Edit participating accounts and priority |
| `/accounts status` | Show the active account, order, and current-task availability |
| `/accounts <number\|full ID\|email substring>` | Switch immediately without changing priority |
| `/accounts auto on` | Enable the saved order |
| `/accounts auto off` | Disable automatic switching without deleting the order |
| `/accounts import` | Import OAuth accounts from OpenCode |
| `/accounts refresh` | Refresh the active account when needed |
| `/connect [browser\|device]` | Add and select a Codex account |

The footer abbreviates the current label to its first three characters; the picker keeps full labels so accounts remain distinguishable.

## How failover works

- Account selection is session-local, while Pi's canonical credential is updated under the same cross-process auth-file lock used by Pi.
- Every request is bound directly to the selected account's fresh bearer token. The outgoing `chatgpt-account-id` is checked before network I/O, preventing Pi from silently reusing pre-switch authentication.
- The extension uses Codex's SSE transport so structured quota responses can be inspected reliably. Quota metadata is isolated to the final HTTP attempt, preventing retries or concurrent requests from leaking an earlier quota code. Tokens and response bodies are never logged or persisted by the extension.
- Login and refresh delegate to Pi's native Codex OAuth implementation; the extension only preserves and selects the resulting per-account credentials.
- A structured `usage_limit_reached` response triggers failover. Pi's exact terminal WebSocket-style wording and long plan-reset message are supported as bounded fallbacks.
- Generic 429 responses, short request throttling, network/server failures, billing errors, context overflow, cancellation, and tool failures do not trigger an account switch.
- After switching, Pi omits only the failed assistant attempt from the next model projection and continues the same agent run. Existing transcript entries and completed tool results remain intact.
- Each user task has one bounded pass through the configured order. A new user prompt starts a fresh availability pass, so stale in-memory blocks do not disable accounts forever.
- If every configured account is unavailable, Pi stops with the session preserved.

Preferences are stored in `~/.pi/agent/codex-account.json`. OAuth credentials remain in Pi's `~/.pi/agent/auth.json`. Never commit either file or Pi session files.

## Limitations

Automatic continuation is implemented for the main Pi agent session. Independent subagent sessions, compaction requests, branch summaries, and standalone authentication commands do not inherit a guaranteed failover continuation. OpenAI may introduce new error formats that require an update. If all configured accounts are actually exhausted, no extension can continue until one becomes available.

The published repository contains the runtime source only. Before release, version 1.2.0 was typechecked and exercised in real Pi 0.87.1 processes with synthetic credentials covering successful continuation, consecutive exhausted accounts, all-account exhaustion, short throttling, manual mode, startup behavior, stale-token replacement, final-attempt quota isolation, native login and refresh delegation, and credential persistence. A native-path regression also runs through Pi's real model runtime, OAuth resolution, Codex SSE request builder/parser, account header, bearer identity, structured quota response, credential switch, and same-session continuation.
