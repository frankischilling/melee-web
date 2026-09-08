# Initial source audit

Inspected on September 7, 2026, before changing emulator source.

| Repository | Revision | Role |
| --- | --- | --- |
| [ioncodes/gecko](https://github.com/ioncodes/gecko) | `da39be17b22eb7316e772d2369da15df3a52f7f0` | Executable GameCube runtime |
| [doldecomp/melee](https://github.com/doldecomp/melee) | `8b1aafcd1e89a17555a00f3b1f1c469158554a33` | Decompilation, symbols and behavior reference |

The forks are under `frankischilling`. Each private local checkout has `origin` pointing to that fork and `upstream` pointing to the corresponding repository above. No web infrastructure was added to the Melee tree.

## Gecko interfaces

Paths below refer to the pinned Gecko revision.

| Area | Source | Observed behavior |
| --- | --- | --- |
| Browser entry | `crates/web/src/lib.rs::start_emulator` | Accepts IPL or DOL bytes. No complete-disc entry; installs a queued render sink. |
| Disc factory | `crates/image/src/lib.rs::load_dvd` | Owns a complete input vector; selects ISO/RVZ and optional ZIP extraction. RVZ is disabled in the web dependency configuration. |
| DVD interface | `crates/image/src/lib.rs::Dvd` | `Send` trait; synchronous reads into caller buffers, header and apploader access. Reads have no error return. |
| ISO | `crates/image/src/iso.rs` | Owns the complete disc vector and parses the FST. |
| Disc boot | `crates/gecko/src/gamecube.rs::with_ipl_hle` | Initializes low memory and BATs, loads the disc apploader and custom IPL-HLE, then inserts the DVD. |
| Native frontend | `crates/tinyapp` | Can choose IPL-HLE when a DVD is supplied without an IPL. Native disc boot is already an integration reference. |
| Rendering | `crates/backend-wgpu`; `crates/gecko/src/host.rs::RenderSink` | GxRenderer processes GX actions through wgpu. Browser rendering uses a queue drained per frame. |
| Audio | `crates/gecko/src/audio.rs::AudioSink` | Pushes stereo i16 samples/blocks and announces sample-rate changes. Web attaches no audio sink. |
| DSP firmware | `crates/gecko/src/flipper/dsp.rs` | `load_irom` and `load_coef` accept local firmware. Defaults are zero-filled arrays; no DSP HLE backend was found. |
| Input | `crates/gecko/src/flipper/si/pad.rs`; `system.rs::apply_host_input` | GameCube pad state exists for four SI ports. Current browser input is keyboard-only and applies to port zero. |
| Persistence | EXI devices and system save-state interfaces | Native file-backed memory cards and byte-based save states exist. Browser persistence is absent. |
| WASM configuration | `crates/web/Cargo.toml`; `.cargo/config.toml` | Web disables Gecko's JIT. Stack 32 MiB, initial memory 128 MiB, maximum memory 512 MiB. |

The browser host uses `web_sys::window`, DOM canvas creation, winit and egui. It cannot run unchanged inside a dedicated worker. wgpu 29 supports OffscreenCanvas, allowing a worker host to retain the renderer. Full-disc random access and worker hosting need to be designed together.

Two correctness risks need compatibility tests: the browser render sink inherits default no-op EFB readback/flush hooks that differ from the native sink; IPL-HLE does not attach the same Macronix EXI device as the real-IPL path. Neither observation proves a specific Melee failure.

`rust-toolchain.toml` pins Rust 1.96.0. `chipi-spec` and `solstice` submodules are build inputs. `.github/workflows/deploy-wasm.yml` builds regular and debug wasm-pack packages. The local unmodified `--locked` WASM attempt failed because the web lockfile needs updating. An unlocked baseline was attempted without changing emulator source. Parallel compilation was stopped when it saturated the host, then resumed with two build jobs. Final build results are recorded below when available.

## Melee reference and baseline

The target is NTSC-U 1.02, `GALE01`. `config/GALE01/config.yml` and `build.sha1` specify DOL SHA-1 `08e0bf20134dfcb260699671004527b2d6bb1a45`. This is not a whole-disc hash.

The GameCube header and FST are documented by source in `extern/dolphin/include/dolphin/dvd.h` and `extern/dolphin/src/dolphin/dvd/{fstload,dvdfs}.c`. The DOL header layout is in `extern/dolphin/include/dolphin/dolformat.h`. Its sample loader records known bugs and is not used as validator implementation.

Configure succeeded using Python 3.14 and privately installed Ninja 1.13.2. The baseline Ninja invocation downloaded open-source decomp-toolkit v1.8.3 and stopped because `orig/GALE01/sys/main.dol` had not yet been extracted. It did not compile a game executable. The command explicitly selected an absent local compiler directory to avoid automatically retrieving proprietary Metrowerks tooling:

```powershell
./.venv-audit/Scripts/python.exe configure.py --compilers build/local-compilers --no-compile-commands
./.venv-audit/Scripts/ninja.exe -v
```

After the local validator confirmed the expected hash, the DOL was supplied privately and the baseline was repeated. Decomp-toolkit found 19,827 functions and wrote 1,130 split objects. Ninja then stopped because `build/local-compilers/GC/1.2.5/mwcceppc.exe` is absent. No compilation or matching-build success is claimed.

The configured build requires GC/1.2.5 variants, GC/1.1p1 for MetroTRK, and GC/1.3.2 for linking. A complete matching build remains dependent on legitimate local compiler inputs. All baseline products and logs remain in `.private/`.

## Native-source portability research

| Dependency | Reference anchors | Work required for a future native port |
| --- | --- | --- |
| OS/threading | Dolphin OS startup, contexts, scheduler and arenas | Define host scheduling, guest contexts and memory ownership. |
| GX | GXFifo/GXInit/GXFrameBuf; baselib materials, TEV and textures | Preserve FIFO, display-list, EFB and material behavior through a graphics runtime. |
| VI | Dolphin `vi.c`; baselib `video.c` | Preserve retrace callbacks, XFB queues and draw completion ordering. |
| DVD | Dolphin DVD APIs; baselib devcom/archive; `lbfile.c` | Preserve async reads, callbacks, alignment and archive relocation. |
| PAD | Dolphin Pad; baselib controller/rumble | Preserve four-port sampling, calibration and error semantics. |
| DSP/audio and ARAM | Dolphin DSP/AI/AX/AR/ARQ; baselib synth/axdriver | Implement DSP task/mailbox and transfer timing at the host boundary. |
| EXI, SRAM and cards | OSExi/OSRtc and Dolphin card source | Define device behavior and persistence. |
| Timers/interrupts | OSTime/OSAlarm/OSInterrupt | Preserve ordering, timebase and critical sections. |
| ABI/layout/endian | Dolphin types, Runtime platform definitions, baselib archive | Handle 32-bit pointers, original bitfields and big-endian assets explicitly. |
| Assembly/compiler | Runtime setjmp/varargs, paired-single matrix code, configure flags | Validate Gekko behavior, EABI and Metrowerks assumptions separately. |

`.nix/CMakeLists.txt` and `.nix/melee-gcc-native.nix` contain a `TARGET_PC` static-library experiment with Aurora headers. It is not evidence of a runnable native or WASM game. `config/GALE01/symbols.txt` and `splits.txt` can inform traces and later recompilation analysis. Examples include `main` at `0x8015FEB4`, `OSInit` at `0x80342FC8`, and `PADInit` at `0x8034D7EC`.

## Licenses and contribution guidelines

Gecko includes a GPL-3.0 license. `chipi-spec` includes MPL-2.0; no standalone license declaration was found in the pinned `solstice` submodule during this inventory. Dependency terms require review before a packaged public release. No game or firmware license is supplied by this project.

Melee has no repository-wide license file in the inspected tree. Several tooling subdirectories have separate licenses, which do not cover all game and SDK source. Its `.github/CONTRIBUTING.md` asks for compiler matching, formatting, scoped headers and meaningful PRs. It also restricts automated review submissions. No review or contribution was submitted to the decomp upstream.

This is an inventory of files and declared terms, not a claim that all upstream material can be republished under one license. This repository contains host tools and documentation, with no copied game source or derived binaries.
