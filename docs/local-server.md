# Local build and server

The app runs from a fixed, ignored `dist` directory and a server bound to `127.0.0.1`. The build and server use Node's standard library. They do not upload files or start a browser.

Build the Gecko web package first, then provide its absolute package directory:

```powershell
npm run build -- --runtime-dir C:/absolute/path/to/gecko/crates/web/pkg
npm start
```

Open `http://127.0.0.1:5173`. To use another local port:

```powershell
npm start -- --port 5174
```

The server intentionally requires the `127.0.0.1` host name in requests. Use the printed address rather than a LAN address, hostname alias or `localhost`.

## Build boundary

The build copies these exact files from `web`: `index.html`, `app.css`, `main.mjs`, `worker.mjs`, `disc.mjs` and `controls.mjs`. It copies only `gecko_web.js`, `gecko_web_bg.wasm` and an optional JavaScript-only `snippets` tree from the runtime package. It preserves the snippets' relative paths so generated imports continue to work. Other files in either input directory are ignored.

Inputs must be regular files with no hardlink aliases. Symlinks, junctions, other path aliases and hidden or private snippet paths are rejected. Each JavaScript or app file must be smaller than 16 MiB; WASM must be smaller than 128 MiB and have a version 1 WASM header. The optional snippets tree is limited to 256 JavaScript files and 16 directory levels. Total copied inputs must be smaller than 192 MiB. The runtime package and `dist` must not contain one another.

There is no output-directory argument. The script derives the repository root from its own location and writes only its `dist` directory. It validates inputs first, stages selected files in a temporary hidden directory under `dist`, then replaces the selected outputs. It removes stale JavaScript snippets from prior builds. It does not recursively copy a private directory or delete unrelated output files. The server's allowlist blocks unrelated files left in `dist`.

Build while the server is stopped: publication replaces files individually rather than atomically switching the entire application. Keep source and destination directories under local control during the build. The path checks do not promise isolation against another process replacing directories concurrently.

## Serving boundary

`createStaticServer(root)` is exported by `scripts/serve.mjs` for tests and returns an unlistened `http.Server`. The command-line entry point always serves the repository's fixed `dist` directory and binds to IPv4 loopback. It does not expose a configurable host or filesystem root.

Only `GET` and `HEAD` are accepted; other methods return `405`. The server has no upload or write handler. It serves the six named app files, the two named runtime files, and JavaScript files below `runtime/snippets`. Unknown files, private or hidden paths, malformed URLs, traversal, path aliases and files outside the canonical root return `404`. Hardlinks are rejected as aliases. Directories are never listed. Invalid host headers return `403`.

Responses include `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, a self-only CSP allowing WebAssembly compilation, `nosniff` and `Cache-Control: no-store`. HTML, CSS and JavaScript include UTF-8 charset declarations; WASM uses `application/wasm`.

## Verification

```powershell
node --test tests/server.test.mjs
```

The tests use real temporary directories, synthetic files and HTTP requests. They cover allowed files, response headers, HEAD behavior, rejected methods, private paths, encoded traversal, symlinks, junctions, hardlinks, build allowlists, stale snippet removal and oversized runtime rejection. Link-specific tests skip when the host does not permit the necessary links. No game data is included in the fixtures.
