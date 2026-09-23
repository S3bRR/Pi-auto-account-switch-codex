# Pi CLI Codex Account Switcher

## About

Use multiple **already authenticated** ChatGPT Codex accounts in [Pi](https://pi.dev) without losing your current task when one reaches a confirmed usage limit. You choose the participating accounts and their priority; Pi continues in the same session on the next eligible account. No API-key/billing fallback, model downgrade, account creation, or dashboard scraping.

Built for **@earendil-works/pi-coding-agent 0.87.0** (Node 22+). Other Pi versions and live OpenAI error variants have not been verified; see [Limitations](#limitations).

## Install

```bash
pi install git:github.com/S3bRR/Pi-auto-account-switch-codex
```

This installs the package globally for normal Pi launches. If Pi is already open, run **`/reload` once** to load it; no reload is needed between account switches. To update after a new release, run `pi update --extensions` followed by `/reload` in an already-open Pi session. Do not install both this Git package and a separate local checkout at the same time; they register the same commands.

For a development checkout instead, run `npm ci` in the cloned repository and `pi install /absolute/path/to/checkout`. Pi references that directory directly, so Git-package updates will not change it. Remove a previously installed copy with `pi remove <same-source>` before switching installation sources.

## Set up and use

**Already connected? No need to sign in again.** `/accounts` automatically discovers OAuth credentials already saved in Pi's `auth.json` (`openai-codex` and `openai-codex/<accountId>`), including accounts from an earlier installation of this extension. Reinstalling the package does not remove those credentials. If an account is saved **only** in OpenCode, use `/accounts import` to copy it without logging in again. Accounts that are not stored in Pi or OpenCode cannot be discovered from a browser login; add those once with `/login` or `/connect [browser|device]`.

1. Automatic mode defaults to **ON**. Before any order is saved the status says `auto ON | set order with /accounts`: **no account participates yet**. Run **`/accounts`**, choose which accounts participate and their priority (for example **B → A → C**), then **Save order** to activate failover. No separate `/accounts auto on` is needed. Cancel keeps the previous settings. Select the account you want to use from the menu. Subsequent `/accounts` calls open the picker directly; choose **Edit priority order** there to change it. Missing accounts are removed from the order only when you save.
2. On a fresh process launch, Pi selects the first eligible account in the saved order. Subsequent interactive launches offer **Use saved order** or **Edit order**; print/JSON/RPC modes use saved settings without prompting. Within a session, a manual selection stays active until it reaches a confirmed quota limit, then Pi advances to the next eligible included account.
3. `/accounts status` shows the live account, order, and known blocks. The persistent Codex status line shows only the first three characters of the current account label (before `@` for emails); the picker and detailed priority list retain full labels so accounts remain distinguishable. `/accounts auto off` explicitly disables automatic switching without deleting the order; saving a nonempty order again re-enables it.

| Command | Action |
|---|---|
| `/accounts` | Interactive picker; on first use, set the included priority and automatically enable failover. Accounts are numbered by saved priority (remaining accounts by label); active account is marked, not moved |
| `/accounts order` | Edit participating accounts and priority; saving a nonempty order turns automation on, cancel changes nothing |
| `/accounts auto off` / `on` | Optional explicit override; order remains saved |
| `/accounts status` | Show current session identity, priority and availability |
| `/accounts <number\|full ID\|email substring>` | Switch immediately without changing priority; ambiguous matches rejected |
| `/accounts import` | Import OpenCode credentials, without automatically including new accounts |
| `/accounts refresh` | Refresh active account when near expiry |
| `/connect [browser\|device]` | Add an account and select it for the current process (not automatically included) |

A manual switch outside the pool is permitted; the next **confirmed** exhaustion starts at the beginning of the saved order. Otherwise failover advances from the current account and wraps at most once. A temporarily available higher-priority account never preempts the active account mid-task. Cross-account continuation sends existing session context to the selected accounts/workspaces.

## Mechanism and safety

Preferences (`{version:1,accountId,order,auto}`) live in `~/.pi/agent/codex-account.json`; old `{accountId}` metadata preserves the selection and defaults to auto ON (without enrolling any accounts until an order is saved). An explicit `/accounts auto off` remains OFF across restarts. **Never commit your `auth.json`, selection metadata, or session files.** This repository contains no user credentials or account data. Stable full account IDs, not displayed indices, are persisted. OAuth instructions use a temporary TUI widget (not the session transcript); operational notices use UI notifications. Secrets stay in Pi's `auth.json`: canonical `openai-codex` and per-account `openai-codex/<id>`. `PI_AGENT_DIR`, `PI_AUTH_FILE`, and `PI_CODEX_SELECTION_FILE` override **this extension's** paths; Pi itself uses `PI_CODING_AGENT_DIR` for its agent directory. Keep these aligned when testing isolated installations.

The extension wraps the installed **native** Codex provider's OAuth `toAuth` and `streamSimple` (not its transport). Each request resolves and refreshes the **session-local selected account** under Pi's `proper-lockfile` auth-file lock, passing its native bearer token to Pi; the Codex transport derives its account-specific header from that JWT. The global canonical entry remains a default for other processes. Switching snapshots outgoing credentials, updates canonical and saved credentials under the same lock, and records the chosen account in versioned metadata. A separate process changing the canonical entry does not silently change this process's next request. Pi's WebSocket cache keys by session **and account ID**, avoiding reuse of another account's connection.

On an eligible quota error at `turn_end`, the extension selects the next available account; Pi may already be retrying. Otherwise `agent_before_settle` appends a validated `context_edit` that removes **only the failed assistant message from model projection** and requests one context-only continuation. Completed tool results, transcript, session ID and model remain unchanged. An attempted-account set bounds a recovery episode. No `continue` user message, session reset, or reload is involved.

**Detection is intentionally conservative.** Pi 0.87's Codex SSE parser can present the same friendly “usage limit” text for both `usage_limit_reached` and `rate_limit_exceeded`; this extension reads only the structured error code from a cloned failed SSE response. It does not switch on the friendly text alone, generic 429, transient throttling, network failures, server errors, context overflow, cancellation, or tool failures. WebSocket errors without an unambiguous code may **not** trigger failover. When supplied, the actual `resets_at` is displayed; otherwise reset is “unknown.” Blocks remain for the process lifetime (including after reset); no background polling or automatic unblocking is attempted. A candidate whose credentials cannot refresh is skipped and marked for reauthentication without launching OAuth. Unsupported models/entitlement errors are not treated as quota exhaustion.

If all included accounts are unavailable, the TUI warns with per-account reasons and stops; the session is resumable. In print mode the per-account summary is written to stderr alongside Pi's last provider error; inspect `/accounts status` when resuming interactively. Compaction, branch summarization, and standalone auth commands use Pi's own model/auth paths, but **quota continuation in those paths is not implemented or verified**. An uncertain interrupted side effect requires human reconciliation; exactly-once execution cannot be promised for arbitrary external tools.

## Limitations

The extension was validated locally with synthetic Codex quota responses in Pi 0.87 before publishing this product repository; automated test sources are not included. To check the TypeScript source in a development checkout, run `npm ci && npm run typecheck`. A real human-operated TUI, real OpenAI quota responses/WebSockets, real token rotation, multi-process refresh races, subagent continuation, and compaction recovery have **not** been verified against live services. Automatic failover cannot be guaranteed for every error or subagent session.
