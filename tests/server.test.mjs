import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  cp,
  truncate,
  link,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverModule = await import("../scripts/serve.mjs").catch(() => null);
const sourceNames = [
  "index.html",
  "app.css",
  "main.mjs",
  "worker.mjs",
  "disc.mjs",
  "controls.mjs",
];
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function start(t, root) {
  assert.ok(serverModule, "scripts/serve.mjs must implement the static server");
  const server = serverModule.createStaticServer(root);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function request(port, url, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: url, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("serves only known files with isolation, CSP and correct content types", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "runtime", "snippets", "generated"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><p>synthetic</p>",
  );
  await writeFile(
    path.join(root, "main.mjs"),
    "export const synthetic = true;",
  );
  await writeFile(path.join(root, "runtime", "gecko_web_bg.wasm"), wasm);
  await writeFile(
    path.join(root, "runtime", "snippets", "generated", "inline0.js"),
    "export {};",
  );
  const port = await start(t, root);
  const page = await request(port, "/");
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /synthetic/);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(page.headers["cross-origin-embedder-policy"], "require-corp");
  assert.match(
    page.headers["content-security-policy"],
    /script-src 'self' 'wasm-unsafe-eval'/,
  );
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(
    (await request(port, "/main.mjs?v=1")).headers["content-type"],
    "text/javascript; charset=utf-8",
  );
  const module = await request(port, "/runtime/gecko_web_bg.wasm");
  assert.equal(module.headers["content-type"], "application/wasm");
  assert.deepEqual(module.body, wasm);
  assert.equal(
    (await request(port, "/runtime/snippets/generated/inline0.js")).status,
    200,
  );
});

test("HEAD sends headers without a body and unsupported methods cannot write", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "index.html"), "synthetic");
  const port = await start(t, root);
  const head = await request(port, "/", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "9");
  assert.equal(head.body.length, 0);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const result = await request(port, "/index.html", method);
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "GET, HEAD");
  }
  assert.equal(
    await readFile(path.join(root, "index.html"), "utf8"),
    "synthetic",
  );
});

test("rejects private files, unsupported assets, encoded traversal and hostile hosts", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, ".private"));
  await writeFile(
    path.join(root, ".private", "secret.iso"),
    "synthetic secret",
  );
  await writeFile(path.join(root, "secret.iso"), "synthetic secret");
  await writeFile(path.join(root, "unlisted.js"), "synthetic secret");
  const port = await start(t, root);
  for (const url of [
    "/secret.iso",
    "/.private/secret.iso",
    "/unlisted.js",
    "/package.json",
    "/../index.html",
    "/%2e%2e/index.html",
    "/%252e%252e/index.html",
    "/runtime/%2e%2e/main.mjs",
    "/runtime%5csnippets/a.js",
    "/runtime/snippets/.hidden.js",
    "/runtime/snippets/private/a.js",
    "/runtime/snippets/a.txt",
    "/%00",
    "/%ZZ",
  ]) {
    const result = await request(port, url);
    assert.equal(result.status, 404, url);
    assert.doesNotMatch(result.body.toString(), /synthetic secret/);
  }
  assert.equal(
    (await request(port, "/", "GET", { host: "untrusted.example" })).status,
    403,
  );
});

test("fails closed for symlinks and an aliased server root", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(path.join(outside, "index.html"), "synthetic outside");
  try {
    await symlink(
      path.join(outside, "index.html"),
      path.join(root, "index.html"),
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("This environment does not permit file symlinks");
      return;
    }
    throw error;
  }
  const port = await start(t, root);
  assert.equal((await request(port, "/")).status, 404);
  const alias = path.join(root, "alias");
  await symlink(
    outside,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliasPort = await start(t, alias);
  assert.equal((await request(aliasPort, "/")).status, 404);
});

async function buildFixture(t) {
  const root = await fixture(t);
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "web"));
  await mkdir(path.join(root, "runtime-package", "snippets", "generated"), {
    recursive: true,
  });
  await cp(
    path.join(project, "scripts", "build.mjs"),
    path.join(root, "scripts", "build.mjs"),
  );
  for (const name of sourceNames)
    await writeFile(path.join(root, "web", name), `synthetic ${name}`);
  await writeFile(
    path.join(root, "runtime-package", "gecko_web.js"),
    "export {};",
  );
  await writeFile(
    path.join(root, "runtime-package", "gecko_web_bg.wasm"),
    wasm,
  );
  await writeFile(
    path.join(root, "runtime-package", "snippets", "generated", "inline0.js"),
    "export {};",
  );
  return root;
}

