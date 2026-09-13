'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createStorage, isPubliclyFetchable } = require('./storageFactory');

/**
 * Turning the kept frames into the thing that trains a model.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * Export used to mean: check the pictures are files in
 * `studio/personas/<slug>/candidates`, copy them into a `seed/` folder beside
 * them, and hand back a filesystem path. That is a complete description of how
 * one person on one laptop did it, and it is wrong in three ways for anybody
 * else:
 *
 *   • Queue-generated frames are objects in storage, not files on the API
 *     machine. Every one of them failed the existsSync check, so the screen
 *     said "12 kept frames are not on this machine" about frames the product
 *     itself had just generated.
 *   • The remedy it offered — "copy the candidates directory across" — is a
 *     developer instruction on a customer's screen. They have no repository,
 *     no shell and no directory.
 *   • A folder on the API server is not what training consumes. fal FETCHES a
 *     zip; a path on a disk it cannot see is not a step towards one.
 *
 * So export now produces the zip, in storage, and hands back a URL. That is the
 * artefact the next step actually takes.
 *
 * ── Why the zip is written by hand ──────────────────────────────────────────
 * No zip library is installed, and the CLI shells out to `zip`, which is a
 * dependency on whatever host the API happens to run on. PNG and JPEG are
 * already compressed, so the archive is written with the STORE method — no
 * deflate, no dependency, and the bytes go in unchanged. What is left is a
 * header format that has not moved since 1989.
 */

/**
 * CRC-32, written out rather than imported.
 *
 * `zlib.crc32` exists — and it is not there on every Node this runs on. It
 * arrived in 20.15 / 22.2, and the API server threw `crc32 is not a function`
 * on an older one after this shipped, because it had been checked on a
 * different machine's Node than the one that serves requests. A zip is not
 * worth a runtime-version dependency, and a fallback would mean two code paths
 * where only one of them ever gets exercised in development.
 *
 * IEEE 802.3, reflected, polynomial 0xEDB88320 — the one every zip reader
 * expects. The table is built once, on first use.
 */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

const LOCAL_SIG   = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG     = 0x06054b50;
const VERSION     = 20;   // 2.0 — the floor for anything that reads a zip
const STORE       = 0;

/** MS-DOS date and time, which is what a zip records. Two seconds of precision. */
function dosStamp(date) {
  const time = ((date.getHours() & 0x1f) << 11)
             | ((date.getMinutes() & 0x3f) << 5)
             | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((Math.max(1980, date.getFullYear()) - 1980) & 0x7f) << 9)
            | (((date.getMonth() + 1) & 0x0f) << 5)
            | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {{name: string, data: Buffer}[]} entries  flat — no directories.
 *   The trainer wants images at the ROOT of the archive rather than nested
 *   under a folder whose name it would have to guess.
 * @returns {Buffer}
 */
function buildZip(entries, { now = new Date() } = {}) {
  const { time, day } = dosStamp(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.includes(0x2f) || name.includes(0x5c)) {
      throw new Error(`Refusing to archive "${entry.name}": entries are flat, and a path separator in a name is how a zip escapes its own directory`);
    }
    const data = entry.data;
    const sum = crc32(data) >>> 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(0, 6);            // flags: none. Not a data descriptor —
                                          // sizes are known before the write.
    local.writeUInt16LE(STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18); // compressed
    local.writeUInt32LE(data.length, 22); // uncompressed — identical under STORE
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION, 4);    // version made by
    central.writeUInt16LE(VERSION, 6);    // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(STORE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);    // where the local header is
    name.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);                       // this disk
  end.writeUInt16LE(0, 6);                       // disk with the central directory
  end.writeUInt16LE(entries.length, 8);          // entries on this disk
  end.writeUInt16LE(entries.length, 10);         // entries total
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);                 // where the central directory starts
  end.writeUInt16LE(0, 20);                      // comment length

  return Buffer.concat([...locals, centralBytes, end]);
}

/**
 * The bytes of one kept frame, from wherever it actually lives.
 *
 * A row knows which it is: `storage_key` means the queue generated it, NULL
 * means it is a file in a persona directory — the local R&D path, which still
 * works and still costs nothing.
 */
async function frameBytes(candidate, { candidatesDir, fetchImpl = globalThis.fetch } = {}) {
  if (candidate.storage_key) {
    const storage = createStorage();
    // Local disk resolves the key to a path on this machine. It does NOT hand
    // back bytes — `get` returns `{ path, contentType, bytes }`, which is what
    // the serving route wants, and reading `.body` off it produced undefined
    // and a crash one layer down in the archive writer.
    //
    // S3 has no `get` at all: it is fetched through a presigned GET —
    // `readUrl`, never `publicUrl`, because these are the training images of a
    // face and that prefix is world-readable so Instagram can fetch from it.
    if (typeof storage.get === 'function') {
      return fs.readFileSync(storage.get(candidate.storage_key).path);
    }
    const res = await fetchImpl(storage.readUrl(candidate.storage_key));
    if (!res.ok) throw new Error(`${candidate.filename} → ${res.status} from storage`);
    return Buffer.from(await res.arrayBuffer());
  }

  const full = path.join(candidatesDir, candidate.filename);
  if (!fs.existsSync(full)) {
    const err = new Error(`${candidate.filename} is neither in storage nor on this machine`);
    err.code = 'FRAME_MISSING';
    throw err;
  }
  return fs.readFileSync(full);
}

/**
 * Gather the kept frames into a zip and put it where training can fetch it.
 *
 * @returns {{key: string, url: string, bytes: number, publicly_fetchable: boolean}}
 */
async function publish({ kept, avatarSlug, tenantId, candidatesDir, manifest, now = new Date() }) {
  const entries = [];
  for (const c of kept) {
    entries.push({ name: c.filename, data: await frameBytes(c, { candidatesDir }) });
  }
  // The manifest travels inside the archive. A seed set that cannot say what it
  // covered is one nobody can audit after the fact, and the coverage is the
  // whole argument for why these twelve and not twelve others.
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

  const zip = buildZip(entries, { now });

  const storage = createStorage();
  const target = storage.uploadTarget({
    tenantId,
    avatarSlug,
    // Private, not published: these are the training images of a face, and the
    // published-media prefix is world-readable so Instagram can fetch from it.
    projectId: 'training',
    kind: 'lora',
    filename: `seed-set-${Date.now()}.zip`,
    contentType: 'application/zip',
  });

  if (typeof storage.put === 'function') {
    const q = new URLSearchParams(target.url.slice(target.url.indexOf('?') + 1));
    storage.put(target.key, {
      contentType: q.get('ct'), expiresAt: q.get('exp'), signature: q.get('sig'), body: zip,
    });
  } else {
    const res = await fetch(target.url, {
      method: 'PUT',
      headers: { ...(target.headers || {}), 'Content-Length': String(zip.length) },
      body: zip,
    });
    if (!res.ok) throw new Error(`Seed set upload → ${res.status}`);
  }

  return {
    key: target.key,
    // What the training job is handed. The worker's `ensureFetchable` pushes it
    // through fal's own storage when ours is not reachable from the internet,
    // which is exactly the local-disk case — so this URL is usable either way.
    url: storage.readUrl(target.key),
    bytes: zip.length,
    publicly_fetchable: isPubliclyFetchable(),
  };
}

module.exports = { buildZip, frameBytes, publish, dosStamp, crc32 };
