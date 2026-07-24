# shared/

Optional home for utility code shared across the Apps Script projects in this repo
(e.g. common Drive helpers, logging, folder-ID parsing).

Apps Script projects can only push files that live under their own `src/` directory, so
sharing here is by **copy** or a build/link step — not a runtime import. Typical options:

- Keep the canonical version of a helper here and copy it into each `*/src/` before
  `clasp push` (a small script or the CI workflow can do this).
- Or symlink `shared/<file>` into each `src/` locally (note: `clasp` follows the file, and
  `.claspignore` must allow-list it).

Empty for now — add shared utilities here when the projects start to duplicate logic.
