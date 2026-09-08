# Browser disc host

This change implements issues #3 and #4 through a minimal local launcher and Gecko's worker API. The prior audit established that Gecko's full-disc IPL-HLE path is reusable, its in-memory ISO implementation cannot fit the browser memory limit, and its DOM host requires a separate worker entry.

## Interfaces

- `web/disc.mjs`: `inspectLocalDisc(Blob)` returns header, executable hash and FST metadata. It uses bounded file slices and never reads the entire disc into memory.
- `web/disc.mjs`: `makeDiscReader(file, FileReaderSync)` returns a checked synchronous range reader for the worker. No network API is used.
- `web/worker.mjs`: owns the selected file, calls the Gecko `WorkerRuntime` API, and sends measured CPU state and VI-boundary counters to the launcher.
- `web/main.mjs`: local file selection, validation, firmware selection, launch/stop, keyboard and standard gamepad sampling.
- `scripts/build.mjs`: copies an explicit list of application sources and a locally built Gecko package to ignored `dist/`. It never copies private input directories.
- `scripts/serve.mjs`: serves only regular allowed application files contained in `dist/`, bound to loopback. It rejects writes, private paths and filesystem escapes.

## Work and checks

- [x] Write Node tests using synthetic disc structures for bounded reads, layout errors, hashes and short-read failures; observe failure before implementing.
- [x] Implement browser-local validation and synchronous worker disc reads.
- [x] Connect the real Gecko worker API and its existing WebGPU renderer in source.
- [x] Build the actual WASM package and inspect generated files.
- [ ] Observe the browser runtime locally; no browser is connected in the current session.
- [x] Verify firmware input errors and record the native missing-firmware stop separately from synthetic checks.
- [x] Run Python/Node tests, formatting and diff review.
- [ ] Check staged source boundaries, open a linked draft PR and inspect CI, including a fresh build against the pinned Gecko revision.

Full audio, calibrated controller configuration, persistent storage and measured full-speed playability retain their own issues. Diagnostic boot without DSP firmware must be explicitly selected and labeled; it is not a valid retail-compatibility result. The image remains in the browser's local file object. OPFS caching can be added behind the same synchronous reader contract after direct-file behavior is measured.
