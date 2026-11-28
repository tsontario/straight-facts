import { describe, expect, test } from "bun:test";
import { checkCountTokens, checkMessages } from "./checks";
import { parsePricePolicy } from "./policy";

const policy = parsePricePolicy(`
[anthropic]
upstream = "https://upstream.test"
betas = ["allowed-beta-2026-01-01"]
[[anthropic.models]]
id = "test-model"
[[anthropic.models.tiers]]
input = 1
cache_write_5m = 1.25
cache_write_1h = 2
cache_read = 0.1
output = 5
`);

/** The shape omp sends, reduced. */
const base = {
	model: "test-model",
	max_tokens: 1024,
	stream: true,
	system: [{ type: "text", text: "You are a coding agent." }],
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { source: { type: "string" } } } }],
	thinking: { type: "adaptive" },
	output_config: { effort: "high" },
	context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
	metadata: { user_id: "session" },
};

function reason(body: unknown, beta: string | null = null): string | undefined {
	const result = checkMessages(body, beta, policy);
	return result.ok ? undefined : `${result.code}: ${result.detail}`;
}

describe("checkMessages", () => {
	test("accepts omp's request shape, and builds a count body with only the fields count_tokens takes", () => {
		const result = checkMessages(base, "allowed-beta-2026-01-01", policy);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect([result.value.maxTokens, result.value.stream]).toEqual([1024, true]);
		expect(Object.keys(result.value.countBody).sort()).toEqual(["messages", "model", "output_config", "system", "thinking", "tools"]);
	});

	test("refuses fields that add tools, remote state or unpriced rates", () => {
		for (const field of ["mcp_servers", "container", "speed", "inference_geo", "service_tier", "betas"]) {
			expect(reason({ ...base, [field]: "x" })).toContain(field);
		}
	});

	test("refuses unpriced models and unlisted betas", () => {
		expect(reason({ ...base, model: "other-model" })).toContain("not in the price policy");
		expect(reason(base, "allowed-beta-2026-01-01, unlisted-beta")).toContain("unlisted-beta");
	});

	test("refuses server-side tools, but not a custom tool whose schema has a property called source", () => {
		expect(reason({ ...base, tools: [...base.tools, { type: "web_search_20250305", name: "web_search" }] })).toContain("server-side tool");
		expect(reason({ ...base, tools: [{ ...base.tools[0], type: "custom" }] })).toBeUndefined();
	});

	test("refuses url and file sources, file ids and server-tool blocks anywhere in the conversation", () => {
		const inToolResult = (block: unknown) => ({
			...base,
			messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [block] }] }],
		});
		expect(reason(inToolResult({ type: "image", source: { type: "url", url: "https://example.com/x.png" } }))).toContain('"url"');
		expect(reason(inToolResult({ type: "document", source: { type: "file", file_id: "file_1" } }))).toContain('"file"');
		expect(reason(inToolResult({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }))).toBeUndefined();
		expect(reason({ ...base, system: [{ type: "document", source: { type: "url", url: "https://example.com" } }] })).toContain('"url"');
		expect(reason({ ...base, messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} }] }] })).toContain(
			"server_tool_use",
		);
		expect(reason({ ...base, messages: [{ role: "user", content: [{ type: "web_fetch_tool_result", tool_use_id: "s", content: {} }] }] })).toContain(
			"web_fetch_tool_result",
		);
		expect(reason({ ...base, messages: [{ role: "user", content: [{ type: "container_upload", file_id: "f" }] }] })).toContain("container_upload");
	});

	test("passes only inline sources, and does not mistake a tool call's arguments for content", () => {
		const userContent = (block: unknown) => ({ ...base, messages: [{ role: "user", content: [block] }] });
		expect(reason(userContent({ type: "document", source: { type: "text", media_type: "text/plain", data: "notes" } }))).toBeUndefined();
		expect(reason(userContent({ type: "document", source: { type: "content", content: [{ type: "text", text: "notes" }] } }))).toBeUndefined();
		expect(reason(userContent({ type: "document", source: { type: "s3", bucket: "b" } }))).toStartWith("source_not_inline");
		const toolCall = { type: "tool_use", id: "t1", name: "read", input: { source: { type: "git" }, file_id: "notes.md" } };
		expect(reason({ ...base, messages: [{ role: "assistant", content: [toolCall] }] })).toBeUndefined();
	});

	test("gives a fixed code, and keeps the detail it quotes from the request short", () => {
		const result = checkMessages({ ...base, model: `pretend-secret-${"x".repeat(1_000_000)}` }, null, policy);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("model_not_in_policy");
		expect(result.detail.length).toBeLessThanOrEqual(201);
	});

	test("refuses numbers that re-serializing would change: unsafe integers and non-finite values", () => {
		const withToolInput = (input: unknown) => ({ ...base, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input }] }] });
		expect(reason(withToolInput({ id: 2 ** 53 }))).toStartWith("number_out_of_range");
		expect(reason(withToolInput({ big: Number.POSITIVE_INFINITY }))).toStartWith("number_out_of_range");
		expect(reason(withToolInput({ id: 2 ** 53 - 1, ratio: 1.5 }))).toBeUndefined();
	});

	test("refuses a missing or invalid max_tokens", () => {
		expect(reason({ ...base, max_tokens: undefined })).toContain("max_tokens");
		expect(reason({ ...base, max_tokens: 0 })).toContain("max_tokens");
		expect(reason({ ...base, max_tokens: 1.5 })).toContain("max_tokens");
	});
});

describe("checkCountTokens", () => {
	test("accepts only the fields count_tokens takes, with the same checks", () => {
		const count = { model: "test-model", messages: base.messages, tools: base.tools };
		expect(checkCountTokens(count, null, policy).ok).toBe(true);
		expect(checkCountTokens({ ...count, max_tokens: 10 }, null, policy).ok).toBe(false);
		expect(checkCountTokens({ ...count, tools: [{ type: "code_execution_20250825", name: "x" }] }, null, policy).ok).toBe(false);
	});
});
