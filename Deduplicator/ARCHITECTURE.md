# Deduplicator — Architecture

**Scope.** A container-bound Google Apps Script that walks a Google Drive folder tree,
identifies byte-identical files, presents them for human review in the bound spreadsheet,
and moves the redundant copies to Trash. Target workload at time of writing: ~10⁵ files /
~10⁴ folders / 800 GB in a single tree.

**Design constraint that shapes everything.** Apps Script kills any execution at **6
minutes**. There is no long-running process, no background worker, and no durable
in-process memory. Every unit of work must therefore be (a) decomposable into sub-6-minute
slices, (b) checkpointed to durable storage between slices, and (c) resumable in O(1) — not
by replaying from the beginning. The architecture is essentially a *hand-rolled resumable
job runner* built out of a spreadsheet, three key–value stores, and **one of two
interchangeable schedulers**: a browser tab, or a time-driven trigger (§4). Because the
schedulers hold no state, either can pick up a job the other started.

---

## 1. Component model

```mermaid
graph TB
  subgraph Browser["Browser — Progress.html (sandboxed iframe)"]
    UI["Dialog: buttons + live status"]
    SCHED["Scheduler loop:<br/>re-invokes until done,<br/>retries failures,<br/>waits out lock contention"]
  end

  subgraph Server["Apps Script server — Code.js (one execution per call, ≤6 min)"]
    SCAN["processFolder / scanUntilDeadline<br/>BFS discovery"]
    CMP["runDeduplication / pickKeeper<br/>hash bucketing"]
    DEC["decorateRows<br/>links + checkboxes"]
    TRASH["trashDuplicates"]
    SWAP["onEdit / swapSelectedRows<br/>reviewer overrides"]
  end

  subgraph Durable["Durable state — the bound Spreadsheet"]
    FILES["_scan_files<br/>append-only file record"]
    QUEUE["_scan_queue<br/>BFS frontier"]
    DUPES["Duplicates<br/>reviewable result + audit trail"]
  end

  subgraph KV["Coordination stores"]
    PROPS["ScriptProperties<br/>PHASE, ROOT_ID, QUEUE_CURSOR,<br/>PAGE_TOKEN, LINKS_FROM"]
    CACHE["CacheService<br/>STATUS, PAUSE_REQUEST"]
    LOCK["LockService<br/>one job at a time"]
  end

  TRIG["Time-driven trigger<br/>backgroundScanTick every 5 min<br/>no browser required"]
  DRIVE["Drive API v3<br/>metadata only"]

  TRIG -->|"scan + compare only,<br/>never trash"| SCAN
  TRIG --> DEC
  TRIG --> PROPS
  SCHED -->|google.script.run| SCAN
  SCHED --> CMP
  SCHED --> TRASH
  SCHED --> DEC
  UI -->|poll ~1 s| CACHE
  SCAN --> DRIVE
  TRASH --> DRIVE
  SCAN --> FILES & QUEUE
  SCAN --> PROPS
  CMP --> FILES
  CMP --> DUPES
  DEC --> DUPES & PROPS
  TRASH --> DUPES
  SWAP --> DUPES
  SCAN & CMP & TRASH --> LOCK
```

### Responsibilities

| Component | Owns | Deliberately does *not* own |
|---|---|---|
| `Progress.html` | Scheduling (when to call again), retry policy, contention back-off, user intent | Any state worth keeping — it is disposable; closing the tab loses nothing |
| `backgroundScanTick` | The same scheduling role without a browser: one slice per trigger firing, plus its own daily runtime budget | Trashing — nothing irreversible runs unattended |
| `processFolder` | One slice of work; phase transitions; converting every failure into a resumable reply | Deciding *how many* slices are needed |
| `scanUntilDeadline` | BFS frontier advance, batched appends, checkpoint on exit | Duplicate detection, de-duplication of records |
| `runDeduplication` | Grouping, keeper selection, result materialisation, status/override carry-over | Trashing, and anything irreversible |
| `decorateRows` | Cosmetics (clickable links, swap checkboxes), resumably | Anything trashing depends on |
| `trashDuplicates` | Irreversible Drive mutation, one row at a time, with a per-row audit mark | Deciding *which* copy survives |
| `onEdit` / `swapSelectedRows` | Reviewer overrides, recorded in the sheet where they survive rebuilds | Drive mutation of any kind |

### Why a spreadsheet is the database

`ScriptProperties` caps a single value at **9 KB** — roughly 40 file records. v4 checkpointed
the whole file list into one property and consequently died at ~40 files with `Argument too
large`. Sheets give three properties that matter here: *incremental append* (checkpoint cost
stays flat instead of rewriting the whole list), *10 million cells* of capacity, and — not to
be underrated — the result is **directly reviewable and editable by a human**, which is the
actual product requirement. The reviewer's edits (deleted rows, swaps) are input to the next
compare, so the database and the UI being the same artefact is a feature, not a shortcut.

---

## 2. The search algorithm

This is the part most often assumed to be quadratic, so it is worth being precise.

### 2.1 What we are *not* doing

The naive formulation — "compare each new file with all files read so far" — is
Θ(N²/2) pairwise comparisons:

