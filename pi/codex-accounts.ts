/**
 * codex-accounts — Pi extension port of opencode-codex-account-changer.
 *
 * Switch between multiple ChatGPT Plus/Pro OAuth accounts in Pi.
 * Works alongside the OpenCode plugin: credentials can be imported from
 * OpenCode's auth.json, and both harnesses keep independent selections.
 *
 * Commands:
 *   /accounts            Configure priority, list, and select saved accounts
 *   /accounts <query>    Switch account by number, id, or email substring
 *   /accounts import     Copy OpenCode-saved accounts into Pi (never deletes)
 *   /accounts refresh    Proactively refresh the active account's tokens
 *   /connect [browser|device]  Add a ChatGPT account (default: browser)
 *
 * Storage:
 *   Pi auth:        ~/.pi/agent/auth.json
 *                     canonical key "openai-codex" (what the provider reads)
 *                     per-account keys "openai-codex/<accountId>"
 *   Pi selection:   ~/.pi/agent/codex-account.json  ({ accountId, order, auto })
 *
 * Tokens are never logged, and existing credential entries are never deleted.
 * Login and refresh use Pi's native Codex OAuth implementation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { candidates, defaults, parsePreferences, quotaError, type Preferences } from "./failover.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Paths & storage
// ---------------------------------------------------------------------------

const PI_CANONICAL = "openai-codex";
const ACCOUNT_PREFIX = "openai-codex/";

function piAgentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function piAuthPath(): string {
	return process.env.PI_AUTH_FILE ?? join(piAgentDir(), "auth.json");
}

function piSelectionPath(): string {
	return process.env.PI_CODEX_SELECTION_FILE ?? join(piAgentDir(), "codex-account.json");
}

function openCodeAuthPath(): string {
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json");
}

async function readJsonFile<T>(file: string): Promise<T> {
	return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJsonFileAtomic(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
	await rename(temporary, file);
}

// ---------------------------------------------------------------------------
// Account model (adapted from src/accounts.ts)
// ---------------------------------------------------------------------------

export type OAuthCredential = {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	accountId?: string;
	enterpriseUrl?: string;
};

export type CodexAccount = {
	id: string;
	label: string;
	active: boolean;
	auth: OAuthCredential;
};

type Claims = {
	email?: string;
	chatgpt_account_id?: string;
	organizations?: Array<{ id?: string }>;
	"https://api.openai.com/auth"?: { chatgpt_account_id?: string; user_email?: string };
	"https://api.openai.com/profile"?: { email?: string };
};

function claims(token: string | undefined): Claims {
	try {
		const body = token?.split(".")[1];
		return body ? (JSON.parse(Buffer.from(body, "base64url").toString()) as Claims) : {};
	} catch {
		return {};
	}
}

export function identity(...tokens: Array<string | undefined>): { id?: string; email?: string } {
	let id: string | undefined;
	let email: string | undefined;
	for (const token of tokens) {
		const value = claims(token);
		id ??=
			value.chatgpt_account_id ??
			value["https://api.openai.com/auth"]?.chatgpt_account_id ??
			value.organizations?.[0]?.id;
		email ??= value.email ?? value["https://api.openai.com/profile"]?.email ?? value["https://api.openai.com/auth"]?.user_email;
	}
	return { id, email };
}

export function credential(value: unknown): OAuthCredential | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	if (row.type !== "oauth" || typeof row.refresh !== "string" || typeof row.access !== "string" || typeof row.expires !== "number") {
		return undefined;
	}
	return {
		type: "oauth",
		refresh: row.refresh,
		access: row.access,
		expires: row.expires,
		...(typeof row.accountId === "string" && { accountId: row.accountId }),
		...(typeof row.enterpriseUrl === "string" && { enterpriseUrl: row.enterpriseUrl }),
	};
}

function managedKey(key: string): boolean {
	return key === PI_CANONICAL || key.startsWith(ACCOUNT_PREFIX);
}

function openCodeManagedKey(key: string): boolean {
	return key === "openai" || key.startsWith("openai/") || (key.startsWith("OpenAI (") && key.endsWith(")"));
}

function keyLabel(key: string): string {
	if (key.startsWith(ACCOUNT_PREFIX)) return key.slice(ACCOUNT_PREFIX.length);
	if (key.startsWith("openai/")) return key.slice(7);
	if (key.startsWith("OpenAI (") && key.endsWith(")")) return key.slice(8, -1);
	return "OpenAI";
}

function collectAccounts(
	rows: Array<[string, unknown]>,
	isManaged: (key: string) => boolean,
	canonicalKey: string,
): CodexAccount[] {
	const canonical = credential(rows.find(([key]) => key === canonicalKey)?.[1]);
	const active = canonical && (canonical.accountId ?? identity(canonical.access).id ?? canonicalKey);
	const accounts = new Map<string, CodexAccount>();
	for (const [key, raw] of rows.filter(([key]) => isManaged(key)).sort(([a], [b]) => Number(a === canonicalKey) - Number(b === canonicalKey))) {
		const auth = credential(raw);
		if (!auth) continue;
		const found = identity(auth.access);
		const id = auth.accountId ?? found.id ?? key;
		const next: CodexAccount = { id, label: found.email ?? keyLabel(key) ?? id, active: id === active, auth };
		const previous = accounts.get(id);
		if (!previous || auth.expires > previous.auth.expires || (previous.label === "OpenAI" && next.label !== "OpenAI")) {
			accounts.set(id, next);
		}
	}
	return [...accounts.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label));
}

function parseAuth(text: string): Record<string, unknown> {
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${piAuthPath()}; no credentials were changed`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid credential object in ${piAuthPath()}`);
	for (const [key, row] of Object.entries(value)) {
		if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Invalid credential for ${key}; no credentials were changed`);
		const entry = row as Record<string, unknown>;
		if (entry.type === "oauth" && credential(entry) && Number.isFinite(entry.expires) && (entry.accountId === undefined || (typeof entry.accountId === "string" && entry.accountId.length > 0))) continue;
		const env = entry.env;
		if (entry.type === "api_key" && (entry.key === undefined || typeof entry.key === "string") &&
			(env === undefined || (typeof env === "object" && env !== null && !Array.isArray(env) && Object.values(env).every((item) => typeof item === "string")))) continue;
		throw new Error(`Invalid credential for ${key}; no credentials were changed`);
	}
	return value as Record<string, unknown>;
}

/** Use the SAME proper-lockfile lock as Pi 0.87's FileAuthStorageBackend, across the whole RMW/refresh. */
async function authTransaction<T>(fn: (all: Record<string, unknown>) => Promise<{ value: T; changed?: boolean }>): Promise<T> {
	const file = piAuthPath();
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	try { await writeFile(file, "{}", { flag: "wx", mode: 0o600 }); }
	catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
	const release = await lockfile.lock(file, { realpath: false, retries: { retries: 10, minTimeout: 30, maxTimeout: 1000 }, stale: 30_000 });
	try {
		const all = parseAuth(await readFile(file, "utf8"));
		const result = await fn(all);
		if (result.changed) await writeFile(file, JSON.stringify(all, null, 2), { mode: 0o600 });
		return result.value;
	} finally { await release(); }
}

