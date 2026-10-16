// 后台隐藏页面：录下标签页的声音，切成小段交给本地 Whisper 转文字。
const TARGET_RATE = 16000;
const CHUNK_SECONDS = 12;

let session = null; // {tabId, stream, ctx, buffers, length}
let worker = null;
let queue = Promise.resolve();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('asr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => onWorkerMessage(e.data);
  }
  return worker;
}

const pending = new Map();
let nextId = 1;
function transcribe(audio) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}

function onWorkerMessage(msg) {
  if (msg.type === 'result') {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  } else if (msg.type === 'status') {
    chrome.runtime.sendMessage({ type: 'asrStatus', tabId: session?.tabId, status: msg.status });
  }
}

// 线性插值降采样到 16kHz
function resample(data, fromRate) {
  if (fromRate === TARGET_RATE) return data;
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = data[j] * (1 - frac) + (data[j + 1] ?? data[j]) * frac;
  }
  return out;
}

function flush() {
  if (!session || !session.length) return;
  const { buffers, length, ctx, tabId } = session;
  const all = new Float32Array(length);
  let offset = 0;
  for (const b of buffers) { all.set(b, offset); offset += b.length; }
  session.buffers = [];
  session.length = 0;

  // 几乎没声音的片段跳过，免得模型瞎猜
  let sum = 0;
  for (let i = 0; i < all.length; i += 16) sum += all[i] * all[i];
  if (Math.sqrt(sum / (all.length / 16)) < 0.005) return;

  const audio = resample(all, ctx.sampleRate);
  queue = queue.then(async () => {
    const { text, error } = await transcribe(audio);
    if (error) chrome.runtime.sendMessage({ type: 'asrStatus', tabId, status: 'error', error });
    else if (text) chrome.runtime.sendMessage({ type: 'asrText', tabId, text });
  });
}

async function start(streamId, tabId) {
  await stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL('capture-processor.js', import.meta.url));
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination); // 录音时网页会被静音，这里把声音放回去
  const node = new AudioWorkletNode(ctx, 'capture-processor');
  source.connect(node);
  session = { tabId, stream, ctx, buffers: [], length: 0 };
  node.port.onmessage = (e) => {
    if (!session) return;
    session.buffers.push(e.data);
    session.length += e.data.length;
    if (session.length >= ctx.sampleRate * CHUNK_SECONDS) flush();
  };
  stream.getAudioTracks()[0].addEventListener('ended', () => stop());
  getWorker().postMessage({ type: 'load' });
}

async function stop() {
  if (!session) return;
  flush();
  const { stream, ctx, tabId } = session;
  session = null;
  stream.getTracks().forEach((t) => t.stop());
  await ctx.close();
  chrome.runtime.sendMessage({ type: 'asrStopped', tabId });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg.streamId, msg.tabId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'stop') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
});
