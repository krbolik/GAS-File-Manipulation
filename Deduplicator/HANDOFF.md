# Deduplicator — Handoff

Written 2026-07-28, end of a long working session. Current state is in
[STATUS.md](STATUS.md); the design rationale is in [ARCHITECTURE.md](ARCHITECTURE.md); how to
*use* the tool is at the top of [README.md](README.md).

---

## Completed this session

Nine releases, each pushed to the live project and byte-verified with `clasp pull`:

| Version | Change |
|---|---|
| **v5.1** | Clickable Drive links per row (rich text, not `=HYPERLINK()`, because the range is forced to plain text); header migration for older layouts |
| **v5.2** | Partial results: pause a scan at a folder boundary, compare what exists, trash it. Failures retry instead of dead-ending. Trash Status batched 50 per write |
| **v5.3** | Per-row **Swap ⇄** checkbox (an `onEdit` simple trigger) plus a menu twin; `Duplicate ID` moved back among the machine columns |
| **v5.4** | **The newest copy is the keeper.** The scan records Drive's `modifiedTime`; both dates shown; grouped comparison replaces the streamed one |
| **v5.4.1–3** | Lock contention treated as "wait", not "fail"; the menu swap made filter-aware and multi-range-aware; `logIt` tracing added throughout |
| **v5.5** | Made a 100 k+ tree finishable: dropped the per-chunk read of every recorded file ID, streamed the compare's input, made link decoration resumable |
| **v5.6** | `Copies` column (family size); `Size`/`Copies` written as real numbers |
| **v5.7** | **Background scanning** via a 5-minute time-driven trigger, capped at 5 h/day |
| **v5.8** | **Background trashing**; Pause as a visible button; ledger day moved to US Pacific; hard guards on what may be trashed |
| **v5.9** | The compare button retires itself once the pipeline is complete; both rebuild routes now confirm first |

Documentation: `ARCHITECTURE.md` written from scratch (component model, the hash-bucketing
algorithm, complexity/capacity tables, ranked constraints, invariants, risk register), the
operator instructions moved to the top of `README.md`, and this pair of files.

## What to do first in the next session

**The trash run has been started and was reported working.** So the job has moved on from
"start trashing" to "confirm it finished correctly".

1. **Run the validation in [STATUS.md](STATUS.md) §"Validating the trash run"** — four counts in
   the sheet that must add up, plus a spot check against Drive. That section is written to be
   usable with no memory of this conversation.
2. **Read STATUS.md §"Two live conditions"** — the lost swap metadata and the cell trim. Both
   still change what is safe to do.
3. **Deal with the `Skipped:` rows.** They are the fingerprint of the swap decisions lost
   earlier: the guard refused to trash a duplicate whose original was already in the bin. Each
   needs a human decision — tick **Swap ⇄** to flip the sides and retry, or leave it.
4. **Only then** consider whether anything remains to scan, and whether to fix the two defects
   below before the next full compare.

## Important implementation details

- **`processFolder` is one pipeline, not two operations.** When the walk finishes, that same
  execution sets the phase to `DEDUPE`, runs the comparison and deletes the phase marker. So a
  completed scan has already compared; the phase marker being empty is the definition of "done"
  and is what the dialog keys on.
- **Two interchangeable schedulers, neither holding state**: the dialog, and time-driven
  triggers. `backgroundScanTick` scans/compares/decorates and **never trashes**;
  `backgroundTrashTick` only trashes. They are mutually exclusive and share one 5 h ledger
  (`BG_DAY` + `BG_USED_MS`), whose day rolls at midnight **America/Los_Angeles** to match
  Google's quota reset.
- **`trashOneRow` is the single gate on deletion.** A row is acted on only if it is present in
  the sheet (re-read every batch, never cached — so deleting a row is final), has an empty
  Status, carries a hash and a URL-safe file ID, and **its original is still alive**. That last
  rule costs one Drive read per family, cached per execution, switchable via `VERIFY_KEEPER`.
- **Three stores, three jobs.** Sheets hold bulk state; `ScriptProperties` holds five cursors
  plus the ledger; `CacheService` carries the live status and the pause flag — cache
  specifically because the property store is read into an execution once, so a running scan
  cannot see a flag another execution just set.
- **Triggers are per-user.** `ScriptApp.getProjectTriggers()` only returns the caller's, so one
  account cannot stop another's background job.
- **Trashing requires ownership.** Only the owner can trash files in their own My Drive; an
  editor's attempt returns `Error: …` per row.

## Unresolved issues

1. **`runDeduplication` clears before it writes.** Status and swaps are read into memory, the
   sheet is cleared, rows are rebuilt, then written. A failure in between loses the lot. Fix:
   write to a temporary sheet and swap, or write rows before clearing. **Highest-value fix.**
2. **The header migration is destructive from paths that do not preserve Status.** This is what
   destroyed the 2,508 trash marks. Fix: make `writeHeaders` refuse to clear unless the caller
   has snapshotted, or have non-compare callers verify rather than migrate.
3. **Compare-stage memory at 315 k records** is in the band documented as untested
   (ARCHITECTURE §7.1). Two mitigations are designed but not built; sort-then-stream is the
   better one.
4. **The 5 h ledger is script-scoped**, so an account handover needs `BG_USED_MS` zeroed by hand
   in Project Settings → Script Properties.
5. **Drive's `fileSize` for a Google Sheet is a lagging estimate.** I mis-diagnosed once from it;
   use `modifiedTime` for "is anything writing", and the sheet's own row counts for volume.

## Things that look like bugs but are not

- *"Service Spreadsheets failed while accessing document"* — Google overload at this document
  size. Transient, retried, expected.
- *"Waiting… another scan or trash run is still running"* — lock contention between consecutive
  slices. It resolves itself; the client waits 20 s and retries.
- Rows marked `Skipped: the original is already in the trash` — rule 4 of `trashOneRow` refusing
  to leave a family with no live copy. Recover by ticking **Swap ⇄** on the row.
- The compare button being absent — v5.9, deliberate: the comparison has already run.