async function readPiAuth(): Promise<Record<string, unknown>> {
	return authTransaction(async (all) => ({ value: all }));
}

export async function readPiAccounts(): Promise<CodexAccount[]> {
	const auth = await readPiAuth();
	return collectAccounts(Object.entries(auth), managedKey, PI_CANONICAL);
}

async function readPreferences(): Promise<Preferences> {
	try { return parsePreferences(await readJsonFile<unknown>(piSelectionPath())); }
	catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return defaults();
		throw cause;
	}
}

async function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
	const file = piSelectionPath();
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	// Lock the directory, not the replaced inode, so atomic rename never changes lock identity.
	const release = await lockfile.lock(dirname(file), { realpath: false, retries: 10 });
	try {
		const next = parsePreferences({ ...await readPreferences(), ...patch });
		await writeJsonFileAtomic(file, next);
		return next;
	} finally { await release(); }
}

async function writeSelection(accountId: string): Promise<void> { await updatePreferences({ accountId }); }

// ---------------------------------------------------------------------------
// Mutations (never delete credentials)
// ---------------------------------------------------------------------------

function accountId(auth: OAuthCredential): string | undefined { return auth.accountId ?? identity(auth.access).id; }
type NativeOAuth = NonNullable<NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>["auth"]["oauth"]>;
let supportedRefresh: NativeOAuth["refresh"] | undefined;
let supportedLogin: NativeOAuth["login"] | undefined;

