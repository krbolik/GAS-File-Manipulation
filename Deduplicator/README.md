# Deduplicator

Version-controlled source for the **Tech Angel Deduplicator** Google Apps Script — a
tool that recursively scans a Google Drive folder, finds duplicate files by content
hash, and moves them to Trash. The script is bound to the **"DuplicateFinder"** Google
Sheet and is fully functional in production today.

## How to use

1. Open the bound Google Sheet
   ([DuplicateFinder](https://docs.google.com/spreadsheets/d/1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0/edit)).
2. In the menu bar, click **🚀 Angel → Start Deduplicator**. A dialog opens.
3. Paste a **Google Drive folder URL** (e.g. `https://drive.google.com/drive/folders/<id>`)
   and click **Analyze Folder**.
4. Watch the live status (parent folder / current folder / active file). If the scan hits
   the Apps Script 6-minute limit it **pauses and auto-resumes** until the whole tree is
   covered — no action needed.
5. When the scan finishes, the dialog lists every duplicate with its full path and where
   the original lives. Click **Move Duplicates to Trash** and confirm.
6. To discard a paused or stale scan and start clean: **🚀 Angel → Reset Scan Progress**.

> The tool only ever trashes the **duplicate** copy (the first file seen for each
> content hash is kept as the original). Trashed files stay recoverable from Drive Trash.

## How it works (complete flow)

| Stage | Function(s) | What happens |
|-------|-------------|--------------|
| Menu | `onOpen`, `showUi` | Adds the **🚀 Angel** menu and opens `Progress.html` as a modeless dialog. |
| Scan | `processFolder`, `scanRecursive`, `getFullPath` | Recursively walks the folder. Each file < 20 MB is MD5-hashed; larger files use a `LARGE_<size>` marker. Progress + the file list are checkpointed in `ScriptProperties`. |
| Resume | `processFolder` (timeout branch) | On the ~5.5-min soft limit the run saves `TEMP_FILE_LIST` + `SCANNED_FOLDERS` and returns `{timeout:true}`; the dialog re-invokes it to continue where it left off. |
| Detect | `runDeduplication` | Groups files by `hash + size`; the first is the original, later matches are duplicates. |
| Report | `getLiveStatus`, `Progress.html` | Polls live status during the scan and renders the duplicate list at the end. |
| Delete | `deleteSelectedFiles` | Moves the selected duplicate IDs to Trash via `DriveApp.getFileById(id).setTrashed(true)`. |

## Repository layout

| Path | Purpose |
|------|---------|
| `src/appsscript.json` | Apps Script manifest (timezone Europe/Berlin, V8 runtime) |
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