| Files (N) | Naive pairwise comparisons |
|---|---|
| 1 000 | 500 000 |
| 37 000 | ~6.8 × 10⁸ |
| 100 000 | ~5.0 × 10⁹ |
| 200 000 | ~2.0 × 10¹⁰ |

At 100k files that is ~5 billion comparisons — hopeless inside 6-minute slices, and it is
also the reason the naive design cannot be checkpointed usefully (each new file depends on
every earlier one). Note the growth is *quadratic*, not exponential (2^N); but quadratic is
already fatal at this N, so the distinction is academic here.

### 2.2 What we actually do — hash bucketing

**Zero pairwise comparisons are performed.** Equality is decided by a key, and identical
keys collide into the same bucket of a hash map:

```
key(file) = md5Checksum + "_" + size
```

```mermaid
graph LR
  A["_scan_files<br/>N records, streamed in 50k pages"] --> B["single pass:<br/>groups[key].push(record)"]
  B --> C["per group with ≥2 members:<br/>pickKeeper = newest date"]
  C --> D["emit 1 row per non-keeper"]
  D --> E["Duplicates sheet"]
```

Cost per file: one hash-map insert, expected O(1). Total: **Θ(N) expected time**, one pass,
no comparison matrix. Concretely at N = 100 000: 100 000 map operations — microseconds of
CPU, entirely dominated by the cost of *reading* the rows out of Sheets.

Three properties make the key trustworthy:

1. **The hash is free.** `md5Checksum` comes from Drive's own metadata via the Advanced Drive
   Service. **No file content is ever downloaded**, which is why 800 GB costs exactly the
   same as 800 MB. Only *counts* scale.
2. **Size is a co-discriminator.** MD5 alone is collision-prone under adversarial input;
   pairing it with the exact byte size makes an accidental false match effectively
   impossible for non-adversarial data. (Adversarial MD5 collisions *with equal size* are
   constructible — see §8 Risks.)
3. **Absence is handled explicitly.** Google-native files (Docs/Sheets/Slides) have no
   `md5Checksum`, and zero-byte files match each other trivially. Both are recorded and
   **excluded from detection** rather than guessed at.

### 2.3 Groups of three or more — how a multi-copy family is represented

A "duplicate" is not a pair. A content group is a set of *n* byte-identical files, and the
representation is deliberately **star-shaped, not pairwise**: one keeper, and *n − 1* rows
each pointing at it.

For a group of 5 copies where `E` is the newest:

| Row | Duplicate (gets trashed) | Original (survives) | Copies | Hash | Status |
|---|---|---|---|---|---|
| 1 | A | E | 5 | `9f2c…` | |
| 2 | B | E | 5 | `9f2c…` | |
| 3 | C | E | 5 | `9f2c…` | |
| 4 | D | E | 5 | `9f2c…` | |

Consequences worth being explicit about:

- **Row count is n − 1, never n(n−1)/2.** A group of 5 produces 4 rows, not 10. The star
  shape is what makes the sheet reviewable: no pair matrix, and the surviving copy is stated
  on every row rather than inferred.
- **`Copies` states the family size** (keeper included) on every row of it, so a row is
  visibly "one of five" rather than something to infer by counting neighbours. It is written
  as a real number, not text, so filtering for `Copies > 2` — the families where the one-swap
  rule matters — works.
- **The `Hash` column is the group identity.** There is no group-ID column; sorting or
  filtering on `Hash` (column L) collects a family, and the repeated Original columns confirm
  they share a keeper.
- **Rows of a group are written adjacently**, because emission iterates group by group.
  Sorting the sheet afterwards is safe — see below.
- **Groups are ephemeral, the sheet is a materialised view.** No group state is persisted
  anywhere: `groups` exists only inside one compare execution and is recomputed
  deterministically from `_scan_files` on the next one. Nothing to corrupt, nothing to migrate.

#### The at-least-one-survivor guarantee, restated for n > 2

Trashing takes the **set of distinct `Duplicate ID` values**. A group of *n* contributes at
most *n − 1* rows, hence at most *n − 1* distinct IDs — so **at least one copy always
survives, whatever the reviewer does**. This holds by construction, not by a check.

#### Overriding the keeper in a group of 3+

Swap the *one* row whose Duplicate is the copy you want to keep. Group `A B C` with `A`
newest, rows `(B→A)` and `(C→A)`:

| Action | Resulting trash set | Survivor |
|---|---|---|
| No swap | {B, C} | A |
| Swap row 1 → `(A→B)` | {A, C} | B |
| Swap row 2 → `(A→C)` | {A, B} | C |
| **Swap both rows** | {A} — `A` is now the Duplicate on both rows | **B *and* C both survive** |

The last line is the one to know: swapping *every* row of a family does not designate a
keeper, it collapses the trash set to a single ID and leaves the family duplicated. It
over-keeps — it never destroys — but the redundancy stays. One swap per group is the
operation that means "keep this one instead".

A swapped row can also make the sheet look self-contradictory: after swapping row 1, row 1
says *trash A* while row 2 still calls `A` the original. Both are honoured — the trash set is
a union — and the outcome (B survives) is correct. The `Original` column describes *that
row's* comparison, not a global promise.

