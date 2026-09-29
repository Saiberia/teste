/*
 * AudioWorklet processor: forwards mono float blocks (2048 samples) from the
 * audio thread to the offscreen document. "flush" posts the partial block.
 */
class RecapperCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.post();
        this.port.postMessage("flushed");
      }
    };
  }

  post() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n);
    this.n = 0;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const channels = input.length;
      const len = input[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += input[c][i];
        this.buf[this.n++] = s / channels; // downmix to mono
        if (this.n === this.buf.length) this.post();
      }
    }
    return true;
  }
}

registerProcessor("recapper-capture", RecapperCaptureProcessor);
