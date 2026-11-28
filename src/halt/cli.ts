import { loadApprovers } from "../control-plane/roster";
import { HALT_DIR, openEventLog } from "../control-plane/state";
import { HaltError, HaltState, parseScope, raiseHalt } from "./halt";

/**
 * `straight-facts halt` (decision 0002 §4):
 *
 *   bun src/halt/cli.ts <scope> --by @handle [--reason "text"]
 *   bun src/halt/cli.ts status
 *
 * A scope is `factory`, `lane:<id>` or `repo:<owner>/<name>`. Lifting a halt is not
 * here: only an approver can lift one, through the approval channel.
 */
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const log = openEventLog();
const approvers = await loadApprovers();
try {
	if (args[0] === "status") {
		const scopes = new HaltState(log, approvers).refresh().scopes;
		console.log(scopes.length === 0 ? "no halt in force" : `halted: ${scopes.join(", ")}`);
	} else if (args[0] !== undefined && option("--by") !== undefined) {
		const by = option("--by") ?? "";
		// The control plane's own name, reserved for halts the control plane raises itself.
		if (by === "control-plane") throw new HaltError("control-plane is reserved for the control plane: raise a halt as yourself");
		const scope = parseScope(args[0]);
		const { killed } = await raiseHalt({ log, approvers, haltDir: HALT_DIR }, scope, by, option("--reason") ?? "");
		console.log(`halted ${scope}; stopped ${killed.length} container(s)`);
	} else {
		console.error("usage: bun src/halt/cli.ts <factory|lane:<id>|repo:<owner>/<name>> --by @handle [--reason text] | status");
		process.exitCode = 2;
	}
} catch (error) {
	if (!(error instanceof HaltError)) throw error;
	console.error(`halt: ${error.message}`);
	process.exitCode = 1;
} finally {
	log.close();
}