#### Tracking across rebuilds

Three different keys carry state across a re-compare, and none of them is a row position — so
sorting or filtering the sheet is safe at any time:

| What must survive | Keyed by | Read back by |
|---|---|---|
| Which copies are already trashed | `Duplicate ID` (file ID) | `readStatusByFileId` |
| Reviewer's keeper overrides | unordered pair `{dupeId, origId}` | `readPairChoices` |
| Group membership | `md5 + size` | recomputed, never stored |

`readPairChoices` records which of the two files the sheet currently calls the duplicate and
compares it against the date rule's default; where they disagree, the reviewer's decision
wins. In a 3+ group this is evaluated per pair, so a single swapped row stays swapped while
its siblings continue to follow the date rule.

### 2.4 Keeper selection

Within a group, the surviving copy is the one with the most recent date (`modifiedTime`,
falling back to `createdTime`). `pickKeeper` is a single `reduce` — Θ(group size), so Θ(N)
in total across all groups.

Dates are stored as Drive's **RFC 3339 strings** and compared as *text*. This is deliberate:
the format is fixed-width, UTC-normalised and most-significant-first, so lexicographic order
equals chronological order. No parsing, no `Date` objects, no timezone arithmetic in the hot
path — 10⁵ `new Date()` allocations avoided.

Two tie-breaks keep the output **deterministic**, which matters because the list is rebuilt
repeatedly: an undated file never beats a dated one, and an exact date tie falls back to scan
order (`seq`).

### 2.5 Discovery is breadth-first over a sheet, not recursion

```
queue      = _scan_queue rows      (append-only; grows as folders are found)
cursor     = QUEUE_CURSOR property (integer index into that sheet)
pageToken  = PAGE_TOKEN property   (position inside the current folder's listing)
```

The frontier lives in a sheet and the read head is an integer. Consequences:

- **No recursion**, so no stack depth limit and no re-descent from the root on resume.
- **Resume is O(1)**: read the cursor, continue. v4 re-walked from the root on every resume,
  making a long scan quadratic in the *number of resumes*.
- **Sub-folder granularity**: `PAGE_TOKEN` means a folder with 50 000 children can itself be
  spread across executions.
- **Cycle-safe**: Drive is a DAG (multi-parent files, shortcuts). Folder IDs already queued
  are tracked in a set; shortcuts are skipped outright, since they point elsewhere.

API cost is **Θ(F + N/1000)** Drive calls — one `Files.list` per folder plus one per extra
page of 1000 children. This, not CPU, is the wall-clock cost of the scan.

---

## 3. Operational flow — which sheet is used when, and what each decision touches

The three sheets are not interchangeable stores; they form a pipeline, and each stage reads
the one behind it. `_scan_queue` drives discovery, `_scan_files` is the immutable record
discovery produces, and `Duplicates` is a *derived, disposable view* of `_scan_files` that
doubles as the reviewer's workspace and the audit trail.

```mermaid
flowchart TD
  OPEN([Reviewer opens the dialog]) --> ST["getState<br/>reads Duplicates + properties"]
  ST --> WHAT{"What does the reviewer do?"}

  WHAT -->|"Analyze Folder<br/>(new URL)"| FRESH["startFreshScan<br/>CLEARS _scan_files + Duplicates<br/>seeds _scan_queue with the root"]
  WHAT -->|"Resume Scan"| SLICE
  FRESH --> SLICE

  SLICE["scanUntilDeadline — one ≤4.5 min slice<br/>read frontier from _scan_queue at QUEUE_CURSOR"]
  SLICE --> DRIVE["Drive Files.list<br/>metadata only, 1000 per page"]
  DRIVE --> APPEND["append files → _scan_files<br/>append new folders → _scan_queue<br/>checkpoint QUEUE_CURSOR + PAGE_TOKEN"]
  APPEND --> DONE{"Frontier<br/>exhausted?"}
  DONE -->|"no — deadline hit"| SLICE
  DONE -->|"no — pause requested"| PAUSED(["Paused<br/>cursor holds the position"])
  DONE -->|yes| CMP

  WHAT -->|"Pause &amp; Compare"| PAUSEREQ["requestPause → cache flag<br/>slice stops at a folder boundary"]
  PAUSEREQ --> PAUSED
  PAUSED --> CMP
  WHAT -->|"Compare Files Scanned So Far"| CMP

  CMP["runDeduplication<br/>streams _scan_files, buckets by md5+size,<br/>picks the newest per family"]
  CMP -.->|"carries forward, keyed by ID and by pair"| CARRY["Status of trashed rows<br/>+ reviewer swaps<br/>read from the OLD Duplicates rows"]
  CARRY --> WRITE
  WRITE["REWRITES Duplicates<br/>one row per redundant copy"]
  WRITE --> DEC["decorateRows<br/>links + checkboxes, resumable via LINKS_FROM"]
  DEC --> REVIEW

  REVIEW{"Reviewer works the sheet"}
  REVIEW -->|"Swap ⇄ / menu swap"| SWAP["swapKeeper<br/>rewrites 8 cells in that row<br/>NO Drive effect"]
  REVIEW -->|"delete a row"| DEL["excluded from this trash run only<br/>(a later compare regenerates it)"]
  REVIEW -->|"sort / filter"| SAFE["no effect — all state is keyed<br/>by file ID, never by row position"]
  SWAP --> REVIEW
  DEL --> TRASH
  SAFE --> TRASH
  REVIEW -->|"Move Duplicates to Trash"| TRASH

  TRASH["trashDuplicates<br/>every row with an empty Status"]
  TRASH --> MUTATE["Drive: setTrashed per file<br/>write Status per 50 rows"]
  MUTATE --> LEFT{"Rows left<br/>before deadline?"}
  LEFT -->|yes| TRASH
  LEFT -->|no| END(["Done — Status column is the audit trail"])

  WHAT -->|"Reset Scan Progress"| RESET["CLEARS all three sheets,<br/>properties and cache"]
  RESET --> OPEN
```

