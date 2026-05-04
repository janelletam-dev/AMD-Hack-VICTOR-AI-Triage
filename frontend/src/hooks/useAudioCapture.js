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

export function useAudioCapture({ onFrame } = {}) {
  const [state, setState] = useState("idle"); // idle|requesting|recording|error
  const ctxRef = useRef(null);
  const streamRef = useRef(null);
  const nodeRef = useRef(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const start = useCallback(async () => {
    if (state === "recording" || state === "requesting") return;
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      node.connect(ctx.destination);
      nodeRef.current = node;
      setState("recording");
    } catch (e) {
      console.error("mic error", e);
      setState("error");
    }
  }, [state]);

  const stop = useCallback(() => {
    nodeRef.current && nodeRef.current.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current && ctxRef.current.close();
    nodeRef.current = streamRef.current = ctxRef.current = null;
    setState("idle");
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { state, start, stop };
}
