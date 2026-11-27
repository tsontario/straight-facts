# 0001: Shared memory and agent messaging

- **Status:** accepted 2026-11-27; revised the same day after trials on 18.16.0 and 19.2.1
- **Level:** policy. The laws are [L-0017](../../laws/L-0017-memory-and-messages.md), as amended by [A-0002](../../amendments/0002-memory-and-messaging.md). The factory may replace the backend through an experiment ([L-0011](../../laws/L-0011-experiments.md)).

## Context

Agents need to build on each other's knowledge and coordinate within and across lanes. The laws fix the shape this can take:

- Memory and messages are events first, and the memory store is a rebuildable index ([L-0016](../../laws/L-0016-event-log.md), L-0017 §9).
- Agents run in sandboxes with no route to one another ([L-0024](../../laws/L-0024-sandbox-and-privilege.md)), and all traffic goes through the control plane (L-0017 §8).
- A message reaches its recipient only through the recipient's own tool call (L-0017 §12).

## Decision

### Memory backend: Mnemopi, used only as a searchable index

The control plane embeds [`@oh-my-pi/pi-mnemopi`](https://github.com/can1357/oh-my-pi/tree/main/packages/mnemopi) at exactly **19.2.1** behind a memory contract (Art. IV §6), and it is the only writer. It uses the exported `BeamMemory` class directly, not the `Mnemopi` facade, whose options don't reach `BeamMemory` calls. Mnemopi's consolidation, LLM extraction and embeddings are not used. The trials found that its defaults lose data and mislabel trust, so the adapter works around them as described below.

1. **Process settings.** Set `MNEMOPI_NO_EMBEDDINGS=1` (documented in the README) before opening any bank, which keeps search full-text only. Never pass `extract: true`, so no LLM path can run.
2. **Banks.** Each lane and the factory get one bank, each a separate SQLite file:
   ```ts
   new BeamMemory({
     dbPath, sessionId, channelId,
     config: { workingMemoryLimit: Number.MAX_SAFE_INTEGER, workingMemoryTtlHours: 24 * 365 * 1000 },
   })
   ```
   The `config` stops Mnemopi's default behavior of deleting rows older than 24 hours and trimming above 1,000 rows. Large values are used instead of `0` because the field names document them; `0` means "off" only in the code.
3. **Writes.** Every write goes through `importFromDict({ working_memory: [row] })`:
   - The row's `id` is the source event id, its `timestamp` and `created_at` are the event time, and it carries `session_id` (task), `channel_id` (lane), and `author_id`.
   - Provenance and the trust label go in `metadata_json`. The adapter validates them before writing.
   - The adapter asserts exactly one insert. An existing row is skipped, which makes replay idempotent.
   - `remember` is not used. Its public form can't set ids, and it merges same-content writes while keeping the first row's metadata.
4. **Labels.** Only `metadata_json` round-trips exactly. `veracity` and `trust_tier` are coerced silently, and an unknown trust value becomes `STATED`, so the adapter never relies on them. It parses `metadata_json` and filters on trust itself.
5. **Reads.** Every read passes a fixed `queryTime`, so scores are a pure function of the log.
   - **Task scope:** an instance opened with `sessionId = task` and recalled normally.
   - **Lane scope:** `recall(q, k, { channelId: lane })`.
   - **Factory scope:** a second recall on the factory bank, merged by score.
   - **`get(id)`:** ignores the task slice for working rows, so the adapter checks scope before returning a row.
6. **Startup check.** On startup the adapter confirms the last logged events exist in the index and re-imports any that are missing. Since 19.x the bank runs SQLite with `synchronous=NORMAL`, so a power loss can drop the newest writes.
7. **Consolidation.** Not used. In both versions Mnemopi's `sleep` joins rows into lossy text, throws away provenance, and in a test merged an untrusted row into a trusted memory. Any future consolidation will be the factory's own, with outputs recorded as events (L-0017 §9), introduced as an experiment ([L-0011](../../laws/L-0011-experiments.md)).
8. **Embeddings.** Off. A future experiment may turn them on. They improved recall slightly in the trial, but they cost a 314 MB model, add native packages that need a license check under [L-0028](../../laws/L-0028-dependencies.md), and spread untrusted rows into more results.
9. **Upgrades.** Every version change re-runs the trial before it is adopted. `importFromDict` is a public, typed method that also backs the CLI `mnemopi import`. Its rows follow the exported `MemoryRow` type, which is why this design treats it as a public surface under [L-0013](../../laws/L-0013-omp-harness.md).

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
| Can the index be rebuilt from the log? | Yes, exactly: rows are imported with event ids, and consolidation is not used | No. Extraction happens server-side and we can't see into it. | Partly. Server-side, and omp cannot look up memories by id. |
| Why not chosen | — | Fails the license allowlist ([L-0028](../../laws/L-0028-dependencies.md)), has a hard document cap, and the hosted platform sends memory off-site | A strong option, but it adds a service to run. Candidate for a later recall-quality experiment. |

After the trials, one more option was considered: a small full-text index of our own on Bun's built-in SQLite (FTS5). It would be simpler and fully under our control, but it is search, not memory, so it was not chosen.

Rejected messaging options (peer-to-peer A2A, omp's built-in messaging, push delivery) and the reasons are recorded in [A-0002](../../amendments/0002-memory-and-messaging.md).

## Trial results

Two trials, run in `/tmp` and outside the repo, used omp's built-in Bun runtime and a 40-memory dataset with 10 queries. The first ran 18.16.0, the version that matches omp; the second ran 19.2.1. The `BeamMemory` class is byte-identical between the two versions.

| Check | Result |
|---|---|
| Bank isolation | No rows leak from one lane to another; the factory bank is queried separately and merged by score. |
| Task and lane scope | Works with `sessionId` set to the task and `channelId` set to the lane. |
| Metadata round-trip | `metadata_json` is exact, including nested values and Unicode. Recall returns it as a string, unparsed. |
| Replay | Importing with event ids gave 15 out of 15 recall comparisons identical: same ids, order, and scores, with a fixed `queryTime`. With public `remember`, ids change and rows with tied scores swap order. |
| Durability | With default config, a row 25 hours old is deleted on the next write. With the config in step 2, rows 25 hours and 900 days old both survive, and so do all 1,200 test rows. |
| Recall quality, full-text | Right answer first in 7 of 10 queries, in the top 5 for 9 of 10, about 1 ms per query, the same in both versions. Near-duplicate stale rows sometimes rank first. |
| Recall quality, local embeddings (18.16.0) | 8 of 10 first, 10 of 10 in the top 5, about 96 ms per query. An untrusted row appeared in 4 unrelated top-5 results. |
| Consolidation | Lossy, discards provenance, and turns untrusted content into trusted memory. Not used. |

By approver decision, these defects are not reported upstream. The adapter works around them.

## Consequences and open items

- **Agent session config.** omp's own memory backend stays off in agent sessions (`memory.backend: off`). Otherwise there would be a second store that bypasses the log.
- **Adapter work.** The control plane's memory adapter implements steps 1–6 above, together with the scope and trust checks required by L-0017.
- **Promotion.** Promotion to factory memory needs a task kind and verifier instructions. Both are protected-core artifacts that need human approval.

## Sources

- omp docs: [memory backends](omp://memory.md), [Mnemopi backend](omp://mnemosyne-memory-backend.md), and [RPC host tools and steering](omp://rpc.md)
- Mnemopi [`types.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/mnemopi/src/types.ts) and [`mcp-server.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/mnemopi/src/mcp-server.ts), which show the row fields and that the MCP server is stdio-only
- [A2A v1.0 announcement](https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/) (March 2026) and [A2A joining the AAIF](https://aaif.io/blog/a2a-joins-aaif) (August 2026)
- [Microsoft Learn, *Multi-agent patterns*](https://learn.microsoft.com/en-us/agents/architecture/multi-agent-patterns) (July 2026): use platform-native orchestration internally and A2A across platforms
