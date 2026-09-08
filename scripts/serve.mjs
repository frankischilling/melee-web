import http from "node:http";
import { constants } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

const appFiles = new Set([
  "index.html",
  "app.css",
  "main.mjs",
  "worker.mjs",
  "disc.mjs",
  "controls.mjs",
]);
const runtimeFiles = new Set([
  "runtime/gecko_web.js",
  "runtime/gecko_web_bg.wasm",
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};
const securityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

function samePath(a, b) {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function publicPath(url) {
  const encoded = url.split("?", 1)[0];
  if (/%(?:2f|5c)/i.test(encoded)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (decoded === "/") return "index.html";
  if (!decoded.startsWith("/") || /[\\%\0]/.test(decoded)) return null;
  const relative = decoded.slice(1);
  const parts = relative.split("/");
  if (
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) ||
        /^(?:private|local|vendor)$/i.test(part) ||
        part.endsWith("."),
    )
  )
    return null;
  if (appFiles.has(relative) || runtimeFiles.has(relative)) return relative;
  if (
    parts.length >= 3 &&
    parts[0] === "runtime" &&
    parts[1] === "snippets" &&
    relative.endsWith(".js")
  )
    return relative;
  return null;
}

async function openPublicFile(root, relative) {
  if (
    !samePath(await realpath(root), root) ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new Error("aliased root");
  let candidate = root;
  for (const part of relative.split("/")) {
    candidate = path.join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error("aliased path");
  }
  if (!samePath(await realpath(candidate), candidate))
    throw new Error("noncanonical path");
  const resolved = path.relative(root, candidate);
  if (
    resolved.startsWith(`..${path.sep}`) ||
    resolved === ".." ||
    path.isAbsolute(resolved)
  )
    throw new Error("outside root");
  const file = await open(
    candidate,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await file.stat();
    const limit = relative.endsWith(".wasm")
      ? 128 * 1024 * 1024
      : 16 * 1024 * 1024;
    if (!info.isFile() || info.nlink !== 1 || info.size >= limit)
      throw new Error("unsupported file");
    return { file, info };
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Return an unlistened server; the CLI below binds only to IPv4 loopback. */
export function createStaticServer(root) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(securityHeaders))
      res.setHeader(name, value);
    const reply = (status, text) => {
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
      });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? ""))
      return reply(403, "Forbidden\n");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.setHeader("Connection", "close");
      return reply(405, "Method not allowed\n");
    }
    const relative = publicPath(req.url ?? "");
    if (!relative) return reply(404, "Not found\n");
    void (async () => {
      let opened;
      try {
        opened = await openPublicFile(root, relative);
      } catch {
        return reply(404, "Not found\n");
      }
      res.writeHead(200, {
        "Content-Type": contentTypes[path.extname(relative)],
        "Content-Length": opened.info.size,
      });
      if (req.method === "HEAD") {
        await opened.file.close();
        res.end();
      } else {
        await pipeline(opened.file.createReadStream(), res);
      }
    })().catch(() => res.destroy());
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (
    args.length &&
    (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]))
  ) {
    console.error("Usage: node scripts/serve.mjs [--port PORT]");
    process.exitCode = 1;
  } else {
    const port = args.length ? Number(args[1]) : 5173;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("Port must be between 1 and 65535");
      process.exitCode = 1;
    } else {
      const root = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "dist",
      );
      const server = createStaticServer(root);
      server.on("error", (error) => {
        console.error(`Local server failed: ${error.message}`);
        process.exitCode = 1;
      });
      server.listen(port, "127.0.0.1", () =>
        console.log(`Local app: http://127.0.0.1:${port}`),
      );
    }
  }
}
