/** Non-secret preferences and bounded recovery decisions. No credentials belong here. */
export type Preferences = { version: 1; accountId?: string; order: string[]; auto: boolean };
// Automatic mode is ready by default; the participating pool stays empty until explicitly saved.
export const defaults = (): Preferences => ({ version: 1, order: [], auto: true });

export function parsePreferences(value: unknown): Preferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex selection metadata");
	const row = value as Record<string, unknown>;
	if (row.version !== undefined && row.version !== 1) throw new Error("Unsupported Codex selection metadata version");
	if (row.accountId !== undefined && (typeof row.accountId !== "string" || !row.accountId)) throw new Error("Invalid selected account ID");
	if (row.order !== undefined && (!Array.isArray(row.order) || row.order.some((id) => typeof id !== "string" || !id) || new Set(row.order).size !== row.order.length)) throw new Error("Invalid Codex account order");
	if (row.auto !== undefined && typeof row.auto !== "boolean") throw new Error("Invalid Codex automatic mode");
	return { version: 1, ...(row.accountId ? { accountId: row.accountId as string } : {}), order: (row.order as string[] | undefined) ?? [], auto: (row.auto as boolean | undefined) ?? true };
}

/** Only subscription exhaustion is actionable. Pi may expose a code or normalized text. */
export function quotaError(message: string | undefined, code?: string): boolean {
	if (!message) return false;
	const text = message.trim();
	if (/insufficient_quota|billing|context (?:window|length)/i.test(text)) return false;
	if (/^(?:Codex error:\s*)?The usage limit has been reached\.?$/i.test(text)) return true;
	const normalized = /^You have hit your ChatGPT usage limit \((?:plus|pro|free|team|business|enterprise) plan\)\. Try again in ~([0-9]+) min\.$/i.exec(text);
	// Pi 0.87.1 can normalize both quota and rate errors to the same sentence.
	// A plan-scoped wait of ten minutes or more is treated as exhaustion; short
	// request throttles still stay on the current account.
	if (normalized !== null && Number(normalized[1]) >= 10) return true;
	if (code) return code === "usage_limit_reached";
	if (/rate_limit_exceeded|requests? per (?:minute|second)|too many requests/i.test(text)) return false;
	return /\busage_limit_reached\b|\b(?:GoUsageLimitError|FreeUsageLimitError)\b|\bChatGPT (?:weekly|monthly) usage limit reached\b/i.test(text);
}

/** Manual selection outside the pool begins at the first priority entry. */
export function candidates(order: string[], current: string): string[] {
	const index = order.indexOf(current);
	return index < 0 ? [...order] : [...order.slice(index + 1), ...order.slice(0, index)];
}