### What each reviewer decision actually touches

| Decision | Code path | Sheets / stores written | Drive effect | Reversible? |
|---|---|---|---|---|
| **Analyze Folder** (new URL) | `startFreshScan` → `seedQueue` | Clears `_scan_files` **and** `Duplicates`; seeds `_scan_queue`; sets `ROOT_ID`, `QUEUE_CURSOR`, `PHASE` | None | Destroys prior scan + review state |
| **Resume Scan** | `processFolder` → `scanUntilDeadline` | Appends to `_scan_files` / `_scan_queue`; advances `QUEUE_CURSOR`, `PAGE_TOKEN` | Reads only | N/A — additive |
| **Pause & Compare** | `requestPause` (cache) → next slice returns `PAUSED` → `compareScannedSoFar` | Rewrites `Duplicates` | None | Yes — `Resume Scan` continues |
| **Compare Files Scanned So Far** (menu) | `compareScannedSoFar` | Rewrites `Duplicates`, preserving `Status` + swaps | None | Yes — idempotent |
| **Swap ⇄** (checkbox or menu) | `onEdit` / `swapSelectedRows` → `swapKeeper` | 8 cells + ID + `Status` clear, in that row only | **None** | Yes — swap again to revert |
| **Delete a row by hand** | — | `Duplicates` only | None | Only until the next compare, which regenerates it |
| **Sort / filter the sheet** | — | Nothing | None | Yes — no state is positional |
| **Move Duplicates to Trash** | `trashDuplicates` | `Status` per row, batched 50 | **Trashes files** | Only via Drive Trash |
| **Reset Scan Progress** | `resetToken` | Clears all three sheets + all properties + cache | None | **No** — the scan and the audit trail are gone |

Two properties of this pipeline are worth stating explicitly, because they are what make the
tool safe to interrupt at any point:

1. **`Duplicates` is derived, and rewritten wholesale on every compare.** Nothing is
   *incrementally* maintained there. What survives a rewrite does so by being re-derived:
   `Status` by file ID, swaps by unordered pair. Everything else — row order, deleted rows,
   helper columns' meaning — does not.
2. **Only one stage mutates Drive.** Discovery, comparison, decoration and swapping are all
   read-only with respect to Drive; `trashDuplicates` is the sole irreversible step, and it
   is gated behind an explicit confirmation and a per-row audit mark.

## 4. The two schedulers — attended and unattended

Nothing in the server keeps a job moving; something has to ask for the next slice. There are
two things that can do that, and they are interchangeable because **neither holds state**.

| | Dialog (`Progress.html`) | Time-driven triggers |
|---|---|---|
| Requires | An open browser tab, machine awake | Nothing — runs on Google's servers |
| Cadence | Immediately after each reply (3 s gap) | Every `BG_EVERY_MINUTES` = 5 min |
| Duty cycle | ~100 % while open | ~90 % (4.5 min of work per 5 min) |
| Runtime budget | The account's own daily quota | Additionally capped at `BG_DAILY_BUDGET_MS` = 5 h/day |
| Stops when | Paused, the tab closes, or the job finishes | The job finishes, a pause is requested, or the daily cap is hit |

There are **two** trigger handlers, deliberately separate and mutually exclusive:

| Handler | Does | Guard on enabling |
|---|---|---|
| `backgroundScanTick` | Scan → compare → decorate. **Never trashes.** | Refuses if the trash runner is installed |
| `backgroundTrashTick` | Works through the reviewed Duplicates sheet | Requires `confirmed === true` *every* time, and refuses if the scan runner is installed |

One background job at a time, because they contend for the same lock and draw on the same
ledger. Each removes its own trigger when its work is done, so re-enabling always means
re-confirming.

### Why the *scan* trigger will not trash

Discovery, comparison and decoration are all reversible: they read Drive and write a derived
sheet. Trashing is the one irreversible step, so it is not something a scan should drift into
while nobody is watching — a mistaken keeper choice discovered the next morning is worth far
less than one caught before confirming. `backgroundScanTick` therefore stops at a reviewable
sheet, and the harness asserts it: no scan tick ever calls `setTrashed`.