function build(root, runtime = path.join(root, "runtime-package")) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts", "build.mjs"), "--runtime-dir", runtime],
    { encoding: "utf8" },
  );
}

test("build copies explicit assets and snippets, never arbitrary runtime or web files", async (t) => {
  const root = await buildFixture(t);
  await writeFile(path.join(root, "web", "secret.iso"), "synthetic private");
  await writeFile(
    path.join(root, "runtime-package", "secret.iso"),
    "synthetic private",
  );
  const result = build(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(path.join(root, "dist", "main.mjs"), "utf8"),
    "synthetic main.mjs",
  );
  assert.deepEqual(
    await readFile(path.join(root, "dist", "runtime", "gecko_web_bg.wasm")),
    wasm,
  );
  assert.equal(
    await readFile(
      path.join(root, "dist", "runtime", "snippets", "generated", "inline0.js"),
      "utf8",
    ),
    "export {};",
  );
  await assert.rejects(readFile(path.join(root, "dist", "secret.iso")), {
    code: "ENOENT",
  });
  await assert.rejects(
    readFile(path.join(root, "dist", "runtime", "secret.iso")),
    { code: "ENOENT" },
  );
  await rm(
    path.join(root, "runtime-package", "snippets", "generated", "inline0.js"),
  );
  assert.equal(build(root).status, 0);
  await assert.rejects(
    readFile(
      path.join(root, "dist", "runtime", "snippets", "generated", "inline0.js"),
    ),
    { code: "ENOENT" },
  );
});

test("build rejects missing runtime, output recursion and non-JS snippets before publishing", async (t) => {
  const root = await buildFixture(t);
  assert.notEqual(build(root, "relative-runtime").status, 0);
  assert.notEqual(build(root, path.join(root, "dist")).status, 0);
  await writeFile(
    path.join(root, "runtime-package", "snippets", "private.iso"),
    "synthetic private",
  );
  assert.notEqual(build(root).status, 0);
  await assert.rejects(readFile(path.join(root, "dist", "index.html")), {
    code: "ENOENT",
  });
});

test("build rejects an output junction without writing through it", async (t) => {
  const root = await buildFixture(t);
  const outside = await fixture(t);
  try {
    await symlink(
      outside,
      path.join(root, "dist"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code))
      return t.skip("Directory links unavailable");
    throw error;
  }
  assert.notEqual(build(root).status, 0);
  await assert.rejects(readFile(path.join(outside, "index.html")), {
    code: "ENOENT",
  });
});

test("build rejects oversized WASM before copying it", async (t) => {
  const root = await buildFixture(t);
  await truncate(
    path.join(root, "runtime-package", "gecko_web_bg.wasm"),
    128 * 1024 * 1024,
  );
  const result = build(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /oversized/);
  await assert.rejects(readFile(path.join(root, "dist", "index.html")), {
    code: "ENOENT",
  });
});

test("server rejects hardlink aliases and nested snippet junctions", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(path.join(outside, "secret"), "synthetic outside");
  await link(path.join(outside, "secret"), path.join(root, "main.mjs"));
  await mkdir(path.join(root, "runtime"));
  await writeFile(path.join(outside, "secret.js"), "synthetic outside");
  try {
    await symlink(
      outside,
      path.join(root, "runtime", "snippets"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code))
      return t.skip("Directory links unavailable");
    throw error;
  }
  const port = await start(t, root);
  assert.equal((await request(port, "/main.mjs")).status, 404);
  assert.equal(
    (await request(port, "/runtime/snippets/secret.js")).status,
    404,
  );
});

test("build rejects a runtime source junction", async (t) => {
  const root = await buildFixture(t);
  const alias = path.join(root, "alias-runtime");
  try {
    await symlink(
      path.join(root, "runtime-package"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code))
      return t.skip("Directory links unavailable");
    throw error;
  }
  assert.notEqual(build(root, alias).status, 0);
  await assert.rejects(readFile(path.join(root, "dist", "index.html")), {
    code: "ENOENT",
  });
});
