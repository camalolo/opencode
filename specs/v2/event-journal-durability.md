# Event journal durability — making `PartUpdated` non-durable (feasibility plan)

Status: proposal, not implemented. Shipped interim fixes: metadata throttle +
`EventRetention` (14-day retention for `message.part.updated` /
`message.updated` journal rows) and `journal_size_limit`.

## Current state

Every `PartUpdated` is journaled durably: `options.durable` is spread into all
`SessionV1.Event` definitions (`packages/schema/src/v1/session.ts`), and
`EventV2.publishEvent` journals durable events in one transaction (sequence
bump + full-payload `event` row) before notifying listeners. Tools report
progress metadata per output chunk, so a streaming tool call used to journal
hundreds of rows per command. Measured on the fleet: the `event` table was
6 GB of a 9 GB database, 69% of it `message.part.updated` rows.

## Verified consumers of the journal (2026-11-09)

- `EventV2.project` subscribers (the v1 session projector) — invoked **only**
  from `commitDurableEvent`, i.e. only for durable events
  (`packages/core/src/event.ts`, projectors map + `commitDurableEvent`).
- `V2Session.events` / `V2Session.history` (`packages/core/src/session.ts`)
  read the journal, but have **no consumers** (no routes, no runner usage).
- Prompt-retry reconciliation (`SessionInput.admit`) re-publishes
  prompted/admitted events with explicit seq; the dedup branch in
  `commitDurableEvent` **dies ("Replay diverged") if a redelivered seq has no
  journal row**.
- The fleet's active sessions run the v1 loop and read the projection tables
  (`message` / `part`), never the journal.

## Why the proposal is not a one-line change

1. **Projector delivery**: non-durable events never reach `events.project`
   subscribers. Flipping `PartUpdated` to non-durable as-is would silently
   stop the `part` table projection. Fix requires routing non-durable events
   to projectors (invoke the projectors map from `notify`, or migrate the
   projector to `listen`) and deciding error semantics: today projector
   failures run inside the uninterruptible durable-commit block; `notify`
   listeners get error isolation instead.
2. **Ordering/atomicity**: durable commits serialize sequence assignment and
   projection inside one uninterruptible block. Non-durable delivery loses the
   sequence-based dedup ("Replay diverged" guard) for these events; concurrent
   part updates would need the existing write serialization to stay correct.
3. **Replay/rebuild**: today a journal replay can reconstruct part content.
   Non-durable parts make the projection tables the only record; any future
   "rebuild projections from journal" feature must read projections as the
   source of truth for content.
4. **Clustering**: the durable journal is the natural replication log for a
   future multi-node fleet. Content events not being journaled means node
   sync needs a separate projection-sync channel. This is the main roadmap
   cost and the reason the change wants an explicit design rather than a
   flag flip.

## Recommendation

Keep `PartUpdated` durable for now. The throttle + retention already remove
the size and I/O pain (journal bounded to two weeks of part updates). Revisit
non-durable `PartUpdated` only when clustering design starts, and land it
together with the projector-delivery change and a projection-sync design.
