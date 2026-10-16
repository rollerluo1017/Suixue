// Web Worker：在本机用 Whisper tiny.en 把英文语音转成文字。模型和运行库都在插件包里，不联网。
import { pipeline, env } from '../vendor/transformers/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('../models/', import.meta.url).href;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

let asrPromise = null;
function load() {
  if (!asrPromise) {
    self.postMessage({ type: 'status', status: 'loading' });
    asrPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device: 'wasm',
    }).then((asr) => {
      self.postMessage({ type: 'status', status: 'ready' });
      return asr;
    });
  }
  return asrPromise;
}

// Whisper 在音乐或静音时会输出这类内容
const NOISE = /^[\s.]*$|^\s*[\[(][^\])]*[\])]\s*$|^\s*(you|thank you\.?|thanks for watching!?)\s*$/i;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load().catch((err) => self.postMessage({ type: 'status', status: 'error', error: String(err) }));
  } else if (msg.type === 'transcribe') {
    try {
      const asr = await load();
      const out = await asr(msg.audio);
      const text = (out.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      self.postMessage({ type: 'result', id: msg.id, text: NOISE.test(text) ? '' : text });
    } catch (err) {
      self.postMessage({ type: 'result', id: msg.id, error: String(err) });
    }
  }
};
