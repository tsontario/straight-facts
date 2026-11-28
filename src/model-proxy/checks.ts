import { isRecord } from "../util/guards";
import type { ModelPrice, PricePolicy } from "./policy";

/**
 * What the model proxy refuses before it counts or reserves anything
 * (decision 0002 §3, "Request checks"):
 *
 * - any top-level field not on the allowlist. That covers `mcp_servers`,
 *   `container`, `speed`, `inference_geo` and `service_tier`, which add tools,
 *   remote state or rates the policy doesn't price;
 * - a model the price policy doesn't list;
 * - a server-side tool: a `tools[]` entry whose `type` is not `custom`;
 * - a content block whose source is a `url` or an uploaded `file`, anywhere in
 *   `messages` or `system`, so Anthropic never fetches on a sandbox's behalf;
 * - a server-tool or container block in the conversation;
 * - an `anthropic-beta` value the policy doesn't list.
 */

/** Top-level fields of a Messages request that the proxy forwards. */
const MESSAGES_FIELDS = new Set([
	"model",
	"messages",
	"system",
	"max_tokens",
	"metadata",
	"stop_sequences",
	"stream",
	"temperature",
	"top_k",
	"top_p",
	"tools",
	"tool_choice",
	"thinking",
	"output_config",
	"context_management",
	"cache_control",
]);

/** The fields `count_tokens` accepts, out of those. */
const COUNT_FIELDS = ["model", "messages", "system", "tools", "tool_choice", "thinking", "output_config", "cache_control"];

/** Content block types that only server-side tools or containers produce. */
const SERVER_BLOCK = /^(server_tool_use|mcp_tool_use|container_upload|.+_tool_result)$/;

export interface CheckedRequest {
	readonly model: ModelPrice;
	readonly maxTokens: number;
	readonly stream: boolean;
	/** The checked request; the proxy forwards this, re-serialized, never the raw text. */
	readonly request: Record<string, unknown>;
	/** The body for `count_tokens`: the same request without the fields it doesn't accept. */
	readonly countBody: Record<string, unknown>;
}

/**
 * Why a request was refused. The code is fixed text, safe for the permanent event
 * log; the detail may quote the request and goes only back to the sandbox.
 */
export interface Refusal {
	readonly code: RefusalCode;
	readonly detail: string;
}

export type RefusalCode =
	| "not_json_object"
	| "field_not_allowed"
	| "model_not_in_policy"
	| "beta_not_listed"
	| "tools_malformed"
	| "server_tool"
	| "server_block"
	| "source_not_inline"
	| "file_reference"
	| "max_tokens_invalid"
	| "stream_invalid"
	| "number_out_of_range";

export type Check<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & Refusal);

/** Content sources Anthropic reads inline. Any other, such as `url` or `file`, would make it fetch. */
const INLINE_SOURCES = new Set(["base64", "text", "content"]);
/** Refusal details quote the request; this keeps them short. */
const DETAIL_LIMIT = 200;

/** Checks a `POST /v1/messages` body and its `anthropic-beta` header. */
export function checkMessages(body: unknown, beta: string | null, policy: PricePolicy): Check<CheckedRequest> {
	const common = checkCommon(body, beta, policy, MESSAGES_FIELDS);
	if (!common.ok) return common;
	const { request, model } = common.value;
	const maxTokens = request.max_tokens;
	if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) return refuse("max_tokens_invalid", "max_tokens must be a positive integer");
	if (request.stream !== undefined && typeof request.stream !== "boolean") return refuse("stream_invalid", "stream must be a boolean");
	const countBody = Object.fromEntries(COUNT_FIELDS.filter(field => field in request).map(field => [field, request[field]]));
	return { ok: true, value: { model, maxTokens, stream: request.stream === true, request, countBody } };
}

/** Checks a `POST /v1/messages/count_tokens` body and its `anthropic-beta` header. */
export function checkCountTokens(body: unknown, beta: string | null, policy: PricePolicy): Check<ModelPrice> {
	const common = checkCommon(body, beta, policy, new Set(COUNT_FIELDS));
	return common.ok ? { ok: true, value: common.value.model } : common;
}

function checkCommon(
	body: unknown,
	beta: string | null,
	policy: PricePolicy,
	allowed: ReadonlySet<string>,
): Check<{ request: Record<string, unknown>; model: ModelPrice }> {
	if (!isRecord(body)) return refuse("not_json_object", "the request body must be a JSON object");
	const unknown = Object.keys(body).filter(field => !allowed.has(field));
	if (unknown.length > 0) return refuse("field_not_allowed", `fields not allowed: ${unknown.join(", ")}`);
	const model = typeof body.model === "string" ? policy.models.get(body.model) : undefined;
	if (!model) return refuse("model_not_in_policy", `model ${JSON.stringify(body.model)} is not in the price policy`);
	for (const name of (beta ?? "").split(",").map(value => value.trim()).filter(Boolean)) {
		if (!policy.betas.has(name)) return refuse("beta_not_listed", `anthropic-beta ${JSON.stringify(name)} is not in the price policy`);
	}
	if (body.tools !== undefined) {
		if (!Array.isArray(body.tools)) return refuse("tools_malformed", "tools must be a list");
		for (const tool of body.tools) {
			if (!isRecord(tool)) return refuse("tools_malformed", "every tool must be an object");
			if (tool.type !== undefined && tool.type !== "custom") return refuse("server_tool", `server-side tool ${JSON.stringify(tool.type)} is not allowed`);
		}
	}
	const content = contentProblem(body.messages) ?? contentProblem(body.system);
	if (content) return { ok: false, ...content };
	// The proxy forwards the parsed request re-serialized, which would silently change these.
	if (hasUnsafeNumber(body)) return refuse("number_out_of_range", "numbers must be finite, and integers must be within ±(2^53 − 1)");
	return { ok: true, value: { request: body, model } };
}

/** True if any number in a parsed JSON value would not survive JSON.stringify unchanged. */
function hasUnsafeNumber(value: unknown): boolean {
	if (typeof value === "number") return !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value));
	if (Array.isArray(value)) return value.some(hasUnsafeNumber);
	return isRecord(value) && Object.values(value).some(hasUnsafeNumber);
}

/**
 * Walks message or system content for sources that aren't inline, file
 * references and server-tool blocks. A tool call's `input` is the agent's own
 * arguments, not content Anthropic reads, so it is not walked.
 */
function contentProblem(value: unknown): Refusal | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const problem = contentProblem(item);
			if (problem) return problem;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const type = typeof value.type === "string" ? value.type : undefined;
	if (type !== undefined && SERVER_BLOCK.test(type) && type !== "tool_result") {
		return refusal("server_block", `content block ${JSON.stringify(type)} is not allowed`);
	}
	if (isRecord(value.source) && !INLINE_SOURCES.has(String(value.source.type))) {
		return refusal("source_not_inline", `content sources of type ${JSON.stringify(value.source.type)} are not allowed; send the content inline`);
	}
	if ("file_id" in value) return refusal("file_reference", "references to uploaded files are not allowed");
	for (const [key, child] of Object.entries(value)) {
		if (key === "input" && type === "tool_use") continue;
		const problem = contentProblem(child);
		if (problem) return problem;
	}
	return undefined;
}

function refusal(code: RefusalCode, detail: string): Refusal {
	return { code, detail: detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}…` : detail };
}

function refuse(code: RefusalCode, detail: string): { ok: false } & Refusal {
	return { ok: false, ...refusal(code, detail) };
}
