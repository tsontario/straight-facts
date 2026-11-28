import type { EventLog } from "../event-log/event-log";
import { loadFactoryBudget, loadLaneBudgets } from "./budgets";
import { KeychainError, checkKeyAccess, readKey, type KeychainItem } from "./keychain";
import { loadPricePolicy } from "./policy";
import { ModelProxy } from "./proxy";

/**
 * Starts the control plane's model proxy for real (decision 0002 §3): it refuses
 * to start unless the Anthropic key's keychain item requires the keychain
 * password for every read and trusts no application; then it reads the key once,
 * so it is held only in this process's memory, and loads the price policy and
 * the budgets from their protected files.
 */

/** The keychain item that holds the factory's Anthropic key. */
export const ANTHROPIC_KEY_ITEM: KeychainItem = { service: "straight-facts/anthropic" };

export interface StartOptions {
	readonly log: EventLog;
	/** 127.0.0.1 on macOS, where Docker Desktop's containers reach the host's loopback. */
	readonly hostname: string;
	readonly port: number;
	readonly item?: KeychainItem;
}

export async function startModelProxy(options: StartOptions): Promise<ModelProxy> {
	const item = options.item ?? ANTHROPIC_KEY_ITEM;
	const access = checkKeyAccess(item);
	if (!access.ok) throw new KeychainError(`refusing to start the model proxy:\n- ${access.problems.join("\n- ")}`);
	const [policy, factoryBudget, laneBudgets] = await Promise.all([loadPricePolicy(), loadFactoryBudget(), loadLaneBudgets()]);
	return ModelProxy.start({ policy, log: options.log, key: readKey(item), factoryBudget, laneBudgets, hostname: options.hostname, port: options.port });
}
