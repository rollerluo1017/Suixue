// AudioWorklet：把网页声音的采样原样转给 offscreen 页面
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // 多声道取平均成单声道
      const mono = new Float32Array(input[0].length);
      for (const ch of input) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / input.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
