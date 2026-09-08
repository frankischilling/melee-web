# Local browser runtime

The application uses the Gecko worker runtime and the existing WebGPU renderer. It validates a local GALE01 revision 2 ISO/GCM, keeps the selected disc in a browser `File`, and services DVD reads in a dedicated worker with `FileReaderSync`. No whole-disc array is created. OPFS caching, audio output and save persistence are still open work.

## Build

Use Node 22 or newer, Rust 1.96.0 with the `wasm32-unknown-unknown` target, and wasm-pack. Check out the Gecko repository and exact revision recorded in `runtime.lock.json` into a private local working directory. Initialize its `submodules/chipi-spec` and `submodules/solstice` build specifications.

From that Gecko checkout:

```sh
wasm-pack build crates/web --target web --out-dir pkg --out-name gecko_web --release --no-opt -- --locked
node --test crates/web/tests/worker-smoke.mjs
```

From this application repository:

```sh
npm ci
npm run build -- --runtime-dir /absolute/path/to/gecko/crates/web/pkg
npm start
```

Use an absolute Windows path when running in PowerShell. Open `http://127.0.0.1:5173`, select the local ISO/GCM and wait for validation. Then select user-owned DSP IROM (8,192 bytes) and coefficient ROM (4,096 bytes), or explicitly choose diagnostic boot without firmware. Firmware lengths are checked, but the file contents are not authenticated by these length checks.

The local build contains only application source and compiled Gecko code. It includes no game, firmware, extracted executable or saves. [The build/server policy](local-server.md) describes its explicit copy and serving allowlists.

## Diagnostic execution

The worker yields after at most 16,000 CPU steps per host call and presents through Gecko's XFB when it reaches a VI boundary. The launcher displays actual PC/LR, CPU-step and VI-boundary counts. CPU steps include interrupt delivery; VI boundaries do not prove a new game frame was drawn. The input number measures dispatch from the main thread to the worker, not physical controller-to-screen latency.

Without DSP firmware, diagnostic execution stops when the DSP leaves halt/reset. It does not continue with zero-filled firmware. Disc read errors or a WASM trap terminate the worker; relaunch creates a new instance. Pause state is retained during asynchronous initialization, and hiding the tab pauses execution until the user resumes it.

Keyboard input and basic browser-standard gamepads reach the four GameCube ports. Controller configuration, calibration, stable reassignment after reconnect and latency benchmarking retain issue #8. The current mapping follows Gecko's native face-button layout: south=A, west=B, east=X, north=Y. The first browser gamepad slot shares port one with the keyboard.

The keyboard uses arrow keys for the main stick, I/J/K/L for D-pad up/left/down/right, and Numpad 4/6 and 8/2 for C-stick left/right and up/down. Opposing keys cancel on each stick axis; releasing the keys returns that axis to center. X/Z/C/V map to A/B/X/Y, Enter to Start, A/S to L/R, and D to Z.

## Evidence and limits

The actual release WASM package initializes in Node and passes boundary rejection tests. The application build and local HTTP server pass source, filesystem and HTTP checks. Its JavaScript validator checked the supplied 1,459,978,240-byte image in eight local slice reads: 4,456,521 bytes total, maximum individual read 1 MiB, with the expected DOL SHA-1. That is a Node host check of the shared validator, not a browser latency benchmark.

An unchanged native Gecko probe reached the real disc apploader and DOL entry before stopping at missing DSP firmware. [The source audit](source-audit.md) records the PC and step-count checkpoints. Browser rendering, the title screen, synchronized audio, persistent saves and playable performance have not been observed. Further compatibility testing requires a desktop browser with worker WebGPU support and locally supplied DSP firmware. The runtime and host PRs remain drafts pending browser verification.

The worker inherits the upstream browser sink's unsupported synchronous EFB readback behavior. A compatibility difference involving CPU EFB access must be diagnosed against native Gecko/Dolphin and fixed at the hardware/renderer boundary. No game-specific workaround has been added.
