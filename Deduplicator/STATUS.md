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
| `Duplicates` | **72,308 rows, all with an empty Status** — i.e. all pending |
| Trashed so far | ~2,508 files (earlier in the session). **Their Status marks no longer exist** — see below |
| Background jobs | None installed at last check |
| Daily budget | Shared 5 h ledger; ~28 min recorded spent on the day of the last check |

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

## What is left to do on the job

1. **Trash the 72,308 pending rows** — as `kai.bolik@createk.biz`, since only the owner can
   trash files in their own My Drive. Roughly 7 h of runtime plus the keeper checks, i.e. two to
   three days at 5 h/day. Background trashing (v5.8) now does this unattended.
2. Decide whether anything remains to scan (the walk reports complete; a fresh verification scan
   after trashing is the only way to be sure).
3. Optionally reconcile the lost swaps from the 37 k backup before trashing.

## Known defects, not yet fixed

| Defect | Impact | Where |
|---|---|---|
| `runDeduplication` clears the Duplicates sheet **before** writing the new rows, holding Status and swaps only in memory | A failure between the two loses the audit trail for the whole list. Real risk at 72 k rows with Sheets throwing service errors | `runDeduplication` |
| The header migration in `writeHeaders` is destructive and reachable from paths that do **not** preserve Status | This is what destroyed the 2,508 marks | `getSheet` callers other than `runDeduplication` |
| Compare-stage memory is Θ(N) resident, and N = 315 k sits in the band documented as untested | A compare could be killed; mitigations designed but not implemented | ARCHITECTURE §7.1 |
| The 5 h ledger is script-scoped, not per-user | Handing the job to a second account does not reset it; `BG_USED_MS` has to be zeroed by hand | `bgBudget` |