async function selectAccount(id: string, updateDefault = true): Promise<OAuthCredential> {
	const next = await authTransaction(async (all) => {
		const saved = credential(all[`${ACCOUNT_PREFIX}${id}`]);
		const canonical = credential(all[PI_CANONICAL]);
		let auth = saved ?? (canonical && accountId(canonical) === id ? canonical : undefined);
		if (!auth) throw new Error(`Account ${id} has no usable saved credentials; run /connect to re-authenticate`);
		if (accountId(auth) !== id || (identity(auth.access).id && identity(auth.access).id !== id)) throw new Error(`Saved credentials for ${id} have a different account identity`);
		// Pi may have rotated the canonical credential since our last switch. Never regress its token.
		if (canonical && accountId(canonical) === id && canonical.expires > auth.expires) auth = canonical;
		if (auth.expires <= Date.now() + 5 * 60_000) {
			if (!auth.refresh || !supportedRefresh) throw new Error(`Account ${id} needs reauthentication`);
			const refreshed = await supportedRefresh(auth, AbortSignal.timeout(15_000));
			if (accountId(refreshed) !== id || (identity(refreshed.access).id && identity(refreshed.access).id !== id)) throw new Error(`Refresh changed account identity for ${id}; reauthenticate`);
			auth = refreshed;
		}
		let changed = auth !== saved;
		if (!updateDefault && canonical && accountId(canonical) === id && canonical.expires < auth.expires) {
			all[PI_CANONICAL] = auth;
			changed = true;
		}
		if (updateDefault) {
			if (canonical && accountId(canonical)) {
				const key = `${ACCOUNT_PREFIX}${accountId(canonical)}`;
				if (!credential(all[key]) || credential(all[key])!.expires < canonical.expires) all[key] = canonical;
			}
			all[PI_CANONICAL] = auth;
			changed = true;
		}
		if (changed) all[`${ACCOUNT_PREFIX}${id}`] = auth;
		return { value: auth, changed };
	});
	return next;
}

