import React, { useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { Card } from "./card";

interface Message {
  type: "ready" | "barge_in" | "partial" | "final" | "reply" | "audio" | "audio_end" | "error" | "billed" | "closed";
  text?: string;
  b64?: string;
  turn?: number;
  message?: string;
  seconds?: number;
  code?: number;
}

export function Interview() {
  const [status, setStatus] = useState("Connecting...");
  const [transcript, setTranscript] = useState("");
  const [assistantReply, setAssistantReply] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentTurnRef = useRef(0);
  const playbackQueueRef = useRef<Array<{ buffer: AudioBuffer, turn: number }>>([]);
  const isPlayingRef = useRef(false);

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:3000/ws");
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WS Connected");
    };

    ws.onmessage = async (event) => {
      const msg: Message = JSON.parse(event.data);
      console.log("Received:", msg);

      switch (msg.type) {
        case "ready":
          setStatus("Ready");
          startRecording();
          break;
        case "barge_in":
          console.log("Barge-in detected");
          stopPlayback();
          break;
        case "partial":
          setTranscript(msg.text || "");
          break;
        case "final":
          setTranscript(msg.text || "");
          break;
        case "reply":
          setAssistantReply(msg.text || "");
          break;
        case "audio":
          if (msg.turn && msg.turn >= currentTurnRef.current) {
            currentTurnRef.current = msg.turn;
            await handleAudioChunk(msg.b64 || "", msg.turn);
          }
          break;
        case "audio_end":
          console.log("Audio turn ended");
          break;
        case "error":
          setStatus(`Error: ${msg.message}`);
          break;
      }
    };

    ws.onclose = () => setStatus("Disconnected");

    return () => {
      ws.close();
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });

      const source = audioCtxRef.current.createMediaStreamSource(stream);
      const processor = audioCtxRef.current.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = floatToInt16(inputData);
        const base64Audio = arrayBufferToBase64(pcm16.buffer);

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            event: "audio_input",
            audio: base64Audio
          }));
        }
      };

      source.connect(processor);
      processor.connect(audioCtxRef.current.destination);
      setIsRecording(true);
    } catch (err) {
      console.error("Mic error:", err);
      setStatus("Microphone access denied");
    }
  };

  const handleAudioChunk = async (base64, turn: number) => {
    if (!audioCtxRef.current) return;
    const arrayBuffer = base64ToArrayBuffer(base64);
    try {
      const audioBuffer = await audioCtxRef.current.decodeAudioData(arrayBuffer);
      playbackQueueRef.current.push({ buffer: audioBuffer, turn });
      if (!isPlayingRef.current) {
        playNextChunk();
      }
    } catch (e) {
      console.error("Decode error", e);
    }
  };

  const playNextChunk = async () => {
    if (playbackQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const { buffer, turn } = playbackQueueRef.current.shift()!;

    if (turn < currentTurnRef.current) {
      playNextChunk();
      return;
    }

    const source = audioCtxRef.current!.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtxRef.current!.destination);
    source.onended = () => playNextChunk();
    source.start();
  };

  const stopPlayback = () => {
    playbackQueueRef.current = [];
    // In a real app, we'd need to stop the currently active AudioBufferSourceNode
  };

  const floatToInt16 = (float32Array: Float32Array) => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  const base64ToArrayBuffer = (base64: string) => {
    const binaryString = window.atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 gap-6">
      <Card className="w-full max-w-2xl p-6 flex flex-col gap-4">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-bold">Interview Session</h2>
          <span className={`px-3 py-1 rounded-full text-xs ${isRecording ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>
            {status} {isRecording && "• Recording"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 h-64">
          <div className="p-4 bg-gray-50 rounded-lg overflow-y-auto border">
            <p className="text-xs font-semibold text-gray-500 mb-2">YOU</p>
            <p className="text-lg">{transcript || "Start speaking..."}</p>
          </div>
          <div className="p-4 bg-blue-50 rounded-lg overflow-y-auto border">
            <p className="text-xs font-semibold text-blue-500 mb-2">ASSISTANT</p>
            <p className="text-lg">{assistantReply || "Listening..."}</p>
          </div>
        </div>

        <div className="flex justify-center">
          <Button variant="destructive" onClick={() => window.location.reload()}>
            End Interview
          </Button>
        </div>
      </Card>
    </div>
  );
}
