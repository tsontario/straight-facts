import { CONFIG_PATH, parseGatewayConfig } from "./config";
import { READ_ONLY_ENDPOINTS } from "./endpoints";
import { jsonLog } from "./log";
import { serveModelRoute } from "./model";
import { startProxy } from "./proxy";
import { serveReadOnly } from "./readonly";

/**
 * The gateway process (decision 0002 §2), one per task. It reads its task,
 * network profile and model route from the read-only config mount, starts the
 * forward proxy, the profile's read-only endpoints and the model route, and logs
 * one JSON line per decision.
 */
const config = parseGatewayConfig(await Bun.file(process.argv[2] ?? CONFIG_PATH).text());
const log = jsonLog(config.task);
startProxy(config.profile, log);
for (const endpoint of READ_ONLY_ENDPOINTS) {
	if (config.profile.readOnly.includes(endpoint.host)) serveReadOnly(endpoint, log);
}
if (config.model) serveModelRoute(config.model, log);
log({ event: "gateway.started", profile: config.profile.name });
