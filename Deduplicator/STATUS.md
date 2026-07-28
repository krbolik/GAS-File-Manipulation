# Deduplicator — Status

**As of 2026-07-28. Code version v5.9 (`863c819`), pushed to the live Apps Script project and
byte-verified with `clasp pull`. Working tree clean; local, remote and live project agree.**

---

## The code

| | |
|---|---|
| Version | **v5.9** |
| Live project | In sync — `clasp push` + `clasp pull` byte-check after every change this session |
| Repo | `main`, clean, pushed to `origin` |
| Verification | 123 assertions against a fake Sheets/Drive API — **all passing, but the harness is not in the repo** (see HANDOFF) |
| Untested in production | Background trashing (v5.8) and the compare-button retirement (v5.9) have not yet been exercised on the live sheet |

## The live job (DuplicateFinder / the 800 GB tree)

Folder: `1uxLwAGVB94mzZlM-g7G3pjfk-FLYBVa1` · Sheet: `1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0`
· Owner: `kai.bolik@createk.biz`

| | |
|---|---|
| `_scan_files` | ~315,041 records |
| Walk | **Reported complete** — the last analysis found no phase marker and no installed trigger, i.e. `processFolder` finished the walk, ran the comparison itself and deleted the phase. **Verify from the dialog before acting**: *Analyze Folder* = complete, *Resume Scan* = not |
| `Duplicates` | 72,308 rows, all pending when the run began |
| **Trashing** | **Started 2026-07-28 and reported working.** Not confirmed finished — validate with the procedure below |
| Trashed earlier | ~2,508 files, before the list was rebuilt. **Those Status marks no longer exist** — see below |
| Daily budget | Shared 5 h ledger, day rolling at midnight US Pacific |

### Two live conditions the next session must respect

**1. The 2,508 trash marks and all manual Swap decisions were lost.** A header migration fired
from a non-compare code path (`trashDuplicates` / `finishPendingLinks` call `getSheet`, which
re-heads and clears a mismatched sheet) and dropped the rows. Only `runDeduplication` snapshots
Status and swaps before that happens, so those were not preserved.

Consequence: for any family where the reviewer had swapped, the rebuilt list applies the date
rule again and nominates the copy that was *already trashed* as the keeper — which would have
put the surviving copy up for trashing. **This is now blocked in code** (v5.8, `trashOneRow`
rule 4): a duplicate whose original is already in the trash is marked
`Skipped: the original is already in the trash` instead. Expect a number of those rows on the
first trash run; they are the fingerprint of the lost swaps, not a fault.

The user holds a 37 k-era backup of the sheet that still contains the swap signatures (rows
where `Duplicate Date` is newer than `Original Date`).

**2. The workbook hit the 10 M cell limit and was manually trimmed.** Sheets charges the whole
grid width, so 315 k rows × 26 default columns ≈ 8.2 M cells. Every append failed with *"This
action would increase the number of cells…"*, which looks like "the scan stopped recording".
The fix was deleting unused columns (`_scan_files` → A–F, `_scan_queue` → A–B). **Confirm the
trim survived** (`_scan_files`, `Cmd+→`, last column should be F). At this document size Sheets
also throws intermittent *"Service Spreadsheets failed while accessing document"* — transient,
retried, and expected rather than alarming.

## Validating the trash run

Written to be usable with no memory of the session that started the run. Column letters are
the v5.6+ layout: **K** = `Duplicate ID`, **L** = `Hash`, **M** = `Status`, **B** / **F** = the
duplicate's and the original's links, **J** = `Copies`.

### 1. The four counts must add up

Paste into any empty cells to the right of column N of the **Duplicates** sheet:

```
=COUNTIF(K2:K,"<>")                       ' rows in the list
=COUNTIF(M2:M,"Trashed")                  ' done
=COUNTIFS(K2:K,"<>",M2:M,"")              ' still pending
=COUNTIF(M2:M,"Error*")                   ' attempted and failed
=COUNTIF(M2:M,"Skipped*")                 ' refused by the safety guard
```

`Trashed + pending + Error + Skipped` must equal the row count. If it does not, some Status
cell holds something unexpected — sort by column M and look at the odd values. **Pending = 0
means the run finished**; a non-zero pending count with nothing running means it stopped early,
and clicking the trash button again resumes safely.

### 2. What each outcome means

| Status | Meaning | Action |
|---|---|---|
| `Trashed` | The file is in Drive Trash, recoverable for 30 days | None |
| *(empty)* | Never attempted | Re-run trashing to continue |
| `Skipped: the original is already in the trash` | The guard refused, because trashing this copy could have left a set of identical files with **no live copy**. Expected here, as the fingerprint of the swap decisions lost earlier | Review each: tick **Swap ⇄** to flip the sides and retry, or leave it |
| `Error: …` | Attempted and failed — usually "not yours to delete" if run by a non-owner | Re-run as `kai.bolik@createk.biz`; the message says which |

### 3. Cross-check against Drive, not just the sheet

The sheet records what the script *believes*. Confirm independently:

- **drive.google.com/drive/trash** should hold roughly the `Trashed` count (plus the earlier
  ~2,508). Drive's trash view is not precisely countable, so treat this as an order-of-magnitude
  check.
- **Spot-check 3–5 rows marked `Trashed`**: the link in column B should open a file Drive shows
  as being in the trash, and the link in column F — its original — must open a **live** file.
  That pairing is the whole safety property; if an F link is also trashed, stop and investigate
  before running anything further.
- **Executions log** (Extensions → Apps Script → Executions, as the account that ran it): lines
  reading `Dedup trash chunk done {"trashed":…,"errors":…,"skipped":…,"remaining":…}`. The
  `remaining` of the final line should be 0. `Dedup background trash complete` means the
  trigger removed itself, i.e. the list was fully worked through.

### 4. The invariant worth confirming by hand

**No set of identical files should have lost every copy.** The code enforces this at two levels
(*n* copies yield only *n−1* rows, and the keeper check refuses a duplicate whose original is
already trashed), but it is cheap to sample: filter for `Copies > 2`, pick a few hashes in
column L, and confirm that each family's column-F original opens a live file. Anything else
means a real bug, and is worth reporting before further trashing.

## What is left to do on the job

1. **Confirm the trash run completed** using the procedure above. It needs roughly 7 h of
   runtime plus the keeper checks, i.e. two to three days at 5 h/day, so expect it to span
   several sessions. It must run as `kai.bolik@createk.biz` — only the owner can trash files in
   their own My Drive.
2. **Work through the `Skipped:` rows** — each is a decision the tool deliberately refused to
   make.
3. Decide whether anything remains to scan (the walk reports complete; a fresh verification scan
   after trashing is the only way to be sure).

## Known defects, not yet fixed

| Defect | Impact | Where |
|---|---|---|
| `runDeduplication` clears the Duplicates sheet **before** writing the new rows, holding Status and swaps only in memory | A failure between the two loses the audit trail for the whole list. Real risk at 72 k rows with Sheets throwing service errors | `runDeduplication` |
| The header migration in `writeHeaders` is destructive and reachable from paths that do **not** preserve Status | This is what destroyed the 2,508 marks | `getSheet` callers other than `runDeduplication` |
| Compare-stage memory is Θ(N) resident, and N = 315 k sits in the band documented as untested | A compare could be killed; mitigations designed but not implemented | ARCHITECTURE §7.1 |
| The 5 h ledger is script-scoped, not per-user | Handing the job to a second account does not reset it; `BG_USED_MS` has to be zeroed by hand | `bgBudget` |