Unattended trashing exists as its own opt-in because a 72,000-row list is ~7 h of runtime —
more than a day's quota and far more than anyone will sit through. The distinction that makes
it safe is *when* the human decision happens: by the time this runs, the list has already been
reviewed, and the runner is only executing it.

### What the trash path is allowed to touch

`trashOneRow` is the single gate, used by both schedulers. A row is acted on only if it:

1. **is present in the Duplicates sheet** — re-read from the sheet on every batch, never
   cached in properties, so a row the reviewer deletes is gone for good and is never trashed;
2. **has an empty Status** — nothing is trashed twice;
3. **carries a hash and a well-formed file ID** (`looksLikeFileId`: URL-safe characters only,
   so a filename or a stray sentence in the wrong column is refused, not obeyed) — i.e. the row
   was written by this tool rather than typed;
4. **names an original that is still alive** (`isFileAlive`, one Drive read per family, cached
   per execution, switchable via `VERIFY_KEEPER`).

Rule 4 is the interesting one. It exists because of a failure actually observed in this
project: a layout migration cleared the sheet from a non-compare code path, taking the recorded
swap decisions with it. A rebuilt sheet then reapplied the date rule, which for a swapped pair
nominates the copy that had *already been trashed* as the keeper — and would have listed the
survivor for trashing, leaving a set of identical files with nothing live. The check turns that
into `Skipped: the original is already in the trash`, which is recoverable: ticking **Swap ⇄**
on the row flips the sides and clears the Status, so it is retried against the live copy.

An unreadable original counts as *not alive*, so an unverifiable keeper blocks its duplicates
rather than waving them through.

The background trash runner adds two refusals of its own: it will not run if the sheet's header
row does not match the current layout (rather than letting `getSheet` migrate it, which clears
rows), and it never compares — so deleted rows cannot be regenerated behind the reviewer's back
and then trashed.

### Yielding to the reviewer

Both schedulers can be active at once, which raises two conflicts, both resolved in favour of
the person:

1. **Lock contention** — whichever arrives second gets `busyReply` and simply waits. Already
   the general mechanism (§9), so the trigger needed nothing new.
2. **A pause request** — `processFolder` clears the pause flag at the start of a run, so a
   naive trigger would undo a reviewer's *Pause & Compare* on its next firing. `backgroundScanTick`
   therefore checks `pauseRequested()` **before** calling anything and, if set, uninstalls its
   own trigger. Pausing is thus also the way to take back manual control.

### The daily budget, and why it is self-imposed

Google gives Workspace accounts roughly **6 h/day** of trigger runtime. Spending all of it
would starve the owner's other scheduled scripts, which draw on the same per-user pool. So the
runner keeps its own ledger — `BG_DAY` plus `BG_USED_MS` in properties, wall-clock per tick,
**shared between the scan and trash runners** — and stops working at **5 h**, leaving about an
hour.

The ledger's day rolls at midnight in `QUOTA_TZ` = `America/Los_Angeles`, **not** the script's
own timezone. Apps Script's daily quotas reset at midnight Pacific; a ledger rolling at midnight
Berlin would hand out a fresh 5 h nine hours early, and those ticks would run straight into a
quota that had not reset yet. Two further details:

- **The cap does not uninstall the trigger.** Ticks keep firing and returning immediately
  (a second or so each), so work resumes by itself after midnight with no human action.
- **A tick can also be *shortened*.** `processFolder(url, maxMs)` accepts a slice length, so
  the last tick before the cap trims its own deadline rather than overshooting.

The ledger measures only this runner. Other scripts' consumption is invisible to it — which is
precisely why the budget sits below the platform ceiling rather than at it.

### Handing a job to another account

Because `ScriptProperties`, `CacheService` and `LockService` are **script-scoped, not
user-scoped**, a second account with edit access to the spreadsheet resumes exactly where the
first left off: same cursor, same page token, same `Duplicates` rows. Quotas, however, are
**per user**, so a colleague continuing the scan draws on their own daily budget. This makes
account hand-off a legitimate way to get past an exhausted quota.

Two caveats:

- **Triggers belong to the account that installed them.** A background run set up by A keeps
  running as A and counts against A's quota; B must install their own.
- **Trashing needs permission on each file.** Scanning only requires read access, but
  `setTrashed` on a file B does not own can fail. Those rows come back as
  `Error: …` in the Status column and can be retried by the owner — no silent skips.

## 5. Time budget and how work is sliced

| Constant | Value | Rationale |
|---|---|---|
| Hard kill | 6 min | Platform limit, not ours |
| `MAX_RUNTIME` | 4.5 min | Soft deadline; the 1.5-min margin absorbs a flush, a retry with backoff, and the final checkpoint write |
| `FLUSH_EVERY` | 200 rows | Bounds work lost to an unclean kill; one `setValues` per 200 files instead of per file |
| `PAGE_SIZE` | 1000 | Drive's max page — fewest round trips per folder |
| `STATUS_EVERY` | 2000 ms | Live status is *sampled*, not streamed: one cache write per 2 s regardless of file rate |
| `TRASH_FLUSH` | 50 rows | Status was one `setValue` per row; that single-cell write was the bottleneck that made 1 600 rows take several executions |
| `LINK_CHUNK` | 500 rows | Rich-text payload per write |
| `READ_PAGE_ROWS` | 50 000 | Caps peak memory when streaming a large sheet |
| `LOCK_WAIT` | 20 s | Absorbs contention between consecutive slices of the same job without a client round trip |
| `BG_EVERY_MINUTES` | 5 | Trigger cadence; one minute more than a slice, so firings do not overlap |
| `BG_DAILY_BUDGET_MS` | 5 h | Self-imposed share of the ~6 h/day trigger pool, leaving ~1 h for other scripts |
| `BG_MIN_SLICE_MS` | 30 s | Below this the remaining budget is not worth a tick's own overhead |

