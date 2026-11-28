import { CONFIG_PATH, parseGatewayConfig } from "./config";
import { READ_ONLY_ENDPOINTS } from "./endpoints";
import { haltCheck } from "./halt";
import { jsonLog } from "./log";
import { serveModelRoute } from "./model";
import { startProxy } from "./proxy";
import { serveReadOnly } from "./readonly";

/**
 * The gateway process (decision 0002 §2), one per task. It reads its task,
 * network profile and model route from the read-only config mount, starts the
 * forward proxy, the profile's read-only endpoints and the model route, and logs
 * one JSON line per decision. Every one of them refuses everything while a halt
 * covers the task (§4), read from the halt file's read-only mount.
 */
const config = parseGatewayConfig(await Bun.file(process.argv[2] ?? CONFIG_PATH).text());
const log = jsonLog(config.task);
const halted = haltCheck({ lane: config.lane, repo: config.repo });
startProxy(config.profile, log, { halted });
for (const endpoint of READ_ONLY_ENDPOINTS) {
	if (config.profile.readOnly.includes(endpoint.host)) serveReadOnly(endpoint, log, { halted });
}
if (config.model) serveModelRoute(config.model, log, { halted });
log({ event: "gateway.started", profile: config.profile.name });