async function saveAccount(auth: OAuthCredential): Promise<OAuthCredential> {
	if (!auth.accountId) throw new Error("OpenAI did not return a ChatGPT account ID");
	await authTransaction(async (all) => {
		const canonical = credential(all[PI_CANONICAL]);
		if (canonical && accountId(canonical)) {
			const key = `${ACCOUNT_PREFIX}${accountId(canonical)}`;
			if (!credential(all[key]) || credential(all[key])!.expires < canonical.expires) all[key] = canonical;
		}
		if (!credential(all[`${ACCOUNT_PREFIX}${auth.accountId}`]) || credential(all[`${ACCOUNT_PREFIX}${auth.accountId}`])!.expires < auth.expires) all[`${ACCOUNT_PREFIX}${auth.accountId}`] = auth;
		all[PI_CANONICAL] = auth;
		return { value: undefined, changed: true };
	});
	await writeSelection(auth.accountId);
	return auth;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function describeAccount(account: CodexAccount, index: number, activeId?: string): string {
	const current = account.id === activeId;
	const stale = account.auth.expires <= Date.now() ? " (tokens expired — will refresh on switch)" : "";
	return `${index + 1}. ${account.label}${current ? "  [active]" : ""}\n   id: ${account.id}${stale}`;
}

function reply(ctx: ExtensionContext, text: string): void {
	// Status and OAuth instructions must never enter the model transcript.
	ctx.ui.notify(text, "info");
}

// ---------------------------------------------------------------------------
// Local session state and interactive controls
// ---------------------------------------------------------------------------

type Live = { activeId?: string; activeAuth?: OAuthCredential; preferences: Preferences; blocked: Map<string, string>; attempted: Set<string>; seen: Set<string>; pending?: string; loginAbort?: AbortController; generation: number; busy: boolean; switchChain: Promise<void> };
type RequestQuota = { code?: string; resetAt?: number };

async function responseQuota(response: Response): Promise<RequestQuota> {
	if (response.ok) return {};
	try {
		const text = await response.clone().text();
		if (text.length > 32_768) return {};
		const error = (JSON.parse(text) as { error?: { code?: unknown; type?: unknown; resets_at?: unknown } }).error;
		const codes = [error?.code, error?.type].filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
		const code = codes.includes("usage_limit_reached") ? "usage_limit_reached" : codes[0];
		const rawReset = Number(error?.resets_at);
		const resetAt = rawReset > 1e12 ? rawReset : rawReset * 1000;
		return { ...(code && { code }), ...(Number.isFinite(resetAt) && resetAt > Date.now() && { resetAt }) };
	} catch { return {}; }
}

async function switchLive(live: Live, id: string, generation: number): Promise<boolean> {
	const previous = live.switchChain;
	let unlock!: () => void;
	live.switchChain = new Promise<void>((resolve) => { unlock = resolve; });
	await previous;
	try {
		if (live.generation !== generation) return false;
		const auth = await selectAccount(id);
		if (live.generation !== generation) return false;
		live.activeId = id;
		live.activeAuth = auth;
		await writeSelection(id);
		return true;
	} finally { unlock(); }
}

function ordered(accounts: CodexAccount[], order: string[]): CodexAccount[] {
	return [...accounts].sort((a, b) => {
		const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
		return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
	});
}

async function startFirst(live: Live, accounts: CodexAccount[]): Promise<void> {
	for (const id of live.preferences.order) {
		if (!accounts.some((a) => a.id === id)) { live.blocked.set(id, "missing"); continue; }
		try { if (await switchLive(live, id, live.generation)) return; }
		catch { live.blocked.set(id, "credentials unavailable; reauthenticate"); }
	}
}

function statusText(live: Live, accounts: CodexAccount[]): string {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	const position = live.preferences.order.length
		? `${Math.max(0, live.preferences.order.indexOf(live.activeId ?? "") + 1)}/${live.preferences.order.length}`
		: "set order with /accounts";
	const label = byId.get(live.activeId ?? "")?.label ?? live.activeId;
	const shortLabel = label ? Array.from(label.split("@")[0]).slice(0, 3).join("") : "none";
	return `Codex: ${shortLabel} | auto ${live.preferences.auto ? "ON" : "OFF"} | ${position}`;
}

function showStatus(ctx: ExtensionContext, live: Live, accounts: CodexAccount[]): void {
	if (ctx.mode === "tui") ctx.ui.setStatus("codex-accounts", statusText(live, accounts));
}

async function editOrder(ctx: ExtensionContext, live: Live): Promise<boolean> {
	if (ctx.mode !== "tui") { ctx.ui.notify("/accounts order requires an interactive terminal", "warning"); return false; }
	const accounts = ordered(await readPiAccounts(), live.preferences.order);
	let draft = live.preferences.order.filter((id) => accounts.some((a) => a.id === id));
	while (true) {
		const labels = accounts.map((a) => `${draft.includes(a.id) ? `${draft.indexOf(a.id) + 1}.` : "–"} ${a.label} (${a.id}) ${draft.includes(a.id) ? "[included]" : "[excluded]"}`);
		const choice = await ctx.ui.select("Codex priority (select an account to include, exclude or move)", [...labels, "Save order", "Cancel"]);
		if (!choice || choice === "Cancel") return false;
		if (choice === "Save order") {
			if (live.preferences.auto && !draft.length) { ctx.ui.notify("Include at least one account in the order, or Cancel", "warning"); continue; }
			live.preferences = await updatePreferences({ order: draft, ...(draft.length ? { auto: true } : {}) });
			live.generation++; live.pending = undefined; live.attempted.clear();
			showStatus(ctx, live, accounts);
			ctx.ui.notify(`Codex order saved. Only included accounts participate; auto ${live.preferences.auto ? "ON" : "OFF"}.`, "info");
			return true;
		}
		const a = accounts[labels.indexOf(choice)];
		if (!a) continue;
		const index = draft.indexOf(a.id);
		if (index < 0) { draft.push(a.id); continue; }
		const action = await ctx.ui.select(a.label, ["Move up", "Move down", "Exclude", "Back"]);
		if (action === "Exclude") draft.splice(index, 1);
		if (action === "Move up" && index > 0) [draft[index - 1], draft[index]] = [draft[index]!, draft[index - 1]!];
		if (action === "Move down" && index < draft.length - 1) [draft[index + 1], draft[index]] = [draft[index]!, draft[index + 1]!];
	}
}

async function switchManually(ctx: ExtensionContext, live: Live, target: CodexAccount, accounts: CodexAccount[]): Promise<void> {
	live.generation++; live.pending = undefined; live.attempted.clear();
	if (!await switchLive(live, target.id, live.generation)) return;
	live.blocked.delete(target.id);
	showStatus(ctx, live, accounts);
	ctx.ui.notify(`Switched Codex account to ${target.label} in this session.`, "info");
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleAccounts(ctx: ExtensionContext, args: string, live: Live): Promise<void> {
	const trimmed = args.trim();
	const [verb, ...rest] = trimmed.split(/\s+/).filter(Boolean) as string[];
	if (!verb) {
		let accounts: CodexAccount[];
		try {
			accounts = ordered(await readPiAccounts(), live.preferences.order);
		} catch (cause) {
			reply(ctx, `Codex accounts\n\nUnable to read ${piAuthPath()}: ${cause instanceof Error ? cause.message : String(cause)}`);
			return;
		}
		if (!accounts.length) {
			reply(ctx, "Codex accounts\n\nNo saved accounts. Use /connect to add one, or /accounts import to copy accounts saved in OpenCode.");
			return;
		}
		if (ctx.mode === "tui") {
			if (!live.preferences.order.length && (!await editOrder(ctx, live) || !live.preferences.order.length)) return;
			while (true) {
				const listed = ordered(await readPiAccounts(), live.preferences.order);
				const labels = listed.map((account, index) => `${index + 1}. ${account.label} (${account.id})${account.id === live.activeId ? " [active]" : ""}${live.preferences.order.includes(account.id) ? "" : " [not in auto order]"}`);
				const choice = await ctx.ui.select(`Codex accounts — auto ${live.preferences.auto ? "ON" : "OFF"}`, [...labels, "Edit priority order", "Close"]);
				if (choice === "Edit priority order") { await editOrder(ctx, live); continue; }
				if (choice && choice !== "Close") {
					const target = listed[labels.indexOf(choice)];
					if (target) {
						try { await switchManually(ctx, live, target, listed); }
						catch (cause) { ctx.ui.notify(`Switch failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error"); }
					}
				}
				return;
			}
		}
		reply(ctx, `Codex accounts\n\n${accounts.map((account, index) => describeAccount(account, index, live.activeId)).join("\n")}\n\nSwitch with: /accounts <number|id|email>`);
		return;
	}

	if (verb === "status") {
		try {
			const accounts = await readPiAccounts();
			const known = new Map(accounts.map((a) => [a.id, a]));
			ctx.ui.notify(`${statusText(live, accounts)}\nPriority:\n${live.preferences.order.map((id, i) => `${i + 1}. ${known.get(id)?.label ?? id}${known.has(id) ? "" : " [missing]"}${live.blocked.has(id) ? ` [${live.blocked.get(id)}]` : " [available / not checked]"}`).join("\n") || "(not configured)"}\nOnly selected accounts share this session context across their ChatGPT workspaces.`, "info");
		} catch (cause) { ctx.ui.notify(`Status unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, "error"); }
		return;
	}
	if (verb === "order") { try { await editOrder(ctx, live); } catch (cause) { ctx.ui.notify(`Order failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error"); } return; }
	if (verb === "auto") {
		if (rest[0] !== "on" && rest[0] !== "off") { ctx.ui.notify("Usage: /accounts auto on|off", "warning"); return; }
		try {
			if (rest[0] === "on" && !live.preferences.order.length) { ctx.ui.notify("Set a nonempty order with /accounts order first", "warning"); return; }
			live.preferences = await updatePreferences({ auto: rest[0] === "on" });
			live.generation++; live.pending = undefined; live.attempted.clear();
			showStatus(ctx, live, await readPiAccounts());
			ctx.ui.notify(`Codex automatic failover ${rest[0] === "on" ? "enabled" : "disabled"}.`, "info");
		} catch (cause) { ctx.ui.notify(`Automatic mode failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error"); }
		return;
	}

	if (verb === "import") {
		let source: Record<string, unknown>;
		try {
			source = await readJsonFile<Record<string, unknown>>(openCodeAuthPath());
		} catch (cause) {
			reply(ctx, `Import failed: unable to read OpenCode ${openCodeAuthPath()}: ${cause instanceof Error ? cause.message : String(cause)}`);
			return;
		}
		const incoming = collectAccounts(Object.entries(source), openCodeManagedKey, "openai");
		if (!incoming.length) {
			reply(ctx, "Import: no OAuth accounts found in OpenCode auth.json.");
			return;
		}
		const added = await authTransaction(async (all) => {
			let count = 0;
			let changed = false;
			for (const account of incoming) {
				const key = `${ACCOUNT_PREFIX}${account.id}`;
				const existing = credential(all[key]);
				if (!existing || account.auth.expires > existing.expires) { all[key] = account.auth; count++; changed = true; }
			}
			if (!credential(all[PI_CANONICAL]) && incoming[0]) { all[PI_CANONICAL] = incoming[0].auth; changed = true; }
			return { value: count, changed };
		});
		reply(ctx, `Import complete: ${added} account(s) copied from OpenCode (existing Pi entries preserved unless the import is newer).\n\nUse /accounts to list, /accounts <id|email> to switch.`);
		return;
	}

	if (verb === "refresh") {
		try {
			const accounts = await readPiAccounts();
			const current = accounts.find((account) => account.id === live.activeId) ?? accounts.find((account) => account.active) ?? accounts[0];
			if (!current) {
				reply(ctx, "Refresh: no saved accounts. Use /connect first.");
				return;
			}
			const id = accountId(current.auth);
			if (!id) throw new Error("Account has no stable ID");
			await selectAccount(id, false);
			reply(ctx, `Refreshed tokens for ${current.label}.`);
		} catch (cause) {
			ctx.ui.notify(`Refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
		}
		return;
	}

	// Switch by number, id, or email substring.
	try {
		const accounts = ordered(await readPiAccounts(), live.preferences.order);
		if (!accounts.length) {
			reply(ctx, "No saved accounts. Use /connect to add one, or /accounts import to copy accounts saved in OpenCode.");
			return;
		}
		const query = trimmed.toLowerCase();
		const byIndex = /^\d+$/.test(query) ? accounts[Number(query) - 1] : undefined;
		const exact = accounts.filter((account) => account.id.toLowerCase() === query);
		const matches = exact.length ? exact : byIndex ? [byIndex] : accounts.filter((account) => account.label.toLowerCase().includes(query));
		if (matches.length > 1) { ctx.ui.notify(`Ambiguous account match: ${matches.map((a) => a.id).join(", ")}`, "error"); return; }
		const target = matches[0];
		if (!target) {
			reply(
				ctx,
				`No account matches "${trimmed}".\n\n${accounts.map((account, index) => describeAccount(account, index, live.activeId)).join("\n")}`,
			);
			return;
		}
		await switchManually(ctx, live, target, accounts);
	} catch (cause) {
		ctx.ui.notify(`Switch failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
	}
}

async function handleConnect(ctx: ExtensionContext, args: string, live: Live): Promise<void> {
	const mode = args.trim().toLowerCase() || "browser";
	if ((mode !== "browser" && mode !== "device") || !supportedLogin) {
		ctx.ui.notify(supportedLogin ? "Usage: /connect [browser|device]" : "Native Codex login is unavailable", "error");
		return;
	}
	if (live.busy) { ctx.ui.notify("A Codex account operation is already in progress", "warning"); return; }
	live.generation++; live.pending = undefined; live.attempted.clear(); live.busy = true;
	const controller = new AbortController();
	live.loginAbort?.abort(); live.loginAbort = controller;
	try {
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const result = await supportedLogin({
			signal,
			prompt: async (prompt) => {
				if (prompt.type === "select") {
					if (prompt.message.includes("Codex login method")) return mode === "device" ? "device_code" : "browser";
					const labels = prompt.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
					const choice = await ctx.ui.select(prompt.message, labels, { signal: prompt.signal });
					if (!choice) throw new Error("Login cancelled");
					return prompt.options[labels.indexOf(choice)]!.id;
				}
				const value = await ctx.ui.input(prompt.message, prompt.placeholder, { signal: prompt.signal });
				if (value === undefined) throw new Error("Login cancelled");
				return value;
			},
			notify: (event) => {
				const lines = event.type === "auth_url" ? [event.instructions ?? "Open this URL to authenticate:", event.url]
					: event.type === "device_code" ? [`Open: ${event.verificationUri}`, `Enter code: ${event.userCode}`]
					: event.type === "info" ? [event.message, ...(event.links ?? []).map((link) => `${link.label ?? "Open"}: ${link.url}`)]
					: [event.message];
				if (ctx.mode === "tui") ctx.ui.setWidget("codex-connect", lines);
				else reply(ctx, lines.join(" — "));
			},
		});
		const auth = credential(result);
		if (!auth) throw new Error("Native Codex login returned invalid credentials");
		await saveAccount(auth);
		live.generation++; live.activeId = auth.accountId; live.activeAuth = auth; live.pending = undefined; live.attempted.clear();
		showStatus(ctx, live, await readPiAccounts());
		ctx.ui.notify(`Connected account ${auth.accountId} in this session. Add it to /accounts order to include it in automatic failover.`, "info");
	} catch (cause) {
		ctx.ui.notify(`Connect failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
	} finally {
		controller.abort();
		if (live.loginAbort === controller) live.loginAbort = undefined;
		live.busy = false;
		if (ctx.mode === "tui") ctx.ui.setWidget("codex-connect", undefined);
	}
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function registerCodexAccounts(pi: ExtensionAPI): void {
	const live: Live = { preferences: defaults(), blocked: new Map(), attempted: new Set(), seen: new Set(), generation: 0, busy: false, switchChain: Promise.resolve() };
	const quotaByMessage = new WeakMap<object, RequestQuota>();
	let providerInstalled = false;
	pi.on("session_start", async (event, ctx) => {
		try {
			live.preferences = await readPreferences();
			const accounts = await readPiAccounts();
			const native = ctx.modelRegistry.getProvider(PI_CANONICAL);
			if (!native?.auth.oauth) throw new Error("Installed Pi does not expose the native Codex OAuth provider");
			if (!providerInstalled) {
				supportedRefresh = native.auth.oauth.refresh;
				supportedLogin = native.auth.oauth.login;
			}
			// A process launch begins at priority #1. Reload/navigation keeps the current selection.
			if (event.reason === "startup" && live.preferences.auto) await startFirst(live, accounts);
			live.activeId ??= live.preferences.accountId && accounts.some((a) => a.id === live.preferences.accountId)
				? live.preferences.accountId : accounts.find((a) => a.active)?.id;
			if (!providerInstalled) {
				const oauth = native.auth.oauth;
				pi.registerProvider({
					...native,
					auth: { ...native.auth, oauth: {
						...oauth,
						// Pi resolves canonical OAuth before calling toAuth. Never refresh another process's
						// canonical selection: request-time auth below owns refresh of our session's ID.
						refresh: async (current) => current,
						toAuth: async (current) => {
							if (!live.activeId) return oauth.toAuth(current);
							const selected = await selectAccount(live.activeId, false);
							live.activeAuth = selected;
							return oauth.toAuth(selected);
						},
					} },
					streamSimple: (model, context, options) => {
						const selected = live.activeAuth;
						const requestAccountId = selected && accountId(selected);
						if (live.activeId && requestAccountId !== live.activeId) throw new Error("Selected Codex credential is not bound to the active account");
						const apiKey = selected?.access ?? options?.apiKey;
						if (live.activeId && identity(apiKey).id !== live.activeId) throw new Error("Selected Codex bearer token has the wrong account identity");
						const quota: RequestQuota = {};
						// Bind the request directly to the selected token and force SSE. Relying on
						// Pi's canonical credential can reuse a stale pre-switch auth resolution.
						const stream = native.streamSimple(model, context, { ...options, apiKey, transport: "sse", fetch: async (input, init) => {
							const headerAccountId = new Headers(init?.headers).get("chatgpt-account-id");
							if (requestAccountId && headerAccountId !== requestAccountId) throw new Error("Codex request account header does not match the selected account");
							const response = await (options?.fetch ?? fetch)(input, init);
							delete quota.code; delete quota.resetAt;
							Object.assign(quota, await responseQuota(response));
							return response;
						} });
						// Pi forwards provider streams through lazy wrappers. Associate metadata
						// before yielding the terminal event so turn_end cannot race result().
						const originalIterator = stream[Symbol.asyncIterator].bind(stream);
						stream[Symbol.asyncIterator] = async function* () {
							for await (const event of { [Symbol.asyncIterator]: originalIterator }) {
								if (event.type === "done") quotaByMessage.set(event.message, quota);
								if (event.type === "error") quotaByMessage.set(event.error, quota);
								yield event;
							}
						};
						return stream;
					},
				});
				providerInstalled = true;
			}
			showStatus(ctx, live, accounts);
			if (event.reason === "startup" && ctx.mode === "tui" && accounts.length && !live.preferences.order.length) {
				ctx.ui.notify("Codex accounts detected. Run /accounts once to choose the automatic failover order.", "info");
			}
		} catch (cause) { ctx.ui.notify(`Codex setup failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error"); }
	});
	pi.on("session_shutdown", (_event, ctx) => {
		live.loginAbort?.abort(); live.loginAbort = undefined;
		live.generation++; live.activeAuth = undefined; live.pending = undefined; live.attempted.clear(); live.seen.clear();
		if (ctx.mode === "tui") ctx.ui.setStatus("codex-accounts", undefined);
	});
	// A new user task gets a fresh bounded failover episode. Automatic continuations
	// do not emit before_agent_start, so exhausted accounts remain skipped mid-task.
	pi.on("before_agent_start", () => {
		live.pending = undefined; live.blocked.clear(); live.attempted.clear(); live.seen.clear();
	});
	pi.on("turn_end", async (event, ctx) => {
		const quota = quotaByMessage.get(event.message);
		if (!live.preferences.auto || !live.activeId || !ctx.model || ctx.model.provider !== PI_CANONICAL || event.message.role !== "assistant" || event.message.provider !== PI_CANONICAL || event.message.stopReason !== "error" || !quotaError(event.message.errorMessage, quota?.code) || live.seen.has(event.messageEntryId) || live.busy) return;
		live.seen.add(event.messageEntryId);
		live.busy = true;
		const generation = live.generation;
		try {
			const previous = live.activeId;
			live.attempted.add(previous);
			live.blocked.set(previous, `usage exhausted; reset ${quota?.resetAt ? new Date(quota.resetAt).toISOString() : "unknown"}`);
			const accounts = await readPiAccounts();
			const known = new Map(accounts.map((a) => [a.id, a]));
			live.pending = undefined;
			for (const id of candidates(live.preferences.order, previous)) {
				if (generation !== live.generation || !live.preferences.auto) return;
				if (live.attempted.has(id) || live.blocked.has(id)) continue;
				live.attempted.add(id);
				if (!known.has(id)) { live.blocked.set(id, "missing"); continue; }
				try {
					if (!await switchLive(live, id, generation)) return;
					live.pending = event.messageEntryId;
					showStatus(ctx, live, accounts);
					ctx.ui.notify(`${known.get(previous)?.label ?? previous} reached its usage limit. Switched to ${known.get(id)?.label ?? id}; continuing this task.`, "info");
					return;
				} catch { live.blocked.set(id, "credentials unavailable; reauthenticate"); }
			}
			const summary = `Codex accounts unavailable: ${live.preferences.order.map((id) => `${known.get(id)?.label ?? id}: ${live.blocked.get(id) ?? "not attempted"}`).join("; ")}. Session preserved.`;
			if (ctx.mode === "print") process.stderr.write(`${summary}\n`);
			else ctx.ui.notify(summary, "warning");
		} catch (cause) {
			const message = `Codex failover failed safely: ${cause instanceof Error ? cause.message : String(cause)}. Session preserved.`;
			if (ctx.mode === "print") process.stderr.write(`${message}\n`);
			else ctx.ui.notify(message, "error");
		} finally { live.busy = false; }
	});
	pi.on("agent_before_settle", (event) => {
		if (!live.preferences.auto || !live.pending || event.outcome !== "error") return;
		const id = live.pending;
		live.pending = undefined;
		// Pi stores the failed attempt, but omit ONLY that assistant entry from the
		// model projection. Earlier successful tool calls/results remain unchanged.
		return { entries: [...event.entries, { type: "context_edit" as const, targetId: id, replacement: null }], continue: true };
	});
	pi.on("agent_settled", () => { live.pending = undefined; live.attempted.clear(); });
	pi.registerCommand("accounts", {
		description: "Codex accounts (/accounts [order|auto on|auto off|status|number|id|email|import|refresh])",
		handler: async (args, ctx) => { await handleAccounts(ctx, args, live); },
	});
	pi.registerCommand("connect", {
		description: "Connect a ChatGPT account via OAuth (/connect [browser|device])",
		handler: async (args, ctx) => { await handleConnect(ctx, args, live); },
	});
}
