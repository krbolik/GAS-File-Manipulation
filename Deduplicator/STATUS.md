# Deduplicator — Status

**As of 2026-07-30. Code version v5.10. The 800 GB job's trash run has been reported complete;
what remains is confirming it and closing the job out.**

---

## The code

| | |
|---|---|
| Version | **v5.10** |
| Live project | In sync — `clasp push` + `clasp pull` byte-check after every change |
| Repo | `main` |
| Verification | **137 assertions, all passing.** The harness is in the repo at [`test/simulate.js`](test/simulate.js); run `node test/simulate.js`, which exits non-zero if anything fails. It runs the real `src/Code.js` against a fake Sheets/Drive/Script API and is never pushed to Apps Script — `.claspignore` limits pushes to `src/` |
| Exercised in production | Everything through v5.8, including background trashing, on the run below. v5.9 (the compare button retiring itself) and v5.10 (reset reclaiming cells, the backup reminders) are asserted by the harness but have not yet been watched on the live sheet |
| Backup file | [Duplicate backup](https://docs.google.com/spreadsheets/d/1oBnLcYpUcXKo2V25rPn9MSSJGPhbJZVwy6MGpmKyUds/edit) — where a copy of the `Duplicates` tab belongs, and what the dialog and the reset prompt now point at |

## The live job (DuplicateFinder / the 800 GB tree)

Folder: `1uxLwAGVB94mzZlM-g7G3pjfk-FLYBVa1` · Sheet: `1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0`
· Owner: `kai.bolik@createk.biz`

| | |
|---|---|
| `_scan_files` | ~315,041 records |
| Walk | **Complete** — no phase marker, no installed trigger: `processFolder` finished the walk, ran the comparison itself and deleted the phase |
| `Duplicates` | 72,308 rows when the list was built — **then every row whose file was under 60 KB was deleted by hand**, roughly halving the work |
| **Trashing** | **Run and reported complete.** Confirm with the checklist below |
| Trashed earlier | ~2,508 files, before the list was rebuilt. Those Status marks no longer exist — see below |
| Daily budget | Shared 5 h ledger, day rolling at midnight US Pacific |

### The size cut, and what it means

The sub-60 KB rows were **deleted from the sheet**, not trashed and not excluded from the scan.
Consequences, all of them deliberate:

- Those duplicate files **are still in Drive**, and are still recorded in `_scan_files`. Nothing
  was lost; that work simply was not done.
- **The row count no longer matches the 72,308 above.** Every count below reconciles against
  whatever the sheet holds today.
- **A rebuild would bring them all back**, with an empty Status — i.e. queued for trashing,
  which is the opposite of the intent behind deleting them. So, until this job is deliberately
  finished with: no *Compare Files Scanned So Far*, no *Analyze Folder* on the same URL, and no
  background scan trigger. The dialog already hides its compare button; the menu asks first.
- **The `Duplicates` sheet is the only record of what was trashed.** Copy it into the
  [Duplicate backup](https://docs.google.com/spreadsheets/d/1oBnLcYpUcXKo2V25rPn9MSSJGPhbJZVwy6MGpmKyUds/edit)
  file before anything else — right-click the tab → **Copy to** → **Existing spreadsheet**. It
  has to be that separate file, not a tab here: a tab in this workbook costs its own full
  26-column grid against the 10 M cell ceiling this spreadsheet has already hit once.

### Two conditions that still shape what is safe to do

**1. The 2,508 trash marks and all manual Swap decisions were lost.** A header migration fired
from a non-compare code path (`trashDuplicates` / `finishPendingLinks` call `getSheet`, which
re-heads and clears a mismatched sheet) and dropped the rows. Only `runDeduplication` snapshots
Status and swaps before that happens, so those were not preserved.

Consequence: for any family where the reviewer had swapped, the rebuilt list applied the date
rule again and nominated the copy that was *already trashed* as the keeper — which would have
put the surviving copy up for trashing. **This is blocked in code** (v5.8, `trashOneRow` rule
4): such a row is marked `Skipped: the original is already in the trash` instead. The
`Skipped:` rows on the sheet are the fingerprint of those lost swaps, not a fault.

The user holds a 37 k-era backup of the sheet that still contains the swap signatures (rows
where `Duplicate Date` is newer than `Original Date`).

**2. The workbook hit the 10 M cell limit and was manually trimmed.** Sheets charges the whole
grid width, so 315 k rows × 26 default columns ≈ 8.2 M cells. Every append failed with *"This
action would increase the number of cells…"*, which looks like "the scan stopped recording".
The fix was deleting unused columns (`_scan_files` → A–F, `_scan_queue` → A–B). **The trim was
confirmed still in place on 2026-07-30.** Re-check it after any manual work on those sheets:
`_scan_files`, `Cmd+→`, last column should be F. At this document size Sheets also throws
intermittent *"Service Spreadsheets failed while accessing document"* — transient, retried, and
expected rather than alarming.

## Closing out the 800 GB job

Written to be usable with no memory of the session that ran it. Column letters are the v5.6+
layout: **I** = `Size`, **J** = `Copies`, **K** = `Duplicate ID`, **L** = `Hash`, **M** =
`Status`, **B** / **F** = the duplicate's and the original's links.

**Deadline:** trashed files are recoverable from Drive Trash for 30 days. Everything here is
cheap; do it inside that window, and do not empty the trash until satisfied.

### 1. The counts must add up

Paste into any empty cells to the right of column N of the **Duplicates** sheet:

```
=COUNTIF(K2:K,"<>")                       ' rows in the list (NOT 72,308 — the small ones were deleted)
=COUNTIF(M2:M,"Trashed")                  ' done
=COUNTIFS(K2:K,"<>",M2:M,"")              ' still pending
=COUNTIF(M2:M,"Error*")                   ' attempted and failed
=COUNTIF(M2:M,"Skipped*")                 ' refused by the safety guard
```

`Trashed + pending + Error + Skipped` must equal the row count. If it does not, some Status
cell holds something unexpected — sort by column M and look at the odd values. **Pending = 0
means the run finished**; a non-zero pending count with nothing running means it stopped early,
and clicking the trash button again resumes safely.

### 2. Confirm the size cut did what was intended

```
=MIN(I2:I)                                ' smallest file still listed
=COUNTIFS(I2:I,"<61440")                  ' rows under 60 KiB that survived the deletion
=COUNTIFS(I2:I,"<60000")                  ' same, if the filter used 60,000 bytes
=SUMIFS(I2:I,M2:M,"Trashed")              ' bytes reclaimed
```

The two counts should be 0. Anything above zero means a small file was trashed after all —
harmless, but it means the cut was not clean and the "50 % of the effort" figure is off. The
reclaimed-bytes figure is the job's headline number, but the space is not actually freed until
Drive Trash is emptied.

### 3. What each outcome means

| Status | Meaning | Action |
|---|---|---|
| `Trashed` | The file is in Drive Trash, recoverable for 30 days | None |
| *(empty)* | Never attempted | Re-run trashing to continue |
| `Skipped: the original is already in the trash` | The guard refused, because trashing this copy could have left a set of identical files with **no live copy**. Expected here, as the fingerprint of the swap decisions lost earlier | Review each: tick **Swap ⇄** to flip the sides and retry, or leave it |
| `Error: …` | Attempted and failed — usually "not yours to delete" if run by a non-owner | Re-run as `kai.bolik@createk.biz`; the message says which |

### 4. Cross-check against Drive, not just the sheet

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
- **No trigger is still installed**: the dialog shows background scanning and trashing off, or
  check Apps Script → Triggers directly. Both runners remove their own trigger when done.

### 5. The invariant worth confirming by hand

**No set of identical files should have lost every copy.** The code enforces this at two levels
(*n* copies yield only *n−1* rows, and the keeper check refuses a duplicate whose original is
already trashed), but it is cheap to sample: filter for `Copies > 2`, pick a few hashes in
column L, and confirm that each family's column-F original opens a live file. Anything else
means a real bug, and is worth reporting before further trashing.

### 6. Optional: a verification re-scan

The only way to *prove* nothing was missed is to scan the tree again and see near-zero
duplicates at 60 KB and above. It costs hours and **rebuilds the `Duplicates` sheet**,
destroying the audit trail — so make the backup copy first, and only bother if the spot checks
above raise a doubt. The walk already reports complete.

## Starting the next deduplication job

Three steps, on the same spreadsheet. **v5.10 removed the manual cleanup that used to be
needed here** — no hand-deleting of rows, no separate trigger check.

1. **Copy the `Duplicates` tab to the
   [Duplicate backup](https://docs.google.com/spreadsheets/d/1oBnLcYpUcXKo2V25rPn9MSSJGPhbJZVwy6MGpmKyUds/edit)
   file** — right-click the tab → **Copy to** → **Existing spreadsheet**. Once the next scan
   starts, the record of this job is gone. The dialog and the reset prompt both remind you.
2. **🚀 Angel → Reset Scan Progress**, and answer Yes. It now does the whole job in one action:
   deletes the rows of all three sheets (**reclaiming their cells**, which mattered enough to be
   a manual step before v5.10), clears every cursor and the cache, and removes any background
   trigger still installed. If it reports that empty rows remain, run it again — a 315 k-row
   grid can take more than one execution to delete, and no data is left in it either way.
3. **Analyze Folder** with the new URL, then optionally **Run in the Background** and close
   everything. Review, **Swap ⇄** where the other copy should win, delete rows to exclude them,
   and trash — from the dialog, or **Trash N in the Background** for a long list.

Worth a glance rather than a step: that the column trim is still in place (§2 above,
`_scan_files` A–F, `_scan_queue` A–B — confirmed 2026-07-30), since nothing in the script
narrows a grid on its own.

Two things worth deciding *before* you start reviewing rather than during it: whether to exclude
small files (deleting the rows works, but a rebuild brings them back — deciding it once, up
front, is cheaper), and whether the account running the trash owns the files, since only an
owner can trash their own My Drive files.

## Known defects, not yet fixed

| Defect | Impact | Where |
|---|---|---|
| `runDeduplication` clears the Duplicates sheet **before** writing the new rows, holding Status and swaps only in memory | A failure between the two loses the audit trail for the whole list. Real risk at 72 k rows with Sheets throwing service errors | `runDeduplication` |
| The header migration in `writeHeaders` is destructive and reachable from paths that do **not** preserve Status | This is what destroyed the 2,508 marks | `getSheet` callers other than `runDeduplication` |
| Compare-stage memory is Θ(N) resident, and N = 315 k sits in the band documented as untested | A compare could be killed; mitigations designed but not implemented | ARCHITECTURE §7.1 |
| The 5 h ledger is script-scoped, not per-user | Handing the job to a second account does not reset it; `BG_USED_MS` has to be zeroed by hand | `bgBudget` |