### One scan slice

```mermaid
sequenceDiagram
  participant C as Client loop
  participant S as processFolder
  participant P as Properties
  participant D as Drive
  participant SH as Sheets

  C->>S: processFolder(url)
  S->>S: tryLock(20s)
  S->>P: read PHASE, QUEUE_CURSOR, PAGE_TOKEN
  S->>SH: read _scan_queue (frontier)
  loop until deadline / pause / queue exhausted
    S->>D: Files.list(folder, pageSize 1000)
    S->>S: partition into folders / files / shortcuts
    S->>SH: append 200-row batch when buffered
    S->>P: checkpoint cursor + page token
  end
  S->>SH: final flush
  S-->>C: {timeout:true} | {paused:true} | summary
  C->>S: call again (3 s later) if not done
```

The client is the scheduler; the server is stateless between calls. This is why closing the
tab, a dropped connection, a laptop sleeping or a hard 6-minute kill are all the same event:
*the loop stops calling*. The checkpoint is already durable, so recovery is one button.

---

## 6. Complexity and capacity summary

N = files, F = folders, G = distinct content groups, D = duplicate rows (D ≤ N − G).

| Stage | Time | Peak memory | Durable writes | Slice-safe? |
|---|---|---|---|---|
| Discovery | Θ(F + N/1000) API calls, latency-bound | **Θ(F + n_slice)** — frontier, folder-ID set, and the IDs recorded *by this slice only* | N + F rows, appended in 200-row batches | Yes — cursor + page token |
| Compare | Θ(N) expected | **Θ(N)** — see §7.1, the binding constraint | D rows, one `setValues` | Partially — values are atomic per run; decoration resumes |
| Decoration | Θ(D) | Θ(500) per chunk | 2 rich-text writes + 1 checkbox insert per 500 rows | Yes — `LINKS_FROM` |
| Trash | Θ(D) API calls, latency-bound | Θ(D) row snapshot | 1 status write per 50 rows | Yes — per-row `Status` |
| Swap | Θ(rows selected) | Θ(1) | 4 cell writes per row | N/A — interactive |

### Observed and projected wall clock

| Workload | Scan | Compare | Trash |
|---|---|---|---|
| 37 000 files (measured) | ~1 h across auto-resumed slices | seconds → 3 700 rows | ~15–30 min for 2 500 files |
| ~100 000 files (projected) | 2–4 h unattended | tens of seconds → ~10 000 rows | ~1 h for 10 000 files |

Trashing is one Drive mutation per file (~200–500 ms) and cannot be batched through
`DriveApp`; it is inherently latency-bound.

---

## 7. Scalability constraints — ranked by how soon they bite

### 7.1 Compare-stage memory — **the binding constraint**

`runDeduplication` holds one JS object per hashed file record in `groups`. That is **Θ(N)
resident memory** inside a single execution:

| N | Approx. resident objects | Assessment |
|---|---|---|
| 100 000 | 100 000 × ~6 fields | Comfortable |
| 200 000 | ~200 000 | Expected to hold; untested |
| 500 000 | ~500 000 | **Likely to fail** — Apps Script's memory ceiling is undocumented, and large-array failures manifest as an opaque kill |

Already mitigated: `forEachDataRow` streams the sheet in 50 000-row pages, so the raw 2-D
array is never resident *in addition* to the map (a 1.2M-cell read was the earlier risk).

Two escape hatches if N approaches 5 × 10⁵, in increasing order of effort:

1. **Aggregate-only first pass.** Keep `Map<key, {count, keeper}>` instead of full member
   lists; a second streaming pass emits rows for non-keepers. Same asymptotics, materially
   smaller constants — no per-group arrays.
2. **Sheet-side sort, then stream.** Sort `_scan_files` by `Hash`+`Size` (Sheets does this
   server-side, outside our 6-minute budget), then walk it once: identical keys are adjacent,
   so only the *current* group is ever resident. Peak memory becomes **Θ(largest group)** —
   effectively O(1). This is the design to adopt if this tool is ever pointed at a
   million-file corpus.

### 7.2 Per-slice startup cost that scales with the job

Each scan slice re-reads `_scan_queue` to rebuild the frontier and its folder-ID set: **Θ(F)
per slice**. At F = 20 000 that is ~40 000 cells, one to three seconds — acceptable against a
270-second budget. At F = 200 000 it would consume a visible fraction of every slice.

