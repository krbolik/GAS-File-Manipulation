# Deduplicator — Handoff

Written 2026-07-28 at the end of a long working session; updated 2026-07-30, when the trash
run came back complete. Current state is in [STATUS.md](STATUS.md); the design rationale is in
[ARCHITECTURE.md](ARCHITECTURE.md); how to *use* the tool is at the top of
[README.md](README.md).

---

## Completed

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
| **v5.10** | Clearing a sheet reclaims its cells again (`purgeSheet`); reset confirms first and stops background jobs; the dialog says to copy the list to the *Duplicate backup* file |

Documentation: `ARCHITECTURE.md` written from scratch (component model, the hash-bucketing
algorithm, complexity/capacity tables, ranked constraints, invariants, risk register), the
operator instructions moved to the top of `README.md`, this pair of files, and the test harness
committed at [`test/simulate.js`](test/simulate.js) (137 assertions, `node test/simulate.js`).

**The 800 GB job is done.** The walk finished, the comparison ran, and the trash run completed.
Before running it the reviewer deleted every row whose file was under 60 KB, which halved the
work; those duplicates are still in Drive and are still recorded in `_scan_files`. See
[STATUS.md](STATUS.md) for what that means and for the closing checklist.

## What to do first in the next session

1. **Close the job out** — the checklist in [STATUS.md](STATUS.md) §"Closing out the 800 GB
   job": reconcile the four counts, spot-check that a trashed row's original is still live,
   work through the `Skipped:` rows. The 30-day Drive Trash window is the deadline for any of
   it to be recoverable.
2. **Do not compare.** With the sub-60 KB rows deleted by hand, a rebuild regenerates all of
   them with an empty Status — i.e. queued for trashing, the opposite of the intent. That rules
   out the menu's *Compare Files Scanned So Far*, *Analyze Folder* on the same URL, and any
   background scan trigger, until the job is deliberately finished with.
3. **Starting a different folder**: copy the `Duplicates` tab to the *Duplicate backup*
   spreadsheet first (it is the only record of what was trashed), then **🚀 Angel → Reset Scan
   Progress**. As of v5.10 that one action also deletes the rows — reclaiming the cells — and
   removes any background trigger, so the manual cleanup this used to need is gone. STATUS has
   the runbook.
4. **Only then** consider the two unresolved defects below, both of which are worth fixing
   before the next full compare on a list anyone cares about.

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
  the sheet, has an empty Status, carries a hash and a URL-safe file ID, and **its original is
  still alive**. That last rule costs one Drive read per family, cached per execution,
  switchable via `VERIFY_KEEPER`. "Present in the sheet" means re-read at the start of every
  chunk and never cached — each execution snapshots the rows once, so deleting a row while
  nothing is running is final, and deleting one mid-chunk takes effect at the next chunk.
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
