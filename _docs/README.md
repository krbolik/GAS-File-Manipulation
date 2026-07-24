# GAS-File-Manipulation

Workspace holding several **Google Apps Script** projects for manipulating Google Drive
files. Each script lives in its own subdirectory with its own clasp config and README —
run `clasp pull` / `clasp push` from **inside** the relevant subdirectory.

## Scripts

### [`Deduplicator/`](../Deduplicator/README.md)
Recursively scans a Drive folder, finds duplicate files by **content hash** (Drive's own
`md5Checksum`, so no file is downloaded), and moves duplicates to Trash. Bound to the
**DuplicateFinder** Sheet, which doubles as the checkpoint store — scans resume across
the Apps Script 6-minute limit.
→ [README](../Deduplicator/README.md)

### [`MergeGoogleFolders/`](../MergeGoogleFolders/README.md)
Recursively **merges** a source Drive folder tree into a destination, matching by
**name** (newest wins). Has a safe dry-run mode.
→ [README](../MergeGoogleFolders/README.md)

## Layout

```
.
├── _docs/README.md                # this file
├── .gitignore
├── .github/workflows/deploy.yml   # optional CI: clasp push per script (needs CLASPRC_JSON secret)
├── Deduplicator/                  # script project
│   ├── .clasp.json                # { "scriptId": "...", "rootDir": "src" }
│   └── src/  appsscript.json, Code.js, Progress.html
├── MergeGoogleFolders/            # script project
│   ├── .clasp.json
│   └── src/  appsscript.json, Code.js
└── _shared/                       # optional shared utilities (copied/linked into src/ later)
```

## Notes

- Each subdirectory has its own `.clasp.json` (its own `scriptId`) and `.claspignore`.
  clasp commands must be run from within that subdirectory.
- clasp is authenticated globally via `~/.clasprc.json` (git-ignored — never commit it;
  it holds OAuth tokens).
- **CI** ([.github/workflows/deploy.yml](../.github/workflows/deploy.yml)) can `clasp push`
  each project on changes to `main`; it needs a `CLASPRC_JSON` repo secret. Add new
  scripts to its matrix.
- See each subproject's README for setup, usage, and the container Sheet requirements.