*This class of bug already bit once and was fixed:* the scan used to re-read **every recorded
file ID** each slice (Θ(N) per slice, N growing monotonically) to keep `_scan_files` free of
repeats. That cost compounds — the further you get, the slower you go — and it is precisely
what prevents a large tree from ever finishing. Repeats are now collapsed by ID at compare
time, which already reads the list exactly once, with a per-execution set covering the common
case (a folder re-listed after a stale page token).

That trade-off carries a **load-bearing invariant**: a file recorded twice must never be
reported as a duplicate *of itself*. `runDeduplication` de-duplicates by file ID on the way
in; the test suite asserts this for both mechanisms that produce repeats (stale-page-token
re-listing, and a file reachable through two parents).

### 7.3 Spreadsheet capacity — 10 million cells, shared

| Sheet | Cells | At N = 100k / F = 20k / D = 10k |
|---|---|---|
| `_scan_files` | 6 × N | 600 000 |
| `_scan_queue` | 2 × F | 40 000 |
| `Duplicates` | 14 × D | 140 000 |
| **Total** | | **~0.8 M of 10 M (8 %)** |

Headroom is large: the hard wall is around **N ≈ 1.5 M files**. Note the quota is
per-*spreadsheet*, so the checkpoint sheets and the human-facing result compete for the same
budget — reviewer-added helper columns count too.

### 7.4 Platform quotas — the constraint people forget

The deployment in question runs under **Google Workspace Business Standard**. Verify against
current Google documentation before relying on any figure; these change.

| Quota | Consumer Gmail | **Workspace (this deployment)** | Relevance |
|---|---|---|---|
| Runtime per execution | 6 min | 6 min | Architected around |
| **Total script runtime / day** | ~90 min | **~6 h** | At ~6 h, a projected 2–4 h scan plus ~1 h of trashing fits inside one day with headroom. On a consumer account the same job would stop mid-way and resume the next day |
| **Trigger runtime / day** | ~90 min | **~6 h** | The pool the background runner draws on. `BG_DAILY_BUDGET_MS` caps *our* share at 5 h so other scheduled scripts keep about an hour |
| Simultaneous executions | 30 | 30 | We hold one, plus the client's next call |
| Drive API requests | ~1 000 / 100 s / user | same | Θ(F + N/1000) calls spread over hours is far below this |
| Properties value / total | 9 KB / 500 KB | same | Why bulk state is in sheets |
| Cache value / TTL | 100 KB / 6 h | same | Status and pause flag only |

The daily-runtime ceiling is what can turn "unattended overnight" into "several days". It is
not a failure mode — the checkpoint simply waits — but it is a planning input, and it is the
quota most likely to be forgotten when this tool is copied to another account tier.

**Tier note.** The published figures split by *account type*, not by Workspace edition:
consumer Gmail on one side, Google Workspace on the other. **Business Starter and Business
Standard therefore carry the same ~6 h/day**, as do Enterprise and Education. The difference
between those editions lies in storage and features, not Apps Script runtime. Since the quota
pool is **per user**, an exhausted budget can also be worked around by continuing from a second
account with access — see §4, *Handing a job to another account*.

### 7.5 Latency floors that no amount of code removes

Discovery is ~1 API round trip per folder; trashing is exactly 1 per file. Both are bound by
Drive's response time, not by our CPU. The only lever is fewer round trips (already at
`PAGE_SIZE` = 1000), so **the scan cannot be made materially faster** within this platform.
Parallelism is not available: Apps Script has no threads, and concurrent executions would
contend for the same lock and checkpoint.

---

## 8. Correctness invariants and risk register

### Invariants the implementation guarantees

| Invariant | Mechanism |
|---|---|
| **Every content group keeps at least one copy** | n copies produce n−1 rows, so at most n−1 distinct files can ever be trashed — *regardless* of how the reviewer swaps rows. Reinforced at the point of deletion by rule 4 of `trashOneRow`, which refuses a duplicate whose original is already in the trash |
| **A row deleted from the sheet is never trashed** | The list is re-read from the sheet on every batch and never cached, so deletion takes effect immediately and permanently |
| **Only rows this tool wrote can trigger a deletion** | `trashOneRow` requires a hash and a URL-safe file ID; hand-typed or mis-pasted rows are refused as `Error:` |
| Compare is idempotent | Rebuilding the list yields the same rows; `Status` carries over by file ID, reviewer swaps carry over by unordered pair key |
| No work is lost to a failure | Every slice checkpoints before exiting; every failure is returned as `{error, resumable}` rather than thrown at the client |
| Trashing never repeats | Per-row `Status` gates re-attempts; re-trashing an already-trashed file is a no-op anyway |
| A filename cannot become a formula | Appended ranges are forced to plain-text number format first — a file named `=total.xlsx` is stored as text |
| A filter cannot cause invisible edits | Row-hidden checks in `selectedDataRows`; the checkbox path only ever acts on ticked rows |
| Reviewer overrides survive rebuilds | `readPairChoices` compares the sheet's stated duplicate against the date rule's default and preserves the difference |

### Risks

