import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../util/guards";
import type { Amount } from "./policy";

/**
 * The money and token budgets the model proxy enforces (L-0027): the factory's,
 * from `lanes/factory-budget.yml`, and each lane's, from its charter's front
 * matter in `lanes/*.md`. Both files are protected core.
 */

export const LANES_DIR = join(import.meta.dir, "../../lanes");
const NANO_PER_USD = 1_000_000_000;

export class BudgetError extends Error {
	override readonly name = "BudgetError";
}

export async function loadFactoryBudget(lanesDir: string = LANES_DIR): Promise<Amount> {
	const path = join(lanesDir, "factory-budget.yml");
	return budgetFrom(Bun.YAML.parse(await Bun.file(path).text()), path);
}

/** Every lane's budget, by lane id. */
export async function loadLaneBudgets(lanesDir: string = LANES_DIR): Promise<ReadonlyMap<string, Amount>> {
	const budgets = new Map<string, Amount>();
	for (const name of (await readdir(lanesDir)).filter(file => file.endsWith(".md") && file !== "README.md").sort()) {
		const path = join(lanesDir, name);
		const match = /^---\n([\s\S]*?)\n---\n/.exec(await Bun.file(path).text());
		if (!match?.[1]) throw new BudgetError(`${path}: no front matter`);
		const front: unknown = Bun.YAML.parse(match[1]);
		if (!isRecord(front) || typeof front.id !== "string") throw new BudgetError(`${path}: front matter needs an id`);
		if (budgets.has(front.id)) throw new BudgetError(`${path}: lane ${front.id} is declared twice`);
		budgets.set(front.id, budgetFrom(front.budget, path));
	}
	return budgets;
}

function budgetFrom(value: unknown, path: string): Amount {
	const usd = isRecord(value) ? value.money_usd : undefined;
	const tokens = isRecord(value) ? value.tokens : undefined;
	if (typeof usd !== "number" || !(usd >= 0) || typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0) {
		throw new BudgetError(`${path}: a budget needs money_usd and a whole number of tokens`);
	}
	return { nanoUsd: Math.round(usd * NANO_PER_USD), tokens };
}
