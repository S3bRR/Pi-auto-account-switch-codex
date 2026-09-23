/* Test-only mock. Loaded AFTER the extension under test by pi -e; never contacts OpenAI. */
import { appendFileSync, existsSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function mock(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const native = ctx.modelRegistry.getProvider("openai-codex");
		if (!native) throw new Error("No provider for mock");
		let requests = 0;
		const run: typeof native.streamSimple = (model, context, options) => {
			const stream = new AssistantMessageEventStream();
			const payload = JSON.parse(Buffer.from((options?.apiKey ?? "").split(".")[1] ?? "", "base64url").toString()) as { chatgpt_account_id: string };
			const account = payload.chatgpt_account_id;
			const index = ++requests;
			appendFileSync(process.env.PI_MOCK_TRACE_FILE!, JSON.stringify({ index, account, model: model.id, sessionId: options?.sessionId, roles: context.messages.map((m) => m.role) }) + "\n");
			const output = {
				role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, content: [] as Array<any>,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "pending" as "pending" | "error" | "toolUse" | "stop", timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: output });
				if (index === 1 && process.env.PI_MOCK_SCENARIO !== "exhaust") {
					output.stopReason = "toolUse";
					output.content.push({ type: "toolCall", id: "test-tool-1", name: "bash", arguments: { command: `printf x >> ${JSON.stringify(process.env.PI_MOCK_EFFECT_FILE)}` } });
					stream.push({ type: "done", reason: "toolUse", message: output });
				} else if (process.env.PI_MOCK_SCENARIO === "exhaust" || index === 2 || (process.env.PI_MOCK_SCENARIO === "two" && index === 3)) {
					output.stopReason = "error";
					stream.push({ type: "error", reason: "error", error: { ...output, errorMessage: process.env.PI_MOCK_SCENARIO === "throttle" ? "429 rate_limit_exceeded" : "usage_limit_reached" } });
				} else {
					if (!existsSync(process.env.PI_MOCK_EFFECT_FILE!)) throw new Error("prior tool effect missing");
					output.stopReason = "stop";
					output.content.push({ type: "text", text: "Mock task complete." });
					stream.push({ type: "done", reason: "stop", message: output });
				}
				stream.end();
			});
			return stream;
		};
		pi.registerProvider({ ...native, streamSimple: run });
	});
}
