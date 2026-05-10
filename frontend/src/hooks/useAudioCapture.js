/**
 * useAudioCapture — mic → AudioWorklet → 16kHz PCM16 frames.
 *
 * Day 1 skeleton. The worklet itself is loaded as a Blob URL so the whole
 * thing lives in one file. 640 samples / 40ms / 1280 bytes per frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const BLOB_TYPE = { type: "application/javascript" };

const WORKLET_SRC = `
class DownsampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(0);
  }
  // input is at sampleRate (typically 48000); we downsample to 16000.
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    // Append new samples
    const merged = new Float32Array(this._buf.length + ch.length);
    merged.set(this._buf, 0);
    merged.set(ch, this._buf.length);
    this._buf = merged;

    const ratio = sampleRate / 16000;
    const outLen = Math.floor(this._buf.length / ratio);
    const FRAME = 640;
    const have = outLen;
    if (have < FRAME) return true;

    const wholeFrames = Math.floor(have / FRAME);
    const totalOut = wholeFrames * FRAME;
    const out = new Int16Array(totalOut);
    for (let i = 0; i < totalOut; i++) {
      const srcIdx = Math.floor(i * ratio);
      const s = Math.max(-1, Math.min(1, this._buf[srcIdx] || 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // Keep leftover float samples for next call.
    const consumedFloat = Math.floor(totalOut * ratio);
    this._buf = this._buf.subarray(consumedFloat);

    // Emit one 1280-byte buffer per frame.
    for (let f = 0; f < wholeFrames; f++) {
      this.port.postMessage(out.buffer.slice(f * FRAME * 2, (f + 1) * FRAME * 2));
    }
    return true;
  }
}
registerProcessor('downsample-processor', DownsampleProcessor);
`;

export function useAudioCapture({ onFrame, onNoiseLevel } = {}) {
  const [state, setState] = useState("idle"); // idle|requesting|recording|error
  const ctxRef = useRef(null);
  const streamRef = useRef(null);
  const nodeRef = useRef(null);
  const analyserRef = useRef(null);
  const noiseLoopRef = useRef(null);
  const onFrameRef = useRef(onFrame);
  const onNoiseRef = useRef(onNoiseLevel);
  onFrameRef.current = onFrame;
  onNoiseRef.current = onNoiseLevel;

  const start = useCallback(async () => {
    if (state === "recording" || state === "requesting") return;
    setState("requesting");
    try {
      // Explicit constraints: echoCancellation matters for the kiosk —
      // when the patient hears TTS over speakers (no headphones), the
      // mic can pick it up and Deepgram transcribes the assistant's own
      // voice back. echoCancellation suppresses that loop. noiseSuppression
      // and autoGainControl smooth out the ER-room audio. Defaults vary
      // by browser, so we set them explicitly.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;

      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], BLOB_TYPE));
      await ctx.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);

      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "downsample-processor");
      node.port.onmessage = (e) => {
        const fn = onFrameRef.current;
        if (fn) fn(e.data);
      };
      src.connect(node);
      // Muted-gain sink: the worklet only emits PCM frames via
      // port.postMessage; its audio outputs are unused. Connecting the
      // node directly to ctx.destination produced an audible mic→speaker
      // passthrough on built-in-speakers + built-in-mic setups (the
      // worklet's processing latency becomes a ~40ms echo of whatever
      // the mic picks up, including the kiosk's own TTS audio).
      // Routing through a gain=0 node keeps the audio graph "alive"
      // so Chrome doesn't optimize the worklet away, while guaranteeing
      // zero output reaches the speakers.
      const silentSink = ctx.createGain();
      silentSink.gain.value = 0;
      node.connect(silentSink);
      silentSink.connect(ctx.destination);
      nodeRef.current = node;

      // Real-time noise meter — runs in parallel with the worklet so the
      // ER kiosk can show ambient noise level proactively (the existing
      // low-confidence-twice trigger only fires reactively after the
      // patient already failed to be heard twice). AnalyserNode samples
      // the POST-suppression signal — anything still loud after the
      // browser's noise suppression is real residual noise.
      if (onNoiseRef.current) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.85;
        src.connect(analyser);
        analyserRef.current = analyser;
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          const a = analyserRef.current;
          if (!a) return;
          a.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          // dB → 0..1: -60dB (quiet) → 0, 0dB (peak clip) → 1.
          // ER ambient typically post-suppression sits at -45..-30dB;
          // patient speaking at conversational distance ~-25..-15dB.
          const dB = 20 * Math.log10(rms + 1e-9);
          const norm = Math.max(0, Math.min(1, (dB + 60) / 60));
          const cb = onNoiseRef.current;
          if (cb) cb(norm);
        };
        // 10Hz update rate — visually smooth without spamming React state.
        noiseLoopRef.current = setInterval(tick, 100);
      }

      setState("recording");
    } catch (e) {
      console.error("mic error", e);
      setState("error");
    }
  }, [state]);

  const stop = useCallback(() => {
    if (noiseLoopRef.current) {
      clearInterval(noiseLoopRef.current);
      noiseLoopRef.current = null;
    }
    analyserRef.current && analyserRef.current.disconnect();
    nodeRef.current && nodeRef.current.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current && ctxRef.current.close();
    nodeRef.current = streamRef.current = ctxRef.current = analyserRef.current = null;
    setState("idle");
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { state, start, stop };
}
