# Private data and publication

Game images, console firmware, extracted executables and assets, runtime memory, save states, memory cards, screenshots, video, and audio stay on the user's machine. They must never enter Git history, GitHub issues or PR attachments, CI inputs or artifacts, releases, telemetry, or hosted application files. The original disc is opened read-only.

The application will accept files through browser-local APIs. It must never upload a selected disc, extracted data, firmware, or saves. Network traffic for loading application code is separate from game-data access. CI uses only synthetic fixtures created from source code and never needs a retail game.

## Private locations

| Directory | Contents |
| --- | --- |
| `.private/discs/` | Original local disc images |
| `.private/system/` | User-supplied console firmware |
| `.private/extracted/` | Required local extraction output |
| `.private/upstream/` | Local research checkouts and their build products |
| `.private/runtime/` | Saves, memory cards, state, and caches |
| `.private/logs/` | Local build and runtime diagnostics |
| `.private/captures/` | Private visual or audio comparisons |

The repository ignore rules cover these paths and common game-derived extensions regardless of capitalization. Upstream research checkouts have their own Git indexes, so their generated-file rules must also be verified before every commit.

## Before publishing source

Stage specific source files. Run `python tools/publication.py --staged`, inspect `git diff --cached --stat` and the complete diff, and inspect any generated files. The checker reads the staged blobs, rejects binary content and unreviewed file formats, and limits each file to 2 MiB. CI repeats the check against the committed tree.

The checker is deliberately limited to source text. It cannot prove the provenance of text, detect every encoded asset, or prevent a manual force-add followed by bypassing the checks. CI checks the final tree; it does not erase or validate earlier commits automatically. Before pushing, inspect every new commit and check it with `python tools/publication.py --revision COMMIT`. Deleting private material in a later commit does not remove it from history. If an original project asset is needed later, add a narrow reviewed allowance with provenance rather than broadly allowing images or archives.

Run local static servers with the application output directory as the document root. Keeping `.private/` ignored does not prevent a server from exposing it. Development tooling must not expose the workspace or private research tree over HTTP.

## Public bug reports

Describe the subsystem, observed behavior, expected behavior, emulator revision, browser version, PC/LR, and relevant register or address metadata. Keep memory dumps, screenshots, FIFO captures, trace payloads, and game-derived output private. Scrub local paths and review diagnostics before copying text into a public report.
