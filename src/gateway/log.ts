/** One JSON line per gateway decision, on stdout, where the control plane collects it. */
export type Log = (entry: Readonly<Record<string, unknown>>) => void;

export function jsonLog(task: string): Log {
	return entry => console.log(JSON.stringify({ at: new Date().toISOString(), task, ...entry }));
}
