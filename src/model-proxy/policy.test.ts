import { describe, expect, test } from "bun:test";
import { PolicyError, loadPricePolicy, parsePricePolicy, priceUsage, reserve } from "./policy";

/** Fictional models, so no real model id appears outside the policy file (L-0018 §1). */
const POLICY = `
[anthropic]
upstream = "https://upstream.test"
betas = ["some-beta-2026-01-01"]

[[anthropic.models]]
id = "flat-model"
[[anthropic.models.tiers]]
input = 4
cache_write_5m = 5
cache_write_1h = 8
cache_read = 0.2
output = 20

[[anthropic.models]]
id = "tiered-model"
[[anthropic.models.tiers]]
max_prompt_tokens = 100000
input = 0.1
cache_write_5m = 0.125
cache_write_1h = 0.2
cache_read = 0.01
output = 0.5
[[anthropic.models.tiers]]
input = 0.5
cache_write_5m = 0.625
cache_write_1h = 1
cache_read = 0.05
output = 2.5
`;

const policy = parsePricePolicy(POLICY);
const model = (id: string) => {
	const found = policy.models.get(id);
	if (!found) throw new Error(id);
	return found;
};

describe("the price policy", () => {
	test("the committed policy is valid", async () => {
		await expect(loadPricePolicy()).resolves.toBeDefined();
	});

	test("prices usage exactly, in nano-USD, counting every billed token", () => {
		const usage = { input: 1000, cacheWrite5m: 2000, cacheWrite1h: 3000, cacheRead: 4000, output: 500 };
		// 1000×4 + 2000×5 + 3000×8 + 4000×0.2 + 500×20 USD per MTok = 48,800 USD/MTok-tokens = $0.0488
		expect(priceUsage(model("flat-model"), usage)).toEqual({ nanoUsd: 48_800_000, tokens: 10_500 });
	});

	test("prices a prompt by its tier, counting cache reads and writes toward the prompt's length", () => {
		const short = { input: 90_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 10_000, output: 1000 };
		const long = { ...short, cacheRead: 10_001 };
		expect(priceUsage(model("tiered-model"), short).nanoUsd).toBe(90_000 * 100 + 10_000 * 10 + 1000 * 500);
		expect(priceUsage(model("tiered-model"), long).nanoUsd).toBe(90_000 * 500 + 10_001 * 50 + 1000 * 2500);
	});

	test("reserves the counted input plus 10% at the highest input-side rate, and max_tokens at the output rate", () => {
		expect(reserve(model("flat-model"), 10_000, 4096)).toEqual({ nanoUsd: 11_000 * 8000 + 4096 * 20_000, tokens: 11_000 + 4096 });
		// The margin can push a prompt into the dearer tier.
		expect(reserve(model("tiered-model"), 91_000, 1000)).toEqual({ nanoUsd: 100_100 * 1000 + 1000 * 2500, tokens: 101_100 });
	});

	test("refuses rates finer than a thousandth of a dollar, unordered tiers and duplicate models", () => {
		const variants = [
			POLICY.replace("input = 4\n", "input = 4.0001\n"),
			POLICY.replace("max_prompt_tokens = 100000\n", ""),
			POLICY.replace('id = "tiered-model"', 'id = "flat-model"'),
			POLICY.replace('upstream = "https://upstream.test"', 'upstream = "https://upstream.test/v1"'),
			POLICY.replace('betas = ["some-beta-2026-01-01"]', 'betas = ["Bad Beta"]'),
		];
		for (const text of variants) expect(() => parsePricePolicy(text)).toThrow(PolicyError);
	});
});
