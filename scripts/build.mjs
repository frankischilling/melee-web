import { constants } from "node:fs";
import {
  lstat,
  realpath,
  mkdir,
  readdir,
  open,
  copyFile,
  rename,
  unlink,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const sourceNames = [
  "index.html",
  "app.css",
  "main.mjs",
  "worker.mjs",
  "disc.mjs",
  "controls.mjs",
];
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const output = path.join(project, "dist");
const jsLimit = 16 * 1024 * 1024;
const wasmLimit = 128 * 1024 * 1024;

function samePath(a, b) {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function plain(candidate, allowMissing = false) {
  candidate = path.resolve(candidate);
  const parsed = path.parse(candidate);
  let current = parsed.root;
  for (const part of candidate.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !samePath(await realpath(current), current))
      throw new Error("Symlink or reparse-point paths are not permitted");
  }
  return candidate;
}

async function checkedFile(source, limit) {
  await plain(source);
  const info = await lstat(source);
  if (!info.isFile() || info.nlink !== 1 || info.size >= limit)
    throw new Error(`Unsupported or oversized input: ${path.basename(source)}`);
  return info.size;
}

function snippetName(name) {
  return (
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) &&
    !name.endsWith(".") &&
    !/^(?:private|local|vendor)$/i.test(name)
  );
}

async function collectSnippets(root, relative = "", files = [], depth = 0) {
  if (depth > 16) throw new Error("Snippet nesting exceeds 16 levels");
  await plain(path.join(root, relative));
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    if (!snippetName(entry.name) || entry.isSymbolicLink())
      throw new Error("Unsupported snippet path");
    const name = path.join(relative, entry.name);
    if (entry.isDirectory())
      await collectSnippets(root, name, files, depth + 1);
    else {
      if (!entry.isFile() || !entry.name.endsWith(".js") || files.length >= 256)
        throw new Error("Snippets must contain at most 256 JavaScript files");
      await checkedFile(path.join(root, name), jsLimit);
      files.push(name);
    }
  }
  return files;
}

async function exists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Build only the fixed repository dist directory from an explicit runtime package. */
export async function build(runtimeDirectory) {
  if (!path.isAbsolute(runtimeDirectory))
    throw new Error("--runtime-dir must be absolute");
  const runtime = path.resolve(runtimeDirectory);
  if (contains(output, runtime) || contains(runtime, output))
    throw new Error("Runtime package and dist must not contain each other");
  await plain(project);
  await plain(runtime);
  await plain(output, true);
  if (
    !samePath(path.dirname(output), project) ||
    path.basename(output) !== "dist"
  )
    throw new Error("Invalid fixed output directory");
  const files = sourceNames.map((name) => ({
    source: path.join(project, "web", name),
    destination: name,
    limit: jsLimit,
  }));
  files.push({
    source: path.join(runtime, "gecko_web.js"),
    destination: "runtime/gecko_web.js",
    limit: jsLimit,
  });
  files.push({
    source: path.join(runtime, "gecko_web_bg.wasm"),
    destination: "runtime/gecko_web_bg.wasm",
    limit: wasmLimit,
  });
  const snippetRoot = path.join(runtime, "snippets");
  if (await exists(snippetRoot)) {
    for (const name of await collectSnippets(snippetRoot))
      files.push({
        source: path.join(snippetRoot, name),
        destination: path.join("runtime", "snippets", name),
        limit: jsLimit,
      });
  }
  let total = 0;
  for (const file of files) {
    file.size = await checkedFile(file.source, file.limit);
    total += file.size;
    if (total >= 192 * 1024 * 1024)
      throw new Error("Total build inputs exceed 192 MiB");
    const destination = path.join(output, file.destination);
    await plain(destination, true);
    if (await exists(destination)) await checkedFile(destination, file.limit);
  }
  const wasm = await open(path.join(runtime, "gecko_web_bg.wasm"), "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await wasm.read(header, 0, 8, 0);
    if (
      bytesRead !== 8 ||
      !header.equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
    )
      throw new Error("Runtime WASM has an invalid header");
  } finally {
    await wasm.close();
  }

  // Only old allowlisted snippets can be pruned; unrelated output files are
  // never copied or deleted and the server refuses to expose them.
  const priorSnippetRoot = path.join(output, "runtime", "snippets");
  const priorSnippets = (await exists(priorSnippetRoot))
    ? await collectSnippets(priorSnippetRoot)
    : [];
  await mkdir(output, { recursive: true });
  await plain(output);
  const staging = path.join(output, `.build-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const file of files) {
      const temporary = path.join(staging, file.destination);
      await mkdir(path.dirname(temporary), { recursive: true });
      await copyFile(file.source, temporary, constants.COPYFILE_EXCL);
      if ((await checkedFile(temporary, file.limit)) !== file.size)
        throw new Error("Input changed during build");
    }
    for (const file of files) {
      const destination = path.join(output, file.destination);
      await plain(destination, true);
      await mkdir(path.dirname(destination), { recursive: true });
      await plain(path.dirname(destination));
      await rename(path.join(staging, file.destination), destination);
    }
    const current = new Set(
      files.map((file) => path.normalize(file.destination)),
    );
    for (const name of priorSnippets) {
      const relative = path.join("runtime", "snippets", name);
      if (!current.has(relative)) {
        const stale = path.join(output, relative);
        await plain(stale);
        await unlink(stale);
      }
    }
  } finally {
    // The target is generated here, validated inside fixed dist, and contains
    // only our staged app/runtime files. No user-supplied deletion path exists.
    await plain(staging);
    if (
      !contains(output, staging) ||
      !path.basename(staging).startsWith(".build-")
    )
      throw new Error("Invalid staging cleanup path");
    await rm(staging, { recursive: true, force: true });
  }
  return { output, files: files.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 2 || args[0] !== "--runtime-dir")
      throw new Error(
        "Usage: npm run build -- --runtime-dir ABSOLUTE_GECKO_WEB_PKG",
      );
    const result = await build(args[1]);
    console.log(`Built ${result.files} files in ${result.output}`);
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
