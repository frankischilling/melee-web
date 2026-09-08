import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  inspectLocalDisc,
  makeDiscReader,
  MAX_READ_BYTES,
} from "../web/disc.mjs";

function syntheticDisc() {
  const bytes = new Uint8Array(0x6000);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("GALE01"));
  bytes[7] = 2;
  view.setUint32(0x1c, 0xc2339f3d);
  view.setUint32(0x420, 0x3000);
  view.setUint32(0x424, 0x4000);
  view.setUint32(0x428, 29);
  view.setUint32(0x42c, 29);
  view.setUint32(0x3000, 0x100);
  view.setUint32(0x3048, 0x80003100);
  view.setUint32(0x3090, 16);
  view.setUint32(0x30e0, 0x80003100);
  bytes.fill(0x42, 0x3100, 0x3110);
  view.setUint32(0x4000, 0x01000000);
  view.setUint32(0x4008, 2);
  view.setUint32(0x400c, 0);
  view.setUint32(0x4010, 0x5000);
  view.setUint32(0x4014, 16);
  bytes.set(new TextEncoder().encode("file\0"), 0x4018);
  return bytes;
}

test("local inspection hashes the exact DOL span and never the full disc", async () => {
  const bytes = syntheticDisc();
  const blob = new Blob([bytes]);
  let largestRead = 0;
  const file = {
    size: blob.size,
    arrayBuffer() {
      throw new Error("A whole-disc allocation is forbidden");
    },
    slice(start, end) {
      largestRead = Math.max(largestRead, end - start);
      return blob.slice(start, end);
    },
  };
  const report = await inspectLocalDisc(file);
  assert.equal(report.gameId, "GALE01");
  assert.equal(
    report.dol.sha1,
    createHash("sha1").update(bytes.slice(0x3000, 0x3110)).digest("hex"),
  );
  assert.equal(report.dol.matchesExpected, false);
  assert.equal(report.fst.files, 1);
  assert.ok(largestRead <= MAX_READ_BYTES);
});

test("wrong revision and out-of-range DOL are rejected", async () => {
  const revision = syntheticDisc();
  revision[7] = 1;
  await assert.rejects(inspectLocalDisc(new Blob([revision])), /revision/i);
  const range = syntheticDisc();
  new DataView(range.buffer).setUint32(0x3090, 0xffffffff);
  await assert.rejects(inspectLocalDisc(new Blob([range])), /DOL/i);
});

test("FST directory/file ranges and unterminated names are rejected", async () => {
  for (const mutate of [
    (v) => v.setUint32(0x4008, 0xffffff),
    (v) => v.setUint32(0x4010, 0x3000),
    (v) => v.setUint32(0x4014, 0xffffffff),
    (v) => v.setUint8(0x401c, 0x61),
  ]) {
    const bytes = syntheticDisc();
    mutate(new DataView(bytes.buffer));
    await assert.rejects(inspectLocalDisc(new Blob([bytes])), /FST|overlap/i);
  }
});

test("synchronous reader validates exact local ranges and does not upload data", () => {
  const bytes = syntheticDisc();
  const reads = [];
  const file = { size: bytes.length, slice: (start, end) => ({ start, end }) };
  class LocalReader {
    readAsArrayBuffer({ start, end }) {
      reads.push([start, end]);
      return bytes.slice(start, end).buffer;
    }
  }
  const read = makeDiscReader(file, LocalReader);
  assert.deepEqual(read(0, 6), bytes.slice(0, 6));
  assert.deepEqual(read(file.size, 0), new Uint8Array());
  for (const [offset, length] of [
    [-1, 4],
    [1.5, 2],
    [0, MAX_READ_BYTES + 1],
    [file.size, 1],
  ]) {
    assert.throws(() => read(offset, length), /range|read|integer/i);
  }
  assert.deepEqual(reads, [[0, 6]]);
});

test("synchronous short reads stop the session rather than substituting bytes", () => {
  class ShortReader {
    readAsArrayBuffer() {
      return new ArrayBuffer(1);
    }
  }
  const read = makeDiscReader(
    {
      size: 10,
      slice() {
        return {};
      },
    },
    ShortReader,
  );
  assert.throws(() => read(0, 2), /short read/i);
});
