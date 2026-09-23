/** Non-secret preferences and bounded recovery decisions. No credentials belong here. */
export type Preferences = { version: 1; accountId?: string; order: string[]; auto: boolean };
export const defaults = (): Preferences => ({ version: 1, order: [], auto: false });

export function parsePreferences(value: unknown): Preferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex selection metadata");
	const row = value as Record<string, unknown>;
	if (row.version !== undefined && row.version !== 1) throw new Error("Unsupported Codex selection metadata version");
	if (row.accountId !== undefined && (typeof row.accountId !== "string" || !row.accountId)) throw new Error("Invalid selected account ID");
	if (row.order !== undefined && (!Array.isArray(row.order) || row.order.some((id) => typeof id !== "string" || !id) || new Set(row.order).size !== row.order.length)) throw new Error("Invalid Codex account order");
	if (row.auto !== undefined && typeof row.auto !== "boolean") throw new Error("Invalid Codex automatic mode");
	return { version: 1, ...(row.accountId ? { accountId: row.accountId as string } : {}), order: (row.order as string[] | undefined) ?? [], auto: (row.auto as boolean | undefined) ?? false };
}

/** Only unambiguous subscription exhaustion is actionable. Pi 0.87 normalizes Codex errors to text. */
export function quotaError(message: string | undefined, code?: string): boolean {
	if (!message) return false;
	// Pi 0.87's Codex SSE parser uses the SAME friendly "usage limit" message for
	// both usage_limit_reached and rate_limit_exceeded. Never trust that text alone.
	if (code) return code === "usage_limit_reached";
	return /\busage_limit_reached\b|\b(?:GoUsageLimitError|FreeUsageLimitError)\b|\bChatGPT (?:weekly|monthly) usage limit reached\b/i.test(message)
		&& !/rate_limit_exceeded|requests? per (?:minute|second)|too many requests|insufficient_quota|billing|context (?:window|length)/i.test(message);
}

/** Manual selection outside the pool begins at the first priority entry. */
export function candidates(order: string[], current: string): string[] {
	const index = order.indexOf(current);
	return index < 0 ? [...order] : [...order.slice(index + 1), ...order.slice(0, index)];
}
