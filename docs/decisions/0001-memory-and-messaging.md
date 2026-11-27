# 0001: Shared memory and agent messaging

- **Status:** accepted, 2026-11-27
- **Level:** policy. The laws are [L-0017](../../laws/L-0017-memory-and-messages.md), as amended by [A-0002](../../amendments/0002-memory-and-messaging.md). The factory may replace the backend through an experiment ([L-0011](../../laws/L-0011-experiments.md)).

## Context

Agents need to build on each other's knowledge and coordinate within and across lanes. The laws fix the shape this can take:

- Memory and messages are events first, and the memory store is a rebuildable index ([L-0016](../../laws/L-0016-event-log.md), L-0017 §9).
- Agents run in sandboxes with no route to one another ([L-0024](../../laws/L-0024-sandbox-and-privilege.md)), and all traffic goes through the control plane (L-0017 §8).
- A message reaches its recipient only through the recipient's own tool call (L-0017 §12).

## Decision

### Memory backend: Mnemopi, embedded in the control plane

The control plane runs [`@oh-my-pi/pi-mnemopi`](https://github.com/can1357/oh-my-pi/tree/main/packages/mnemopi) as a library behind a memory contract (Art. IV §6). It is the only writer.

- **Scopes.** Lane and factory scopes each get their own bank. Task scope is a slice of the lane bank, keyed by task id.
- **Provenance and labels.** These go into the row's `metadata`, `source`, and `veracity` fields: the authoring agent, the source event id, the lane, the task, and the trust label.
- **Consolidation.** The control plane runs consolidation (`sleep`) on its own schedule. It records each resulting episodic row, which carries `summary_of`, as an event. Replay then rebuilds the index without calling a model.
- **Version.** The package is pinned together with omp ([L-0013](../../laws/L-0013-omp-harness.md)).

### Messaging: a brokered bus on the event log

- **Tools.** The control plane registers host tools in every agent session (omp RPC `set_host_tools`): `memory_recall`, `memory_read`, `memory_retain`, `message_send`, and `inbox_read`.
- **Addressing.** A message can go to an agent in the same lane, to the lane channel, or to the factory channel. The factory channel is the only route between lanes.
- **Delivery.** Messages wait in the recipient's inbox and arrive through `inbox_read`, labeled with sender, lane, and trust. When the recipient reaches a turn boundary, the control plane may send a nudge (for example, "3 unread") that contains no message content.
- **Schema.** The factory's own minimal schema, modeled on A2A's Message and Part: `id`, `from`, `to`, `lane`, an optional `contextId`, `parts` (text, data, or file reference), `trust`, and `createdAt`.
- **A2A.** [A2A](https://a2a-protocol.org/latest/specification/) is adopted only at the factory's edge, if the factory ever talks to outside agents. Any such communication is a reserved action ([L-0006](../../laws/L-0006-reserved-actions.md)).

## Alternatives

| | Mnemopi | Supermemory | Hindsight |
|---|---|---|---|
| License | MIT | Server binary is not open source; the SDKs are ([docs](https://supermemory.ai/docs/self-hosting/overview)) | MIT ([repo](https://github.com/vectorize-io/hindsight)) |
| Runtime | TypeScript/Bun library on SQLite, in-process | Hosted platform, or one local binary | Server plus PostgreSQL with a vector extension |
| Self-hosting limits | None | Free up to 10,000 documents, for individual developers. Organizations need the Scale or Enterprise plan ([blog](https://supermemory.ai/blog/self-hosted-ai-memory-tradeoffs)) | None beyond running Postgres |
| Can extraction be replayed from the log? | Yes. We drive it and record its outputs. | No. Extraction happens server-side and we can't see into it. | Partly. Server-side, and omp cannot look up memories by id. |
| Why not chosen | — | Fails the license allowlist ([L-0028](../../laws/L-0028-dependencies.md)), has a hard document cap, and the hosted platform sends memory off-site | A strong option, but it adds a service to run. Candidate for a later recall-quality experiment. |

Rejected messaging options (peer-to-peer A2A, omp's built-in messaging, push delivery) and the reasons are recorded in [A-0002](../../amendments/0002-memory-and-messaging.md).

## Consequences and open items

- **Agent session config.** omp's own memory backend stays off in agent sessions (`memory.backend: off`). Otherwise there would be a second store that bypasses the log.
- **Spike needed.** None of this has been run yet; this machine has no Bun runtime. The first implementation task should confirm three things:
  - that `remember`/`recall` accept the planned metadata and scope fields;
  - that episodic rows created by `sleep` can be read back and recorded as events;
  - that recall quality is acceptable on factory-shaped content.
- **Promotion.** Promotion to factory memory needs a task kind and verifier instructions. Both are protected-core artifacts that need human approval.

## Sources

- omp docs: [memory backends](omp://memory.md), [Mnemopi backend](omp://mnemosyne-memory-backend.md), and [RPC host tools and steering](omp://rpc.md)
- Mnemopi [`types.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/mnemopi/src/types.ts) and [`mcp-server.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/mnemopi/src/mcp-server.ts), which show the row fields and that the MCP server is stdio-only
- [A2A v1.0 announcement](https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/) (March 2026) and [A2A joining the AAIF](https://aaif.io/blog/a2a-joins-aaif) (August 2026)
- [Microsoft Learn, *Multi-agent patterns*](https://learn.microsoft.com/en-us/agents/architecture/multi-agent-patterns) (July 2026): use platform-native orchestration internally and A2A across platforms
