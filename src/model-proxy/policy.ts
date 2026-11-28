import { join } from "node:path";
import { isRecord } from "../util/guards";

/**
 * The model price policy (`policy/models.toml`, decision 0002 §3) and the
 * arithmetic that prices a call.
 *
 * Money is counted in integer nano-USD (10⁻⁹ USD), so sums never drift: a rate
 * of R USD per million tokens is R × 1000 nano-USD per token, and the policy
 * allows at most three decimal places.
 */

export const POLICY_PATH = join(import.meta.dir, "../../policy/models.toml");

/** Nano-USD per token. */
export interface Rates {
	readonly input: number;
	readonly output: number;
	readonly cacheWrite5m: number;
	readonly cacheWrite1h: number;
	readonly cacheRead: number;
}

export interface ModelPrice {
	readonly id: string;
	/** Ordered by `maxPromptTokens`; the last tier has none and covers every longer prompt. */
	readonly tiers: readonly { readonly maxPromptTokens: number | undefined; readonly rates: Rates }[];
}

export interface PricePolicy {
	readonly upstream: string;
	readonly betas: ReadonlySet<string>;
	readonly models: ReadonlyMap<string, ModelPrice>;
}

/** Tokens a call used, by how they are billed. */
export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheWrite5m: number;
	readonly cacheWrite1h: number;
	readonly cacheRead: number;
}

/** An amount against a budget. */
export interface Amount {
	readonly nanoUsd: number;
	readonly tokens: number;
}

export class PolicyError extends Error {
	override readonly name = "PolicyError";
}

const RATE_FIELDS = { input: "input", output: "output", cacheWrite5m: "cache_write_5m", cacheWrite1h: "cache_write_1h", cacheRead: "cache_read" } as const;

export async function loadPricePolicy(path: string = POLICY_PATH): Promise<PricePolicy> {
	return parsePricePolicy(await Bun.file(path).text(), path);
}

export function parsePricePolicy(text: string, where = "price policy"): PricePolicy {
	const root: unknown = Bun.TOML.parse(text);
	const anthropic = isRecord(root) ? root.anthropic : undefined;
	if (!isRecord(anthropic)) throw new PolicyError(`${where}: missing [anthropic]`);
	const { upstream, betas, models } = anthropic;
	if (typeof upstream !== "string" || !/^https?:\/\/[^/\s]+$/.test(upstream)) throw new PolicyError(`${where}: anthropic.upstream must be an origin URL`);
	if (!Array.isArray(betas) || !betas.every(beta => typeof beta === "string" && /^[a-z0-9-]+$/.test(beta))) {
		throw new PolicyError(`${where}: anthropic.betas must be a list of beta names`);
	}
	if (!Array.isArray(models) || models.length === 0) throw new PolicyError(`${where}: anthropic.models must list at least one model`);
	const prices = new Map<string, ModelPrice>();
	for (const model of models) {
		if (!isRecord(model) || typeof model.id !== "string" || !/^[a-z0-9.-]+$/.test(model.id)) throw new PolicyError(`${where}: every model needs an id`);
		if (prices.has(model.id)) throw new PolicyError(`${where}: ${model.id} is listed twice`);
		prices.set(model.id, { id: model.id, tiers: parseTiers(model.tiers, `${where}: ${model.id}`) });
	}
	return { upstream, betas: new Set(betas), models: prices };
}

function parseTiers(value: unknown, where: string): ModelPrice["tiers"] {
	if (!Array.isArray(value) || value.length === 0) throw new PolicyError(`${where} needs at least one tier`);
	return value.map((tier, index) => {
		if (!isRecord(tier)) throw new PolicyError(`${where}: tier ${index + 1} is not a table`);
		const last = index === value.length - 1;
		const max = tier.max_prompt_tokens;
		if (last && max !== undefined) throw new PolicyError(`${where}: the last tier must have no max_prompt_tokens`);
		if (!last && (typeof max !== "number" || !Number.isInteger(max) || max <= 0)) throw new PolicyError(`${where}: tier ${index + 1} needs max_prompt_tokens`);
		const previous = index > 0 ? value[index - 1] : undefined;
		if (typeof max === "number" && isRecord(previous) && typeof previous.max_prompt_tokens === "number" && max <= previous.max_prompt_tokens) {
			throw new PolicyError(`${where}: tiers must be ordered by max_prompt_tokens`);
		}
		const rate = (key: (typeof RATE_FIELDS)[keyof typeof RATE_FIELDS]): number => {
			const usd = tier[key];
			const nano = typeof usd === "number" ? usd * 1000 : Number.NaN;
			if (!(nano >= 0) || Math.abs(nano - Math.round(nano)) > 1e-6) {
				throw new PolicyError(`${where}: tier ${index + 1} ${key} must be a non-negative USD rate with at most three decimals`);
			}
			return Math.round(nano);
		};
		const rates: Rates = {
			input: rate(RATE_FIELDS.input),
			output: rate(RATE_FIELDS.output),
			cacheWrite5m: rate(RATE_FIELDS.cacheWrite5m),
			cacheWrite1h: rate(RATE_FIELDS.cacheWrite1h),
			cacheRead: rate(RATE_FIELDS.cacheRead),
		};
		return { maxPromptTokens: typeof max === "number" ? max : undefined, rates };
	});
}

/** The rates for a prompt of `promptTokens` tokens. */
export function ratesFor(model: ModelPrice, promptTokens: number): Rates {
	const tier = model.tiers.find(candidate => candidate.maxPromptTokens === undefined || promptTokens <= candidate.maxPromptTokens);
	if (!tier) throw new PolicyError(`${model.id}: no tier for ${promptTokens} tokens`);
	return tier.rates;
}

/** What a call cost, from its usage. Every billed token counts toward the token budget. */
export function priceUsage(model: ModelPrice, usage: Usage): Amount {
	const prompt = usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead;
	const rates = ratesFor(model, prompt);
	return {
		nanoUsd:
			usage.input * rates.input +
			usage.cacheWrite5m * rates.cacheWrite5m +
			usage.cacheWrite1h * rates.cacheWrite1h +
			usage.cacheRead * rates.cacheRead +
			usage.output * rates.output,
		tokens: prompt + usage.output,
	};
}

/** The input margin over `count_tokens`, which is an estimate: +10%, as a ratio of integers so no float rounds it up. */
const MARGIN_NUMERATOR = 11;
const MARGIN_DENOMINATOR = 10;

/**
 * An upper bound on what a call can cost (decision 0002 §3): the counted input plus
 * a 10% margin at the highest input-side rate for that prompt length, cache writes
 * included, plus `max_tokens` at that tier's output rate.
 */
export function reserve(model: ModelPrice, countedInput: number, maxTokens: number): Amount {
	const input = Math.ceil((countedInput * MARGIN_NUMERATOR) / MARGIN_DENOMINATOR);
	const rates = ratesFor(model, input);
	const highestInput = Math.max(rates.input, rates.cacheWrite5m, rates.cacheWrite1h, rates.cacheRead);
	return { nanoUsd: input * highestInput + maxTokens * rates.output, tokens: input + maxTokens };
}
