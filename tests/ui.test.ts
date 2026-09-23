import { test } from "node:test";
import { deepStrictEqual, equal } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../pi/codex-accounts.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function jwt(id: string, email?: string): string { return `e30.${Buffer.from(JSON.stringify({ chatgpt_account_id: id, ...(email ? { email } : {}) })).toString("base64url")}.sig`; }
function auth(id: string, email?: string) { return { type: "oauth", access: jwt(id, email), refresh: "synthetic", expires: Date.now() + 86400000, accountId: id }; }

function harness(mode: "tui" | "print", select: (title: string, options: string[]) => string | undefined) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	let selections = 0;
	let confirmations = 0;
	let status = "";
	const oauth = { refresh: async (credential: unknown) => credential, toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }) };
	const native = { id: "openai-codex", name: "Codex", auth: { oauth }, getModels: () => [], stream: () => undefined, streamSimple: () => undefined };
	const pi = {
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) => { commands.set(name, command.handler); },
		registerProvider: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode, model: { provider: "openai-codex" }, modelRegistry: { getProvider: () => native },
		ui: {
			select: async (title: string, options: string[]) => { selections++; return select(title, options); },
			confirm: async () => { confirmations++; return true; }, notify: () => {},
			setStatus: (_key: string, value: string) => { status = value; },
			setWidget: () => {},
		},
	} as unknown as ExtensionContext;
	register(pi);
	return { handlers, commands, ctx, get selections() { return selections; }, get confirmations() { return confirmations; }, get status() { return status; } };
}

test("/accounts saves an automatically enabled order, picks an account, and advances on quota", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-ui-"));
	const previousAuth = process.env.PI_AUTH_FILE, previousSelection = process.env.PI_CODEX_SELECTION_FILE;
	try {
		process.env.PI_AUTH_FILE = join(dir, "auth.json"); process.env.PI_CODEX_SELECTION_FILE = join(dir, "selection.json");
		writeFileSync(process.env.PI_AUTH_FILE, JSON.stringify({ "openai-codex": auth("A"), "openai-codex/A": auth("A"), "openai-codex/B": auth("B"), "openai-codex/C": auth("C") }));
		writeFileSync(process.env.PI_CODEX_SELECTION_FILE, JSON.stringify({ accountId: "A" }));
		const picks = ["B", "A", "C"];
		const first = harness("tui", (title, options) => {
			if (title === "Set up Codex account order") return "Edit order";
			if (title.startsWith("Codex priority")) {
				const id = picks.shift();
				return id ? options.find((o) => o.includes(`(${id})`)) : "Save order";
			}
			throw new Error(`Unexpected prompt: ${title}`);
		});
		await first.handlers.get("session_start")!({ reason: "startup" }, first.ctx);
		const saved = JSON.parse(readFileSync(process.env.PI_CODEX_SELECTION_FILE, "utf8"));
		deepStrictEqual(saved, { version: 1, accountId: "B", order: ["B", "A", "C"], auto: true });
		equal(first.status.includes("Codex: B | auto ON | 1/3"), true);
		equal(first.confirmations, 0, "saving an order must not require /accounts auto on or another confirmation");
		const second = harness("tui", (title, options) => options.includes("Use saved order") ? "Use saved order" : title.startsWith("Codex accounts —") ? options.find((o) => o.includes("(A)")) : undefined);
		await second.handlers.get("session_start")!({ reason: "startup" }, second.ctx);
		equal(second.selections, 1);
		await second.handlers.get("session_start")!({ reason: "resume" }, second.ctx);
		equal(second.selections, 1, "navigation must not re-prompt");
		let moved = false;
		const cancel = harness("tui", (title, options) => {
			if (title.startsWith("Codex priority")) {
				if (moved) return "Cancel";
				return options.find((o) => o.includes("(B)"));
			}
			moved = true; return "Move down";
		});
		await cancel.commands.get("accounts")!("order", cancel.ctx);
		deepStrictEqual(JSON.parse(readFileSync(process.env.PI_CODEX_SELECTION_FILE, "utf8")), saved);
		await second.commands.get("accounts")!("", second.ctx);
		equal(second.status.includes("Codex: A | auto ON | 2/3"), true);
		deepStrictEqual(JSON.parse(readFileSync(process.env.PI_CODEX_SELECTION_FILE, "utf8")), { ...saved, accountId: "A" });
		await second.handlers.get("turn_end")!({ message: { role: "assistant", provider: "openai-codex", stopReason: "error", errorMessage: "usage_limit_reached" }, messageEntryId: "failed-step" }, second.ctx);
		equal(second.status.includes("Codex: C | auto ON | 3/3"), true);
		const result = second.handlers.get("agent_before_settle")!({ outcome: "error", entries: [] }, second.ctx) as { continue: boolean; entries: Array<{ targetId: string }> };
		equal(result.continue, true);
		equal(result.entries[0]?.targetId, "failed-step");
		const print = harness("print", () => { throw new Error("Noninteractive mode must never prompt"); });
		await print.handlers.get("session_start")!({ reason: "startup" }, print.ctx);
		equal(print.selections, 0);
	} finally {
		if (previousAuth === undefined) delete process.env.PI_AUTH_FILE; else process.env.PI_AUTH_FILE = previousAuth;
		if (previousSelection === undefined) delete process.env.PI_CODEX_SELECTION_FILE; else process.env.PI_CODEX_SELECTION_FILE = previousSelection;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/accounts first-time picker configures priority and auto without a separate command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-picker-"));
	const oldAuth = process.env.PI_AUTH_FILE, oldSelection = process.env.PI_CODEX_SELECTION_FILE;
	try {
		process.env.PI_AUTH_FILE = join(dir, "auth.json"); process.env.PI_CODEX_SELECTION_FILE = join(dir, "selection.json");
		writeFileSync(process.env.PI_AUTH_FILE, JSON.stringify({ "openai-codex": auth("A", "alexandra@example.test"), "openai-codex/A": auth("A", "alexandra@example.test"), "openai-codex/B": auth("B") }));
		// Fresh extension install: credentials exist, but there is no selection file yet.
		const order = ["B", "A"];
		const picker = harness("tui", (title, options) => {
			if (title.startsWith("Codex priority")) {
				const id = order.shift();
				return id ? options.find((option) => option.includes(`(${id})`)) : "Save order";
			}
			if (title.startsWith("Codex accounts —")) return options.find((option) => option.includes("(B)"));
			throw new Error(`Unexpected prompt: ${title}`);
		});
		await picker.handlers.get("session_start")!({ reason: "resume" }, picker.ctx);
		equal(picker.status, "Codex: ale | auto ON | set order with /accounts", "the footer masks the email and shows that the order still needs setup");
		await picker.commands.get("accounts")!("", picker.ctx);
		deepStrictEqual(JSON.parse(readFileSync(process.env.PI_CODEX_SELECTION_FILE, "utf8")), { version: 1, accountId: "B", order: ["B", "A"], auto: true });
		equal(picker.confirmations, 0);
		await picker.commands.get("accounts")!("auto off", picker.ctx);
		equal(JSON.parse(readFileSync(process.env.PI_CODEX_SELECTION_FILE, "utf8")).auto, false, "explicit off remains available");
	} finally {
		if (oldAuth === undefined) delete process.env.PI_AUTH_FILE; else process.env.PI_AUTH_FILE = oldAuth;
		if (oldSelection === undefined) delete process.env.PI_CODEX_SELECTION_FILE; else process.env.PI_CODEX_SELECTION_FILE = oldSelection;
		rmSync(dir, { recursive: true, force: true });
	}
});