| Risk | Severity | Status |
|---|---|---|
| **MD5 + size collision on adversarial input** | Data loss | Accepted. Chosen-prefix MD5 collisions with equal length are constructible; two *deliberately crafted* files would be judged identical. Irrelevant for organic document corpora; unacceptable if this were ever pointed at untrusted uploads, where SHA-256 (requiring content download) would be needed |
| Compare-stage memory at N ≫ 2 × 10⁵ | Job cannot complete | Mitigations designed, not implemented (§7.1) |
| Clearing the `Duplicates` sheet erases reviewer overrides | Data loss on a *subsequent* compare+trash | Documented in README; overrides live only in that sheet |
| Hand-editing `_scan_queue` | Silent under-reporting | `QUEUE_CURSOR` is positional; deleting rows above it shifts the walk. Documented; `Reset Scan Progress` is the supported path |
| Daily runtime quota exhaustion | Schedule slip only | Inherent; checkpoint waits |
| Drive rate limits / 5xx | Slice failure | `withRetry` with exponential backoff on transient errors; unreadable folders are skipped rather than fatal |

---

## 9. Coordination: why three different stores

| Store | Holds | Why not one of the others |
|---|---|---|
| Sheets | Bulk records (N + F + D rows) | Only store with the capacity, append semantics, *and* human reviewability |
| `ScriptProperties` | 5 small cursors | Durable across executions; 9 KB/value makes it useless for bulk |
| `CacheService` | Live status, pause request | **The property store is read into an execution once**, so a running scan cannot reliably observe a flag another execution just set. Cache reads cross that boundary — which is exactly what "pause the scan from a button click" requires |
| `LockService` | Mutual exclusion | Scan, compare and trash all rewrite the same sheets; the lock serialises them, and contention is reported as `busy` (retryable) rather than as failure |

**Failure semantics by design:** the client treats three replies differently — `busy`
(wait 20 s, retry, separate budget from failures, because waiting is not failing),
`resumable` error (retry up to 6 times, 6 s apart), and terminal error (stop and explain).
This is why a 3 700-row trash run survives lock contention, a killed execution and a network
blip without a human deciding anything.

---

## 10. Where to look in the code

| Concern | Symbol |
|---|---|
| Slice orchestration, phase machine | `processFolder` |
| BFS advance, checkpointing | `scanUntilDeadline`, `seedQueue`, `restartWalkIfRecordsLost` |
| Hash bucketing, keeper choice | `runDeduplication`, `pickKeeper` |
| Streaming a large sheet | `forEachDataRow` |
| Resumable cosmetics | `decorateRows`, `finishPendingLinks`, `lastDuplicateRow`, `linkRuns` |
| Unattended scheduling | `setBackgroundScan`, `backgroundScanTick`, `setBackgroundTrash`, `backgroundTrashTick`, `bgBudget`, `bgSpend`, `removeTriggers`, `triggerExists`, `backgroundInfo` |
| Irreversible stage | `trashDuplicates`, and its per-row gate `trashOneRow` / `looksLikeFileId` / `isFileAlive` |
| Reviewer overrides | `onEdit`, `swapSelectedRows`, `selectedDataRows`, `swapKeeper`, `readPairChoices` |
| Resilience primitives | `withRetry`, `isTransient`, `describeError`, `busyReply` |
| Layout migration | `getSheet`, `writeHeaders`, `headersMatch`, `readByHeaders` |
| Observability | `logIt`, `setStatus`, `getLiveStatus`, `getState` |
| Client scheduler | `Progress.html` — `callScan`, `handleFinish`, `runTrash`, `waitForLock`, `finishLinks` |

---

## 11. Verification approach

The logic is exercised against a **fake Sheets/Drive API** (an in-memory sheet model with
ranges, rich text, checkboxes, filters and selections, plus a fake trigger registry) so that
column layouts, the keeper rule, swap semantics, repeat collapsing, status carry-over, layout
migration, deferred decoration and both background runners' lifecycles are all asserted without
touching a real spreadsheet — currently 118 assertions.

Notable among them, because they encode promises rather than mechanics: a repeated file record
is never reported as a duplicate of itself; a swap of every row in a family over-keeps instead
of destroying; **no scan tick ever calls `setTrashed`**; a duplicate whose original is already
in the trash is skipped; an unverifiable original blocks trashing too; and **a row cleared from
the sheet is never trashed by a background tick**.

Two limits worth stating plainly: the harness models the API's *contract*, not Google's
performance, so **no memory or timing claim in §7 is measured** — those are reasoned
estimates, and the 2 × 10⁵ threshold in §7.1 in particular is an untested projection. And
the harness is a development artefact, not part of the deployed script.

---

## 12. If this were rebuilt at 10× scale

The current design is the right shape for 10⁵ files inside Apps Script. Beyond ~10⁶, the
platform — not the algorithm — is the wrong host:

1. **Sort-then-stream the compare** (§7.1) — the single highest-value change, and it fits
   the current architecture.
2. **Move discovery to Drive's `changes`/incremental listing** so re-scans are deltas rather
   than full walks. Today a second run over the same tree costs the same as the first.
3. **Leave Apps Script.** A service account plus a real datastore removes the 6-minute
   slicing, the daily runtime ceiling, and the single-threaded latency floor at once — at the
   cost of the property that makes this tool usable today: the result is a spreadsheet the
   owner already knows how to review.
