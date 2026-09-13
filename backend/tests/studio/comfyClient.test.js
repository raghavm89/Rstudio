'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');

const { ComfyClient, ComfyError } = require('../../worker/comfyClient');

/**
 * Runs against a stub ComfyUI. The point is not that ComfyUI works — it is that
 * we classify its failures correctly. Getting transient vs permanent wrong is
 * how a missing LoRA file gets retried three times before anyone is told, and
 * how a ComfyUI that is merely still booting fails every queued job.
 */
function stubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('isReady is false when ComfyUI is not listening', async () => {
  // Port 1 is reserved and nothing will answer on it.
  const c = new ComfyClient({ baseUrl: 'http://127.0.0.1:1' });
  assert.strictEqual(await c.isReady(), false);
});

test('a refused connection is TRANSIENT — ComfyUI may just be booting', async () => {
  const c = new ComfyClient({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => c.submit({ 1: { class_type: 'X', inputs: {} } }),
    (err) => err instanceof ComfyError && err.permanent === false
  );
});

test('node_errors on a 200 response is PERMANENT — a bad graph never fixes itself', async () => {
  const s = await stubServer((req, res) => {
    json(res, 200, { prompt_id: 'p1', node_errors: { 40: { errors: [{ message: 'lora not found' }] } } });
  });
  try {
    const c = new ComfyClient({ baseUrl: s.baseUrl });
    await assert.rejects(
      () => c.submit({}),
      (err) => err.permanent === true && /lora not found/.test(err.message)
    );
  } finally { await s.close(); }
});

test('a 4xx is PERMANENT, a 5xx is not', async () => {
  const s4 = await stubServer((req, res) => json(res, 400, { error: 'bad prompt' }));
  try {
    const c = new ComfyClient({ baseUrl: s4.baseUrl });
    await assert.rejects(() => c.submit({}), (e) => e.permanent === true);
  } finally { await s4.close(); }

  const s5 = await stubServer((req, res) => json(res, 503, { error: 'busy' }));
  try {
    const c = new ComfyClient({ baseUrl: s5.baseUrl });
    await assert.rejects(() => c.submit({}), (e) => e.permanent === false);
  } finally { await s5.close(); }
});

test('submit → wait → fetch produces the images', async () => {
  let polls = 0;
  const s = await stubServer((req, res) => {
    if (req.url === '/prompt') return json(res, 200, { prompt_id: 'p9', node_errors: {} });
    if (req.url.startsWith('/history/')) {
      polls += 1;
      // Not finished on the first poll — exercises the wait loop rather than
      // accidentally testing a synchronous happy path.
      if (polls < 2) return json(res, 200, {});
      return json(res, 200, {
        p9: { status: { status_str: 'success', completed: true },
              outputs: { 9: { images: [{ filename: 'a.png', subfolder: 'studio', type: 'output' }] } } },
      });
    }
    if (req.url.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    json(res, 404, {});
  });

  try {
    const c = new ComfyClient({ baseUrl: s.baseUrl });
    const promptId = await c.submit({ 9: { class_type: 'SaveImage', inputs: {} } });
    assert.strictEqual(promptId, 'p9');

    const images = await c.waitForResult(promptId, { pollMs: 10 });
    assert.strictEqual(images.length, 1);
    assert.deepStrictEqual(images[0], { filename: 'a.png', subfolder: 'studio', type: 'output' });
    assert.ok(polls >= 2, 'should have polled more than once');

    const buf = await c.fetchImage(images[0]);
    assert.strictEqual(buf.length, 4);
    assert.strictEqual(buf[1], 0x50);
  } finally { await s.close(); }
});

test('onProgress fires on every poll, which is what keeps the lease alive', async () => {
  let beats = 0;
  let polls = 0;
  const s = await stubServer((req, res) => {
    if (req.url === '/prompt') return json(res, 200, { prompt_id: 'p', node_errors: {} });
    if (req.url.startsWith('/history/')) {
      polls += 1;
      if (polls < 4) return json(res, 200, {});
      return json(res, 200, { p: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'x.png' }] } } } });
    }
    json(res, 404, {});
  });
  try {
    const c = new ComfyClient({ baseUrl: s.baseUrl });
    const promptId = await c.submit({});
    await c.waitForResult(promptId, { pollMs: 5, onProgress: async () => { beats += 1; } });
    assert.ok(beats >= 3, `expected a heartbeat per poll, got ${beats}`);
  } finally { await s.close(); }
});

test('an execution error is PERMANENT rather than retried', async () => {
  const s = await stubServer((req, res) => {
    if (req.url === '/prompt') return json(res, 200, { prompt_id: 'p', node_errors: {} });
    if (req.url.startsWith('/history/')) {
      return json(res, 200, { p: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'OOM' }]] } } });
    }
    json(res, 404, {});
  });
  try {
    const c = new ComfyClient({ baseUrl: s.baseUrl });
    const promptId = await c.submit({});
    await assert.rejects(
      () => c.waitForResult(promptId, { pollMs: 5 }),
      (e) => e.permanent === true && /OOM/.test(e.message)
    );
  } finally { await s.close(); }
});

test('completing with no images is a failure, not a silent success', async () => {
  const s = await stubServer((req, res) => {
    if (req.url === '/prompt') return json(res, 200, { prompt_id: 'p', node_errors: {} });
    if (req.url.startsWith('/history/')) {
      return json(res, 200, { p: { status: { completed: true }, outputs: { 9: { text: ['hello'] } } } });
    }
    json(res, 404, {});
  });
  try {
    const c = new ComfyClient({ baseUrl: s.baseUrl });
    const promptId = await c.submit({});
    await assert.rejects(
      () => c.waitForResult(promptId, { pollMs: 5 }),
      (e) => e.permanent === true && /no images/.test(e.message)
    );
  } finally { await s.close(); }
});

test('waiting gives up rather than holding a lease forever', async () => {
  const s = await stubServer((req, res) => {
    if (req.url === '/prompt') return json(res, 200, { prompt_id: 'p', node_errors: {} });
    return json(res, 200, {});
  });
  try {
    const c = new ComfyClient({ baseUrl: s.baseUrl });
    const promptId = await c.submit({});
    await assert.rejects(
      () => c.waitForResult(promptId, { pollMs: 5, timeoutMs: 60 }),
      (e) => e instanceof ComfyError && /Timed out/.test(e.message) && e.permanent === false
    );
  } finally { await s.close(); }
});

test('freeMemory never throws, even against a ComfyUI without /free', async () => {
  const s = await stubServer((req, res) => json(res, 404, {}));
  try {
    const c = new ComfyClient({ baseUrl: s.baseUrl });
    await c.freeMemory();   // must resolve
    assert.ok(true);
  } finally { await s.close(); }
});
