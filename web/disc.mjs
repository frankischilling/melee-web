export const MAX_READ_BYTES = 1024 * 1024;
export const EXPECTED_DOL_SHA1 = "08e0bf20134dfcb260699671004527b2d6bb1a45";
const SYSTEM_END = 0x2440;
const MAX_FST_BYTES = 16 * 1024 * 1024;
const MAX_DOL_BYTES = 32 * 1024 * 1024;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function range(offset, length, size, label) {
  require(Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= size &&
    length <= size - offset, `${label}: invalid range`);
}

async function read(file, offset, length, label) {
  range(offset, length, file.size, label);
  require(length <= MAX_FST_BYTES ||
    label === "DOL", `${label}: allocation exceeds limit`);
  const bytes = new Uint8Array(length);
  for (let start = 0; start < length; start += MAX_READ_BYTES) {
    const end = Math.min(length, start + MAX_READ_BYTES);
    const chunk = new Uint8Array(
      await file.slice(offset + start, offset + end).arrayBuffer(),
    );
    require(chunk.length === end - start, `${label}: short read`);
    bytes.set(chunk, start);
  }
  return bytes;
}

function noOverlap(extents, label) {
  const sorted = extents
    .filter(([, size]) => size > 0)
    .sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < sorted.length; index++) {
    require(sorted[index - 1][0] + sorted[index - 1][1] <=
      sorted[index][0], `${label}: overlapping ranges`);
  }
}

function inspectDol(bytes, offset, discSize) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = [];
  for (let index = 0; index < 18; index++) {
    const start = view.getUint32(index * 4);
    const address = view.getUint32(0x48 + index * 4);
    const size = view.getUint32(0x90 + index * 4);
    if (!size) continue;
    require(start >= 0x100, "DOL section overlaps its header");
    range(offset + start, size, discSize, "DOL section");
    range(address, size, 2 ** 32, "DOL memory");
    sections.push({ start, address, size, text: index < 7 });
  }
  require(sections.length > 0, "DOL has no sections");
  noOverlap(
    sections.map((s) => [s.start, s.size]),
    "DOL file sections",
  );
  noOverlap(
    sections.map((s) => [s.address, s.size]),
    "DOL memory sections",
  );
  const entry = view.getUint32(0xe0);
  require(sections.some(
    (s) => s.text && s.address <= entry && entry < s.address + s.size,
  ), "DOL entry is outside executable sections");
  range(view.getUint32(0xd8), view.getUint32(0xdc), 2 ** 32, "DOL BSS");
  const size = Math.max(...sections.map((s) => s.start + s.size));
  require(size <= MAX_DOL_BYTES, "DOL exceeds supported executable size");
  return { offset, size, entry, sections: sections.length };
}

function inspectFst(bytes, offset, discSize, dol) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8);
  require(view.getUint32(0) === 0x01000000 &&
    view.getUint32(4) === 0, "FST root is invalid");
  require(count >= 1 &&
    count * 12 < bytes.length, "FST entry count is invalid");
  const strings = count * 12;
  const stack = [[0, count]];
  const extents = [
    [0, SYSTEM_END],
    [dol.offset, dol.size],
    [offset, bytes.length],
  ];
  let files = 0;
  let directories = 1;
  for (let index = 1; index < count; index++) {
    while (stack.length && index === stack.at(-1)[1]) stack.pop();
    require(stack.length &&
      index < stack.at(-1)[1], "FST directory tree is invalid");
    const base = index * 12;
    const kind = bytes[base];
    require(kind === 0 || kind === 1, "FST entry type is invalid");
    const name = strings + (view.getUint32(base) & 0xffffff);
    require(name < bytes.length &&
      (name === strings ||
        bytes[name - 1] === 0), "FST name offset is invalid");
    const end = bytes
      .subarray(name, Math.min(bytes.length, name + 4096))
      .indexOf(0);
    require(end > 0, "FST name is empty, too long or unterminated");
    const value = view.getUint32(base + 4);
    const length = view.getUint32(base + 8);
    if (kind === 1) {
      require(value === stack.at(-1)[0] &&
        index < length &&
        length <= stack.at(-1)[1], "FST directory parent/end is invalid");
      stack.push([index, length]);
      directories++;
    } else {
      range(value, length, discSize, "FST file");
      extents.push([value, length]);
      files++;
    }
  }
  noOverlap(extents, "FST and system extents");
  return { offset, size: bytes.length, entries: count, files, directories };
}

export async function inspectLocalDisc(file) {
  require(Number.isSafeInteger(file.size), "Disc size is invalid");
  const bytes = await read(file, 0, 0x440, "Disc header");
  const header = new DataView(bytes.buffer);
  require(header.getUint32(0x1c) ===
    0xc2339f3d, "Select an uncompressed GameCube ISO or GCM");
  require(header.getUint32(0x18) !== 0x5d1c9ea3, "Wii discs are not supported");
  const gameId = new TextDecoder().decode(bytes.subarray(0, 6));
  require(gameId === "GALE01", "This build supports NTSC-U Melee (GALE01)");
  require(bytes[6] === 0 &&
    bytes[7] === 2, "This build requires Melee disc 0, revision 2 (1.02)");
  const dolOffset = header.getUint32(0x420);
  require(dolOffset >= SYSTEM_END, "DOL overlaps disc header");
  const dol = inspectDol(
    await read(file, dolOffset, 0x100, "DOL header"),
    dolOffset,
    file.size,
  );
  const fstOffset = header.getUint32(0x424);
  const fstSize = header.getUint32(0x428);
  require(fstOffset >= SYSTEM_END &&
    fstSize >= 12 &&
    fstSize <= MAX_FST_BYTES &&
    fstSize <= header.getUint32(0x42c), "FST range or size is invalid");
  const fst = inspectFst(
    await read(file, fstOffset, fstSize, "FST"),
    fstOffset,
    file.size,
    dol,
  );
  const digest = await crypto.subtle.digest(
    "SHA-1",
    await read(file, dolOffset, dol.size, "DOL"),
  );
  dol.sha1 = Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  dol.matchesExpected = dol.sha1 === EXPECTED_DOL_SHA1;
  return { gameId, revision: bytes[7], discSize: file.size, dol, fst };
}

export function makeDiscReader(file, Reader = globalThis.FileReaderSync) {
  require(typeof Reader ===
    "function", "Synchronous file reads require a dedicated worker");
  const reader = new Reader();
  return (offset, length) => {
    range(offset, length, file.size, "Disc read");
    require(length <= MAX_READ_BYTES, "Disc read exceeds bounded read limit");
    if (length === 0) return new Uint8Array();
    const bytes = new Uint8Array(
      reader.readAsArrayBuffer(file.slice(offset, offset + length)),
    );
    require(bytes.length === length, "Disc short read; emulation stopped");
    return bytes;
  };
}
