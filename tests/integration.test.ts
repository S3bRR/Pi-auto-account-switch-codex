import { test } from "node:test";
import { deepStrictEqual, equal, match } from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pi = spawnSync("pi", ["--version"], { encoding: "utf8" });
const installed = pi.status === 0 && pi.stdout.trim() === "0.87.0";
function jwt(id: string) { return `e30.${Buffer.from(JSON.stringify({ chatgpt_account_id: id })).toString("base64url")}.sig`; }
function auth(id: string) { return { type: "oauth", access: jwt(id), refresh: "synthetic", expires: Date.now() + 86400000, accountId: id }; }

for (const scenario of ["recover", "two", "exhaust", "throttle", "manual"] as const) {
	test(`Pi 0.87 real session: ${scenario}`, { skip: !installed && "requires installed pi 0.87.0" }, () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-codex-integration-"));
		try {
			const authFile = join(dir, "auth.json"), selection = join(dir, "codex-account.json"), trace = join(dir, "trace"), effect = join(dir, "effect"), sessions = join(dir, "sessions");
			writeFileSync(authFile, JSON.stringify({ "openai-codex": auth("A"), "openai-codex/A": auth("A"), "openai-codex/B": auth("B"), "openai-codex/C": auth("C"), unrelated: { type: "api_key", key: "synthetic" } }), { mode: 0o600 });
			writeFileSync(selection, JSON.stringify({ version: 1, accountId: "A", order: ["B", "A", "C"], auto: scenario !== "manual" }));
			const result = spawnSync("pi", ["--no-extensions", "--no-context-files", "-e", resolve("pi/codex-accounts.ts"), "-e", resolve("tests/mock-provider.ts"), "--provider", "openai-codex", "--model", "gpt-5.3-codex", "--tools", "bash", "--session-dir", sessions, "-p", "Mock test only"], {
				cwd: resolve("."), encoding: "utf8", timeout: 20_000,
				env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: dir, PI_AGENT_DIR: dir, PI_AUTH_FILE: authFile, PI_CODEX_SELECTION_FILE: selection, PI_MOCK_TRACE_FILE: trace, PI_MOCK_EFFECT_FILE: effect, PI_MOCK_SCENARIO: scenario === "manual" ? "exhaust" : scenario },
			});
			const calls = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { account: string; model: string; sessionId: string; roles: string[] });
			deepStrictEqual(calls.map((c) => c.account), scenario === "recover" ? ["B", "B", "A"] : scenario === "two" ? ["B", "B", "A", "C"] : scenario === "throttle" ? ["B", "B", "B"] : scenario === "manual" ? ["A"] : ["B", "A", "C"]);
			equal(new Set(calls.map((c) => c.sessionId)).size, 1, "same session throughout");
			equal(new Set(calls.map((c) => c.model)).size, 1, "no model downgrade");
			equal(readdirSync(sessions).length, 1);
			equal(JSON.parse(readFileSync(authFile, "utf8")).unrelated.key, "synthetic");
			if (scenario === "recover" || scenario === "two" || scenario === "throttle") {
				equal(result.status, 0, result.stderr);
				match(result.stdout, /Mock task complete/);
				equal(readFileSync(effect, "utf8"), "x", "completed tool not replayed");
				deepStrictEqual(calls[2]?.roles.slice(-2), ["assistant", "toolResult"]);
			} else {
				equal(result.status, 1, result.stderr);
				if (scenario === "exhaust") match(result.stderr, /Codex accounts unavailable: B: usage exhausted; reset unknown; A: usage exhausted; reset unknown; C: usage exhausted; reset unknown/);
				match(result.stderr, /usage_limit_reached/i);
			}
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
}
