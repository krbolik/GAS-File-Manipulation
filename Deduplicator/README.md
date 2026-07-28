# Deduplicator

Version-controlled source for the **Tech Angel Deduplicator** Google Apps Script — a
tool that recursively scans a Google Drive folder, finds duplicate files by content
hash, and moves them to Trash. The script is bound to the **"DuplicateFinder"** Google
Sheet ([open it](https://docs.google.com/spreadsheets/d/1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0/edit)).

> **[STATUS.md](STATUS.md)** — where the code and the live job actually stand right now, plus
> the two live conditions (lost swap metadata, the cell-limit trim) that change what is safe to
> do. **[HANDOFF.md](HANDOFF.md)** — what was done, what is left, known defects. Read both
> before resuming work.
>
> **[ARCHITECTURE.md](ARCHITECTURE.md)** — the design document: component model, the
> search algorithm (hash bucketing, Θ(N) — *not* the pairwise Θ(N²) it is often assumed
> to be), complexity and capacity tables, ranked scalability constraints with thresholds,
> correctness invariants and the risk register. Read that for *why*; below is *how*.

---

# How to use it

**The one rule to remember:** of a set of identical files, the **newest copy is kept**. Every
older copy is listed for trashing. Trashed files stay recoverable from Drive Trash.

## A whole run, start to finish

| # | Do this | Where |
|---|---|---|
| 1 | **🚀 Angel → Start Deduplicator Dialog** | Menu |
| 2 | Paste the Drive folder URL, click **Analyze Folder** | Dialog |
| 3 | Optional: click **Run in the Background** — then you can close everything | Dialog |
| 4 | Wait. It resumes itself past every time limit | — |
| 5 | Review the **Duplicates** sheet: check the links, tick **Swap ⇄** where you want the other copy kept, delete rows you want left alone | Sheet |
| 6 | Click **Move N Duplicates to Trash** and confirm | Dialog |

Trashing is always the last step and always manual.

## The dialog

| Control | What it does |
|---|---|
| **Analyze Folder** | Starts a new scan of the pasted URL. Clears any previous scan and duplicate list |
| **Resume Scan** | Continues the paused scan exactly where it stopped. Shown instead of *Analyze Folder* whenever a scan is unfinished |
| **Pause Scanning** | What the top button becomes while a scan is running. Stops at the next folder — a few seconds — without comparing. Closing the dialog still works too |
| **Pause Trashing** | What the trash button becomes while trashing. The batch in flight finishes (up to a few minutes), then it stops. Click the trash button again to continue |
| **Pause & Compare What Is Scanned So Far** | Stops the walk at the next folder and lists the duplicates found up to that point, so you can trash them without waiting for the rest |
| **Compare N Scanned Files Now** | Only shown while a scan is **unfinished**: compares everything scanned so far, so you can trash without waiting for the rest. Asks first if it would replace an existing list |
| *"Scan complete — nothing left to compare"* | Replaces that button once the walk is done. The comparison already ran automatically at the end of the scan, so there is nothing to press |
| **Run in the Background (computer can be off)** | Hands the scan to Google's servers. Continues every 5 minutes with the tab closed and the machine off. Max 5 hours per day. **Never trashes** |
| **Stop Background Scan** | Cancels that, so you can drive it by hand again |
| **Trash N in the Background (computer can be off)** | Works through the Duplicates sheet unattended, same 5 h/day budget. Asks for confirmation every time it is switched on, and stops itself when every row has a Status. Only one background job runs at a time |
| **Stop Background Trashing** | Cancels it. Rows already handled keep their Status |
| **Move N Duplicates to Trash** | Trashes every row with an empty **Status**. Greyed out while a scan is running — pause it first |
| Status area | Live progress: parent folder, current folder, current file, and `folder N/M` |

## In the sheet ("Duplicates" tab)

| Column | What it is |
|---|---|
| A–D | The **duplicate**: name, clickable link, path, date — this is the copy that gets trashed |
| E–H | The **original**: name, clickable link, path, date — this is the copy that survives |
| I `Size` | Bytes. Sortable |
| J `Copies` | How many identical copies exist, counting the one being kept. `2` = a simple pair, `5` = a family of five |
| K–L | `Duplicate ID` and `Hash` — for the script. `Hash` is the family marker: identical files share it |
| M `Status` | Empty = will be trashed. `Trashed` = done. `Error: …` = it tried and failed |
| N `Swap ⇄` | **Tick to keep this row's duplicate instead** — the two sides trade places, so the file shown as *Original* gets trashed. The box clears itself; tick again to undo |

**Safe to do any time nothing is running:** sort, filter, delete rows, tick Swap. Nothing
depends on row order.

**What trashing can and cannot touch** — the same rules whether you run it from the dialog or
in the background:

- **Only rows that are in the sheet.** A row you delete is gone from the list and is never
  trashed. Nothing outside the sheet is ever touched, and the list is re-read from the sheet
  on every batch — it is never cached, so deleting a row takes effect immediately.
- **Only rows with an empty Status**, so nothing is trashed twice.
- **Only rows that carry a hash and a well-formed file ID** — i.e. rows this tool wrote. A
  hand-typed or pasted row is refused with `Error:` rather than acted on.
- **Never a duplicate whose original is already in the trash.** Those rows get
  `Skipped: the original is already in the trash`, because trashing them could leave a set of
  identical files with no live copy at all. Tick **Swap ⇄** on such a row to flip the sides and
  it becomes eligible again.

**Careful with these three:**

- **Trashing ignores filters.** Every row with an empty Status is trashed, including rows a
  filter is hiding. To exclude rows, delete them.
- **Deleting a row only lasts for this run.** The next compare rebuilds it from the scan data.
  To make a keep-decision stick, use **Swap ⇄**.
- **In a family of 3+, swap only one row** — the row holding the copy you want to keep. Swapping
  every row of a family means nothing gets removed from it.

## The menu (🚀 Angel)

| Item | What it does |
|---|---|
| **Start Deduplicator Dialog** | Opens the dialog |
| **Compare Files Scanned So Far** | Same as *Pause & Compare*, but works with the dialog closed |
| **Keep Duplicate Instead (selected rows)** | Swaps every selected row at once. Skips rows a filter is hiding |
| **Run Scan in the Background** | Same as the dialog button |
| **Stop Background Scan** | Same as the dialog button |
| **Trash Duplicates in the Background** | Same as the dialog button, with a yes/no on the exact row count |
| **Stop Background Trashing** | Same as the dialog button |
| **Reset Scan Progress** | ⚠️ Throws the scan and the whole duplicate list away. Only for starting on a different folder |

## Is it finished, or did it stop?

Open the dialog and look at the top button:

| You see | It means |
|---|---|
| **Analyze Folder** + background off | **Finished** — scan and comparison are complete. Review and trash |
| **Resume Scan** + *"Running on Google's servers … 45 of 300 min used today"* | Still working. Close the tab and leave it |
| **Resume Scan** + *"… 300 of 300 min used today"* | Paused on today's 5-hour limit. Resumes by itself after midnight |
| **Resume Scan** + background off | Stopped. Click **Resume Scan**, or turn background mode back on |

The status area also tells you: if it names a real folder and file, a chunk ran within the last
ten minutes. For a full history open **Extensions → Apps Script → Executions** and look for
lines starting with `Dedup`.

## If something goes wrong

Nothing is ever lost. Every file's outcome is written to the sheet as it happens, and the scan's
position is saved continuously.

| Situation | What to do |
|---|---|
| Dialog closed, tab crashed, laptop slept | Reopen the dialog → **Resume Scan** (or the trash button, if it was trashing) |
| *"Waiting… another run is still finishing"* | Nothing. It retries by itself |
| *"Trashing stopped"* or *"Scan stopped"* | Click the same button again — it continues, never repeats |
| Some rows show `Error: …` | Those files could not be trashed (usually not yours to delete). Everything else went fine |
| You swapped rows by mistake | Nothing has been trashed yet. Rows where the **Duplicate Date** is *newer* than the **Original Date** are the swapped ones; select them and use **Keep Duplicate Instead** to flip them back |

**Never press Reset Scan Progress** unless you truly want to start over — it is the one action
that cannot be undone, and it also deletes the record of what was already trashed.

> **Why some duplicates never appear:** Google Docs/Sheets/Slides have no content hash, and
> empty files match everything, so neither is ever reported. Shortcuts are ignored. The dialog
> tells you how many files were skipped for these reasons.

---

# Developer reference

Everything below is for working *on* the script rather than *with* it: version history first,
then how it works internally, then the clasp/git workflow.

## Status — v5.0

v5.0 is a rewrite of the storage and scanning layer. It is **pushed to the live project
and byte-verified against it, but not yet exercised against a real Drive folder.** Run it
on a small test folder before pointing it at anything that matters.

What changed from v4.1:

| Area | v4.1 | v5.0 |
|------|------|------|
| Checkpoint store | whole file list in one `ScriptProperties` value (**9 KB cap → broke past ~40 files**) | append-only sheets in the bound spreadsheet |
| Hashing | downloaded every file < 20 MB and MD5'd the bytes; `LARGE_<size>` above that | Drive's own `md5Checksum` — **nothing is downloaded**, no size limit |
| Tree walk | recursion, re-descended from the root on every resume | breadth-first queue sheet + cursor, O(1) resume, page-token-accurate |
| Live status | two `setProperty` round-trips **per file** | one throttled `CacheService` write per ~2 s |
| Result delivery | whole duplicate array through `google.script.run` into `innerHTML` | written to the **Duplicates** sheet; dialog gets a summary |
| Deleting | one call with every ID; no resume | `trashDuplicates`, per-row Status column, resumes across the 6-min limit |
| Concurrency | none | `LockService` around scan and trash |

Migration note: the first run after upgrading should start with **🚀 Angel → Reset Scan
Progress** to clear v4's leftover `TEMP_FILE_LIST` / `SCANNED_FOLDERS` properties.

**v5.0.1** — first live run. The scan itself worked (real md5 hashes, correct sizes and
paths), but clearing a checkpoint sheet threw *"Sorry, it is not possible to delete all
non-frozen rows."* Sheets refuses `deleteRows(2, lastRow - 1)` whenever `maxRows` equals
the last data row — reachable both by hand-deleting rows and, possibly, by the grid
growing to exactly fit an append. Fixed by clearing with `clearContent` instead of
`deleteRows` (`clearData`), which is immune to either, and by growing the grid explicitly
in `appendRows` with 100 rows of headroom.

**v5.1** — clickable links for review. The **Duplicates** sheet now has a **Duplicate Link**
and an **Original Link** column, each holding the file's `https://drive.google.com/file/d/<id>/view`
URL as a live hyperlink, so a pair can be opened and compared straight from the row before
anything is trashed. The links are written as *rich text*, not `=HYPERLINK()` formulas —
`appendRows` forces its range to plain-text format (the guard that stores a file named
`=total.xlsx` as text), which would turn a formula into literal text; rich text is immune
to that and `getValues()` still returns the plain URL. `getSheet` now also repairs a header
row that does not match the current layout, so a `Duplicates` sheet written by v5.0 is
re-headed (and its now-misaligned rows dropped) on the next scan instead of silently
mislabelling columns.

**v5.2** — partial results and resilience. A scan of a large tree ran for many executions
and then died with a dialog reading *"Failed: undefined"*, leaving ~1600 already-identified
duplicates unusable because the trash button only appeared after a **completed** scan. Three
things changed:

- **A scan no longer has to finish to be useful.** *Pause & Compare* (dialog) or
  **🚀 Angel → Compare Files Scanned So Far** (menu, works even with the dialog closed) stops
  the walk at the next folder boundary, compares everything recorded so far and fills the
  Duplicates sheet. Those rows can be trashed immediately; *Resume Scan* continues at the
  cursor. Re-comparing later **carries over the Status** of rows already handled, so trashing
  work is never lost or repeated. The pause flag travels through `CacheService`, not
  `ScriptProperties` — the property store is read into an execution once, so a running scan
  would not reliably see a flag set by the execution serving the button click.
- **Failures retry instead of dead-ending.** The dialog re-invokes after a failed call (6
  attempts, 6 s apart) because the server-side checkpoint survives; server errors come back
  as `{error, resumable}` instead of throwing at the client, `describeError` fixes the
  `undefined` message, and transient Drive/Sheets errors (rate limits, 5xx, *"failed while
  accessing document"*) are retried in place with backoff. A folder that cannot be listed at
  all (no permission, deleted mid-scan) is skipped instead of ending the walk.
- **Trashing got faster and restartable.** Status is written in batches of 50 instead of one
  `setValue` per row — the single-cell write was the bottleneck that made ~1600 rows need
  several executions — and the dialog offers the trash button whenever the sheet holds
  unhandled rows, however the scan that produced them ended. The soft deadline moved to
  4.5 min for more headroom under the 6-min kill.

**v5.3** — per-row swap, and the ID column out of the way. The Duplicates sheet now reads
`Duplicate Name · Duplicate Link · Duplicate Path · Original Name · Original Link ·
Original Path · Size · Duplicate ID · Hash · Status · Swap ⇄` — the two sides side by side,
with the raw ID moved back among the machine-facing columns.

**Swap ⇄** is a checkbox per row that behaves like a button: tick it and the Duplicate and
Original sides of that row trade places, so the copy shown as the duplicate is the one that
survives and the file that was the original gets trashed instead. The box clears itself
immediately (via the `onEdit` simple trigger), a toast confirms what happened, and rows
already marked `Trashed` refuse to swap — the file is in the bin, so the row would describe
something that no longer exists. **🚀 Angel → Keep Duplicate Instead (selected rows)** does the
same for a whole selection.

Two details worth knowing:

- The new duplicate ID is parsed back out of the **Original Link**, which is the reason that
  column holds a full URL rather than link text — the two sides stay swappable without a
  second hidden ID column.
- A re-compare **remembers swaps**. `readPairChoices` records which of the two files each
  pair currently calls the duplicate; when `runDeduplication` rebuilds the list and its own
  scan-order default disagrees, the reviewer's choice wins instead of being silently flipped
  back. Whatever is swapped, each content-identical group keeps at least one copy: *n* copies
  produce *n−1* rows, so at most *n−1* distinct files can ever be trashed.

Status carry-over also became layout-independent (`readByHeaders` locates `Duplicate ID` and
`Status` by header name), so upgrading past a column change no longer loses the record of
what was already trashed.

**v5.4** — the newest copy is the original. Of a set of byte-identical files, the one with
the most recent date is kept and **every older copy is listed for trashing**. Before this,
"original" simply meant *first seen by the breadth-first walk*, which is an artefact of
folder order, not a decision.

- The date is Drive's `modifiedTime`, falling back to `createdTime` for a file that has
  none — the constant `DATE_FIELD` switches which one (a fresh scan is needed after
  changing it, since the scan is what records the date).
- The scan now stores that date per file, so `_scan_files` grew a **Date** column and the
  Duplicates sheet gained **Duplicate Date** / **Original Date** — the rule is only
  trustworthy if you can see what it decided on.
- Dates are kept as Drive's RFC 3339 strings, which sort correctly as plain text, so no
  parsing is needed to compare them; the sheet shows them formatted in the spreadsheet's
  own timezone.
- An undated file never wins over a dated one, and exact ties fall back to scan order, so
  rebuilding the list twice always picks the same keeper.
- Comparison is now grouped rather than streamed: all copies of one hash are collected,
  the keeper is chosen, and the rest become rows against it — so duplicates of the same
  file sit together in the sheet. Manual **Swap ⇄** decisions still overrule the rule and
  still survive a re-compare.

Because the file record layout changed, `_scan_files` is re-headed (and emptied) on the
first run of this version. `restartWalkIfRecordsLost` catches the state that would
otherwise cause — a queue cursor deep in the tree with no file records behind it, which
would silently skip every folder already walked — and restarts the walk from the root.
**A scan in progress when you upgrade therefore starts over**; a finished one just needs
running again to pick up dates.

**v5.4.1** — lock contention is no longer fatal. A trash run mid-way through ~1600 rows
stopped with *"Trashing stopped: Another operation is running."* One chunk of the chain
called the server while the previous execution still held the script lock; that reply was
not flagged resumable, so the dialog treated ordinary contention as a dead end. It is
self-clearing by construction — an execution cannot hold the lock past the 6-minute limit
— so the right response is to wait.

- `busyReply` marks it `busy` + `resumable`, and the server now waits `LOCK_WAIT` (20 s)
  for its predecessor before answering at all, so most contention never reaches the client.
- The dialog waits 20 s and calls again on `busy`, up to 20 times (≈ 7 min, comfortably
  longer than any lock can be held), reporting *"Waiting… progress so far is safe"* rather
  than stopping. Its retry budget is separate from the failure budget, since waiting is
  not failing.
- While trashing, Resume/Compare stay disabled. A state refresh used to re-enable them
  mid-run, and starting a scan during a trash run is one way to *cause* the contention.

Nothing was ever at risk: Status is written per row as the run proceeds, so clicking the
button again always continues rather than repeating.

**v5.4.2** — the menu swap respects filters. Filtering the Duplicates sheet, selecting the
visible rows and running **🚀 Angel → Keep Duplicate Instead** used to swap **every row in
the selected span**, including everything the filter had hidden: a filtered result looks
contiguous but its row range covers the hidden rows between. Ctrl-clicking several blocks
was wrong in the other direction — `getActiveRange()` returns only one range, so the rest
were silently ignored.

`selectedDataRows` now walks every range of `getActiveRangeList()`, de-duplicates
overlapping ranges (a swap is its own inverse, so swapping a row twice would undo it),
clamps to real data, and skips any row hidden by a filter or by hand — reporting them as
*"340 hidden row(s) skipped"* instead of acting on them. The **Swap ⇄** checkbox was never
affected: `onEdit` only ever acts on rows whose box is actually ticked.

Recovering from a swap made in error: a swap only rewrites cells, so nothing in Drive has
moved. Rows where **Duplicate Date is newer than Original Date** are the swapped ones
(`=IF(D2="","",D2>H2)` flags them), and re-running the swap on the same rows flips them
back. Note that `Ctrl+Z` cannot undo a script's edits, and a re-compare deliberately
*keeps* swaps, so it will not clean them up either.

**v5.4.3** — logging. Until now a run left no trace: when a menu swap appeared to do
nothing there was no way to tell whether it had run at all, skipped every row, or never
fired. `logIt` writes one line per meaningful step to the Executions log — read it in
**Extensions → Apps Script → Executions**, signed in as *the account that ran it*, since
executions run as the acting user and another account's view looks empty.

A filtered menu swap now reads back like this:

```
Dedup swapSelectedRows start {"sheet":"Duplicates"}
Dedup selection resolved {"ranges":["2:5"],"lastDataRow":5,"willAct":3,"hiddenSkipped":1,"rows":"2, 4, 5"}
Dedup swapSelectedRows done {"swapped":3,"hiddenSkipped":1,"alreadyTrashed":0,"unusable":0}
Dedup swapSelectedRows rows swapped 2, 4, 5
```

Traced: both swap paths (menu and checkbox) with the rows resolved and each skip's reason,
every scan chunk's outcome, compare totals, each trash chunk's counts, lock contention,
`resetToken`, and the walk restart. Deliberately aggregate — one line per file would flood
the log and slow a 37K-file walk. The swap also toasts as well as alerting, since a modal
is easy to miss and was previously the only sign the menu item had run.

**v5.5** — built for the whole tree. A ~100k-file, 800 GB folder exposed two costs that grow
with the scan rather than staying flat, which is what stops a large tree from ever finishing.

- **The per-chunk file-ID preload is gone.** Every scan chunk used to read back every
  recorded file ID to keep `_scan_files` free of repeats — a read that grows with every file
  scanned and would come to dominate each 4.5-minute execution. Repeats are now collapsed by
  ID in `runDeduplication`, which already reads the list exactly once, and a per-execution
  set still covers the common case (a folder re-listed after a stale page token). This is
  load-bearing: a file recorded twice would otherwise look like two copies of itself and be
  offered up for trashing *against itself* — hence a harness check for exactly that, using
  both a re-listed folder and a file reachable through two parents.
- **The compare streams `_scan_files`** in 50k-row pages (`forEachDataRow`) instead of
  pulling a million-plus cells into one array.
- **Decoration is resumable.** The compare writes row values first — that is what trashing
  reads, so the list is usable immediately — then makes the URLs clickable and adds the swap
  boxes under the deadline. If it runs out of time it records the first undecorated row in
  `LINKS_FROM` and the dialog finishes the job a chunk per call (`finishPendingLinks`),
  instead of the whole compare timing out and restarting from scratch forever. Undecorated
  rows hold plain URL text, which every code path already reads as text.

Also: `lastDuplicateRow` bounds decoration by the last row with a Duplicate ID rather than
`getLastRow()`, so a helper column filled down past the data cannot stretch the work, and
`linkRuns` steps over blank cells because a rich text value needs actual text.

**Why not scan subtrees separately?** Because duplicates that span subtrees — the same file
in two different branches — would never be found, and that is the most common shape of
accumulated duplication. The 800 GB is irrelevant: no file is ever downloaded, only
metadata, so file and folder *counts* are the only thing that scales.

**v5.6** — a `Copies` column, right after `Size`. A duplicate row said nothing about how large
its family was: a row could be one of two or one of nine, and the only way to tell was to
count neighbours sharing a hash. `Copies` now states the family size (keeper included) on
every row of it, which matters because the swap rule is *one row per family* — see
[ARCHITECTURE.md §2.3](ARCHITECTURE.md).

`Copies` and `Size` are also written back as **real numbers** rather than text. `appendRows`
forces the block to plain text so a file named `=total.xlsx` cannot become a formula; correct
for names, wrong for numerics, where it makes `"9" > "10"` and breaks filter-by-number. Both
columns are rewritten with a numeric format after the append (`numberColumn`), so sorting by
size and filtering for `Copies > 2` behave as expected.

**v5.7** — the scan no longer needs your computer. Until now the dialog was the only scheduler:
each chunk existed because an open browser tab asked for it, so closing the lid paused a
multi-hour walk. **🚀 Angel → Run Scan in the Background** installs a time-driven trigger that
fires every 5 minutes server-side, so the scan and the comparison continue with the machine
switched off. **Stop Background Scan** cancels it; it also removes itself once the work is done.

Three limits, all deliberate:

- **It never trashes.** Discovery, comparison and decoration are reversible; trashing is not,
  and nothing irreversible should run while nobody is watching. The trigger stops and leaves
  the sheet for review. The harness asserts no tick ever calls `setTrashed`.
- **5 hours of runtime per day** (`BG_DAILY_BUDGET_MS`), self-imposed below the ~6 h/day
  Workspace trigger pool so about an hour stays free for other scheduled scripts. Reaching the
  cap does not uninstall the trigger — ticks return immediately until the date rolls over, so
  work resumes by itself. The last tick before the cap also shortens its own slice
  (`processFolder(url, maxMs)`) rather than overshooting.
- **It yields to you.** `processFolder` clears the pause flag when it starts, so a naive trigger
  would undo *Pause & Compare* on its next firing. The tick checks for a pause request first and
  uninstalls itself if it finds one — so pausing is also how you take back manual control.

Quotas are **per user**, and `ScriptProperties` / `CacheService` / `LockService` are
**script-scoped**, so a second account with edit access resumes the same scan at the same cursor
on its own daily budget — a legitimate way past an exhausted quota. Caveats: triggers belong to
whoever installed them, and `setTrashed` can fail on files that account doesn't own (those rows
show `Error: …` and can be retried by the owner). See
[ARCHITECTURE.md §4](ARCHITECTURE.md) for the full scheduler model.

**v5.8** — unattended trashing, a visible pause, and a ledger that matches Google's clock.

- **The daily budget now rolls at midnight US Pacific** (`QUOTA_TZ`), not midnight Berlin.
  Apps Script's own quotas reset at midnight Pacific, so a ledger rolling nine hours earlier
  handed out a fresh 5 h while Google still considered the day spent — and those ticks ran
  straight into a quota error.
- **Pause is a button, not a trick.** While a scan is looping the top button becomes **Pause
  Scanning** (stops at the next folder, no compare); while trashing, the red button becomes
  **Pause Trashing** (the batch in flight finishes, then it stops). Closing the dialog still
  works and remains the safety net.
- **Background trashing** (`backgroundTrashTick`), for lists too long to sit through — 72,000
  rows is ~7 h of runtime. It shares the *same* 5 h/day ledger as background scanning, so
  whichever runs first spends it, and the two are **mutually exclusive**: one background job
  at a time, since they contend for the same lock. It requires an explicit confirmation every
  time it is enabled, and removes its own trigger when no row is left pending.
- **Hard guards on what may be trashed**, in `trashOneRow`, applying to both the dialog and the
  background runner: the row must be present in the sheet (re-read every batch — never cached,
  so deleting a row is final), have an empty Status, carry a hash and a well-formed file ID,
  and — new — **its original must still be alive**. A duplicate whose keeper is already in the
  trash is `Skipped:`, not trashed, because trashing it could leave a set of identical files
  with no live copy. That costs one Drive read per family, cached per execution, and is
  switchable via `VERIFY_KEEPER`.
- The background trash runner also **refuses to run on an older sheet layout** rather than
  letting `getSheet` migrate it, since migration clears rows — and it never compares, so
  deleted rows are never silently regenerated and then trashed.

**v5.9** — no button that invites a mistake. `processFolder` is one pipeline: when the walk
finishes, that same execution sets the phase to `DEDUPE`, runs the comparison, and deletes the
phase marker. So a completed scan has *already* compared — yet the dialog still offered
*"Compare 315041 Scanned Files Now"*, which read like pending work and, if pressed, rebuilt the
list from scratch. That matters because **a rebuild resurrects rows the reviewer deleted**, with
an empty Status, which queues them for trashing — the exact opposite of the intent behind
deleting them.

- Once the phase marker is empty, the button is replaced by a sentence: *"Scan complete —
  nothing left to compare. 315,041 files scanned, 72,308 duplicates listed, 72,308 still to
  trash."* The **paused/partial case keeps the button**, since comparing an unfinished scan is
  a real feature.
- Hiding a button only lowers the odds, so both remaining routes now ask first. The dialog
  confirms whenever a compare would replace an existing list, and **🚀 Angel → Compare Files
  Scanned So Far** confirms when no scan is in progress — spelling out that deleted rows will
  come back. A partial scan still compares without a prompt.

> **Don't hand-edit the checkpoint sheets.** `QUEUE_CURSOR` is a positional index into
> `_scan_queue`; deleting rows above it silently shifts the scan onto the wrong folders,
> so a resumed scan can under-report duplicates. Use **🚀 Angel → Reset Scan Progress**.

## How it works (complete flow)

| Stage | Function(s) | What happens |
|-------|-------------|--------------|
| Menu | `onOpen`, `showUi` | Adds the **🚀 Angel** menu and opens `Progress.html` as a modeless dialog. |
| Unattended | `setBackgroundScan`, `backgroundScanTick` | A 5-minute time-driven trigger drives scan → compare → decorate with no browser open, inside a 5 h/day self-imposed runtime budget, and removes itself when done. Never trashes; stops if a pause is requested. |
| Scan | `processFolder`, `scanUntilDeadline` | Breadth-first walk driven by the `_scan_queue` sheet and a cursor in properties. Each folder is listed with `Drive.Files.list` (Advanced Drive Service); rows are appended to `_scan_files` in batches of 200. |
| Hash | (none — Drive supplies it) | Uses Drive's own `md5Checksum` field. **No file is ever downloaded**, so there is no size limit and no `LARGE_<size>` fallback. |
| Resume | `processFolder` (timeout branch) | On the 4.5-min soft limit the buffers are flushed, the queue cursor + page token are saved, and `{timeout:true}` is returned; the dialog re-invokes to continue. Resume is O(1) — no re-walking the tree. |
| Pause | `requestPause`, `scanUntilDeadline` | A cache flag polled ~every 2 s by the walk. It flushes and returns `'PAUSED'` at a folder boundary, so partial results can be compared and trashed mid-scan. |
| Detect | `runDeduplication`, `pickKeeper` | Groups `_scan_files` by `md5 + size`; the newest copy of each group is the original, every older one becomes a row in the **Duplicates** sheet. Runnable at any time via `compareScannedSoFar`; carries over the Status of rows already handled and any manual swaps. |
| Report | `getLiveStatus`, `getState`, `Progress.html` | Live status is throttled into `CacheService` (~1 write / 2 s) and polled by the dialog; `getState` lets a reopened dialog resume and re-offer the trash button. |
| Delete | `trashDuplicates` | Trashes every un-handled row of the Duplicates sheet, writing `Trashed` / `Error: …` into the Status column in batches of 50. Resumes across the 6-min limit like the scan. |
| Swap | `onEdit`, `swapKeeper`, `swapSelectedRows` | The **Swap ⇄** checkbox flips one row's Duplicate and Original sides and clears itself; the new duplicate ID is parsed out of the Original Link. Nothing in Drive moves — only which ID `trashDuplicates` will read. |
| Recover | `withRetry`, `describeError`, `isSkippableFolderError` | Transient Drive/Sheets errors are retried with backoff, unreadable folders are skipped, and every failure reaches the dialog as a message it can retry from. |

## State storage

All bulk state lives in sheets of the bound spreadsheet; `ScriptProperties` holds only
small cursors (`PHASE`, `ROOT_ID`, `QUEUE_CURSOR`, `PAGE_TOKEN`, `LINKS_FROM`) plus the
background runner's daily ledger (`BG_DAY`, `BG_USED_MS`). `CacheService` carries the
two cross-execution signals — the live status (`STATUS`) and the pause request
(`PAUSE_REQUEST`).

| Sheet | Columns | Role |
|-------|---------|------|
| `_scan_files` | File ID, Name, Size, Path, Hash, Date | append-only record of every file seen |
| `_scan_queue` | Folder ID, Path | the folder frontier + a cursor into it |
| `Duplicates` | Duplicate Name/Link/Path/Date, Original Name/Link/Path/Date, Size, Copies, Duplicate ID, Hash, Status, Swap ⇄ | the reviewable result |

> **Why not `ScriptProperties`?** A single property value is capped at **9 KB** — about
> 40 file records. v4 checkpointed the whole file list into one property, so every scan
> larger than ~40 files threw `Argument too large: value` at the 5.5-min mark, lost all
> its work, and surfaced as a generic alert instead of resuming. Sheets also allow
> *incremental appends*, so checkpoint cost stays flat instead of rewriting the entire
> list every few minutes.

## Known limits

Why the exclusions above exist, in technical terms:

- **Google-native files** (Docs/Sheets/Slides) have no `md5Checksum`, so comparing them would
  mean exporting each to PDF and hashing that — slow and unsafe. They are recorded in
  `_scan_files` but never grouped.
- **Zero-byte files** are excluded because every empty file matches every other one.
- **Shortcuts** are skipped; a file reachable through several parents is recorded more than
  once and collapsed by ID at compare time.
- Paths are relative to the scanned root, not to My Drive.

## Repository layout

| Path | Purpose |
|------|---------|
| `src/appsscript.json` | Apps Script manifest (timezone Europe/Berlin, V8 runtime, Advanced Drive Service v3) |
| `src/Code.js` | Server-side Apps Script logic |
| `src/Progress.html` | Client-side dialog UI |
| `.clasp.json` | clasp config — `scriptId` + `rootDir: src` |
| `.claspignore` | Restricts pushes to the three source files |

## Production workflow (clasp + git)

The Apps Script project is the source of truth for *running*; this git repo is the source
of truth for *history*. Keep them in sync with clasp — run clasp commands from **inside
this `Deduplicator/` directory**.

**Accounts**
- clasp is authenticated as **createk.corporation@gmail.com** (has edit access to the script).
- Script ID: `1U_Ej4u1kFRmR3ywpdnCHmbjImRxuNzZmIu5DRHMw6SpKpHFKzrH-k2lb`

**Pull remote changes into git** (after editing in the Apps Script IDE):
```bash
clasp pull            # updates src/ from the live project
git add -A && git commit -m "Pull: <what changed>" && git push
```

**Push local changes to the live project** (after editing files here):
```bash
clasp push            # updates the live Apps Script project from src/
git add -A && git commit -m "Push: <what changed>" && git push
```

> **After the first push of v5.0**: the manifest now enables the **Advanced Drive Service
> (v3)**. Open the script (`clasp open-script`) and run `showUi` once — Apps Script will
> prompt for re-authorization because of the new service. If the editor reports that the
> Drive API is not enabled for the project, enable it under **Services → Drive API**
> (or in the associated Cloud project) before the first scan.

**Handy commands**
```bash
clasp status                 # list files clasp will push
clasp open-script            # open the Apps Script IDE
clasp show-authorized-user   # confirm which Google account clasp uses
```

> ⚠️ Never commit `.clasprc.json` — it holds OAuth tokens. It lives in your home
> directory (`~/.clasprc.json`) and is also git-ignored here as a safeguard.

## Container binding

This is a **container-bound** script, bound to the Google Sheet **"DuplicateFinder"**:

- Spreadsheet ID: `1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0`
- Sheet URL: <https://docs.google.com/spreadsheets/d/1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0/edit>
- Owner: kai.bolik@createk.biz

Because it is bound, the `onOpen` **🚀 Angel** menu appears automatically in that
spreadsheet, and `SpreadsheetApp.getUi()` works. To open the code from the sheet:
**Extensions → Apps Script**. `clasp pull` / `clasp push` sync this repo with that same
bound project (scriptId `1U_Ej4u1kFRmR3ywpdnCHmbjImRxuNzZmIu5DRHMw6SpKpHFKzrH-k2lb`).
