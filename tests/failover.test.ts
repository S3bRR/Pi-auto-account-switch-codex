import { test } from "node:test";
import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { candidates, parsePreferences, quotaError } from "../pi/failover.js";

test("legacy metadata preserves selection; order is stable and explicit", () => {
	deepStrictEqual(parsePreferences({ accountId: "A" }), { version: 1, accountId: "A", order: [], auto: false });
	deepStrictEqual(parsePreferences({ version: 1, accountId: "B", order: ["B", "A", "C"], auto: true }).order, ["B", "A", "C"]);
	throws(() => parsePreferences({ version: 1, order: ["A", "A"] }));
	throws(() => parsePreferences({ version: 2, order: [] }));
});
test("forward scan wraps once, excluding the current account", () => {
	deepStrictEqual(candidates(["B", "A", "C"], "B"), ["A", "C"]);
	deepStrictEqual(candidates(["B", "A", "C"], "A"), ["C", "B"]);
	deepStrictEqual(candidates(["B", "A", "C"], "outside"), ["B", "A", "C"]);
});
test("quota detection excludes transient and unrelated errors", () => {
	for (const text of ["usage_limit_reached", "ChatGPT weekly usage limit reached"]) equal(quotaError(text), true);
	equal(quotaError("You have hit your ChatGPT usage limit.", "usage_limit_reached"), true);
	equal(quotaError("You have hit your ChatGPT usage limit.", "rate_limit_exceeded"), false);
	equal(quotaError("You have hit your ChatGPT usage limit."), false);
	for (const text of ["429 rate_limit_exceeded", "Too many requests per minute", "insufficient_quota", "context window limit", "network error", "500", "tool failure", "request cancelled", "usage_limit_reached: billing"] ) equal(quotaError(text), false, text);
});
