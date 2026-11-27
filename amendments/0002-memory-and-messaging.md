---
id: A-0002
title: Amend L-0017 to set how memory and messages flow
kind: law
status: approved
proposed: 2026-11-27
approved: 2026-11-27
approvers: ["@tsontario"]
---

## Problem

[L-0017](../laws/L-0017-memory-and-messages.md) says what memory and messages may mean. It does not say how they flow, and the obvious defaults conflict with other laws:

- **Steering acts as the user.** omp's RPC `steer` command, and its built-in subagent messaging, deliver a message as the recipient's own user turn ([omp RPC docs](omp://rpc.md), `steer_subagent`). One agent's words would then carry a user's standing, which L-0017 §4 forbids.
- **omp's memory isn't shared.** omp's built-in Mnemopi integration lives in one process: subagents alias the parent's state ([omp Mnemopi docs](omp://mnemosyne-memory-backend.md)). Agents running in separate per-task sandboxes ([L-0024](../laws/L-0024-sandbox-and-privilege.md)) therefore cannot share it unless the factory provides its own path.
- **Open writes defeat lane isolation.** If any agent could write to a factory-wide store, one lane's error or injected text would reach every lane (Art. IV §1).
- **The index couldn't be rebuilt.** Memory consolidation uses a model, so replaying the log would not reproduce the memory index ([L-0016](../laws/L-0016-event-log.md) §3) unless the consolidation outputs are recorded.

## Change

In [L-0017](../laws/L-0017-memory-and-messages.md):

- Add `Art. IV §1`, `Art. V §3`, and `Art. V §4` to `derives_from`.
- Add the following clauses to the Statement:
  > 8. Agents MUST reach shared memory and other agents only through tools the control plane provides. Agents MUST NOT exchange messages through any other channel, including direct network connections and the harness's own agent-to-agent messaging.
  > 9. A memory write or message takes effect only after its event is appended to the log (L-0016). The memory store is an index derived from the log. The output of any model-driven consolidation MUST itself be recorded as an event, so the index can be rebuilt by replay without re-running a model.
  > 10. Memory has three scopes: task, lane, and factory.
  >     - An agent MAY recall from its own task, its own lane, and the factory scope.
  >     - An agent MAY write only to its own task and lane.
  >     - An entry enters the factory scope only by promotion. Promotion requires a passing verdict from an independent verifier (L-0020) and records the entry that was promoted.
  >     - Entries labeled untrusted MUST NOT be promoted.
  > 11. An agent MAY message another agent in its own lane, or its lane's channel. A message to another lane MUST go through the factory channel.
  > 12. A message reaches its recipient only as the result of the recipient's own tool call. It arrives labeled with its sender, its lane, and its trust label. The control plane MAY tell an agent that messages are waiting, but that notice MUST NOT include message content. Messages MUST NOT be delivered as user turns or steering.
- Extend the Rationale and the planned Enforcement to cover clauses 8–12.
- Update the index row for L-0017 in `laws/README.md`.

## Alternatives

| Option | Why rejected |
|---|---|
| Peer-to-peer A2A, with every agent running an A2A server | Sandboxes would need network routes to each other ([L-0024](../laws/L-0024-sandbox-and-privilege.md)), and messages could avoid the halt and the event log. A2A suits agents that are opaque to each other, across platforms. The factory's own agents are neither. |
| omp's built-in subagent messaging | Works only inside one process, does not write to the event log, and delivers messages as the user's turn. |
| Push delivery as a follow-up or steering message | Message content would enter the recipient as a user turn. |
| Open writes to factory-wide memory | One lane's error or injected text would reach every lane. |
| Task and lane memory only | Lessons would never carry from one lane to another. |
| Leave these choices to policy | The factory could then loosen its own information flow, for example by switching to push delivery or opening factory-wide writes, with no human involved. |

The choice of memory backend is left to policy, where experiments can change it ([L-0011](../laws/L-0011-experiments.md)). The initial choice is recorded in [docs/decisions/0001](../docs/decisions/0001-memory-and-messaging.md).

## Effects

- The control plane must expose memory and messaging as host tools over omp RPC. Agent sessions must not have omp's own memory backend enabled; it would form a second store that bypasses the event log.
- Promotion to factory memory needs a task kind, its gates, and a verifier. Those are protected-core artifacts ([L-0009](../laws/L-0009-task-kinds.md)).
- The Constitution does not change.
