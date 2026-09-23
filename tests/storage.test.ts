import { test } from "node:test";
import { strictEqual, rejects } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiAccounts } from "../pi/codex-accounts.js";

test("corrupt credentials never get replaced with empty credentials", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-corrupt-"));
	const file = join(dir, "auth.json");
	const previous = process.env.PI_AUTH_FILE;
	try {
		process.env.PI_AUTH_FILE = file;
		for (const broken of ["{broken", JSON.stringify({ "openai-codex": null })]) {
			writeFileSync(file, broken);
			await rejects(readPiAccounts(), /Invalid/);
			strictEqual(readFileSync(file, "utf8"), broken);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_AUTH_FILE;
		else process.env.PI_AUTH_FILE = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
