
// server.js — WebSocket relay: browser ⇄ Sarvam realtime STT ⇄ Ollama ⇄ Bulbul TTS
//
//   npm i ws sarvamai          (package.json needs "type": "module")
//   SARVAM_API_KEY=... node server.js
//
// ── Protocol your frontend implements ───────────────────────────────────────
//
// Connect to  ws://HOST:3000/ws
//
// Client → server (JSON text frames, nothing else is forwarded):
//   { event: "audio_input", audio: "<base64>" }   16 kHz mono linear16 PCM,
//                                                 ~100 ms per frame (3200 bytes)
//   { event: "end" }                              graceful close
//
// Server → client (JSON):
//   { type: "ready" }                     upstream connected, start sending audio
//   { type: "barge_in" }                  user began speaking — stop playback NOW
//   { type: "partial",  text }            interim transcript, replaces previous
//   { type: "final",    text }            end of utterance
//   { type: "reply",    text }            assistant's text answer
//   { type: "audio",    b64, turn }       base64 WAV chunk, play in arrival order
//   { type: "audio_end", turn }           no more audio for this turn
//   { type: "error",    message }
//   { type: "billed",   seconds }         server-authoritative billed duration
//   { type: "closed",   code }
//
// `turn` increments on every barge-in. Drop any audio frame whose turn is lower
// than the highest you've seen — it belongs to a reply the user interrupted.
// ───────────────────────────────────────────────────────────────────────────

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { SarvamAIClient } from "sarvamai";

const KEY = process.env.SARVAM_API_KEY;
if (!KEY) throw new Error("set SARVAM_API_KEY");

const sarvam = new SarvamAIClient({ apiSubscriptionKey: KEY });

// Tune these three for conversational feel.
const STT = {
  model: "saaras:v4",
  language_code: "auto",        // or "hi-IN", "en-IN", ...
  stream_type: "fast",          // snappiest partials; "balanced" is the default
  mode: "transcribe",
  encoding: "linear16",
  sample_rate: "16000",         // only 8000 or 16000 accepted
  threshold: "0.3",
  silence_duration_ms: "500",   // pause length that ends a turn
  min_speech_duration_ms: "250",
};

const VOICE = { model: "bulbul:v3", speaker: "shubh" };
const FALLBACK_LANG = "hi-IN";

// Local Ollama needs no key. For Ollama Cloud, set OLLAMA_HOST + OLLAMA_API_KEY.
const OLLAMA = {
  url: (process.env.OLLAMA_HOST || "http://localhost:11434") + "/api/chat",
  model: process.env.OLLAMA_MODEL || "llama3.2:3b",
  key: process.env.OLLAMA_API_KEY || null,
};

const SYS = process.env.SYSTEM_PROMPT;



const server = http.createServer((_, res) => res.writeHead(404).end());
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin }) => !origin || (typeof ORIGINS !== 'undefined' && ORIGINS.includes(origin)),
});

wss.on("connection", (client) => {
  const url = "wss://api.sarvam.ai/speech-to-text-realtime/ws?" + new URLSearchParams(STT);
  const up = new WebSocket(url, { headers: { "api-subscription-key": KEY } });

  const pending = [];         // audio frames that arrive before upstream opens
  const history = [];         // chat turns
  let turn = 0;               // increments on every barge-in, cancels stale replies
  let ping;

  const toClient = (o) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(o));

  up.on("open", () => {
    pending.splice(0).forEach((m) => up.send(m));
    // close code 1008 = inactivity timeout, so keep the socket warm
    ping = setInterval(() => up.readyState === WebSocket.OPEN && up.send(JSON.stringify({ event: "ping" })), 15000);
    toClient({ type: "ready" });
  });

  up.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    switch (m.event) {
      case "vad.speech_start":
        turn++;                               // kill any in-flight reply
        toClient({ type: "barge_in" });
        break;
      case "transcript.partial":
        toClient({ type: "partial", text: m.text });
        break;
      case "transcript.final":
        toClient({ type: "final", text: m.text });
        if (m.text?.trim()) reply(m.text, m.language || STT.language_code);
        break;
      case "error":
        toClient({ type: "error", message: `${m.code}: ${m.message}` });
        if (m.is_fatal) up.close();
        break;
      case "session.end":
        toClient({ type: "billed", seconds: m.audio_duration_s });
        break;
    }
  });

  // --- user said something → think → speak ----------------------------------
  async function reply(text, lang) {
    const mine = ++turn;
    const language_code = lang && lang !== "auto" ? lang : FALLBACK_LANG;
    history.push({ role: "user", content: text });

    let answer;
    try {
      const res = await fetch(OLLAMA.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(OLLAMA.key ? { Authorization: `Bearer ${OLLAMA.key}` } : {}),
        },
        body: JSON.stringify({
          model: OLLAMA.model,
          stream: false,
          keep_alive: "10m",                          // keep weights resident between turns
          options: { temperature: 0.7, num_predict: 120 },
          messages: [{ role: "system", content: SYS }, ...history.slice(-10)],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      answer = (await res.json()).message.content
        .replace(/<think>[\s\S]*?<\/think>/g, "")     // reasoning models leak these
        .trim();
      if (!answer) throw new Error("empty completion");
    } catch (e) {
      return toClient({ type: "error", message: "ollama failed: " + e.message });
    }
    if (mine !== turn) return;                // user interrupted while we thought
    history.push({ role: "assistant", content: answer });
    toClient({ type: "reply", text: answer });

    // Synthesize sentence by sentence so playback starts early.
    // REST TTS caps at 2500 chars per call anyway.
    for (const chunk of split(answer)) {
      if (mine !== turn) return;
      try {
        const res = await sarvam.textToSpeech.convert({ text: chunk, language_code, ...VOICE });
        if (mine !== turn) return;
        // `audios` is base64; the client decodes it
        toClient({ type: "audio", b64: res.audios.join(""), turn: mine });
      } catch (e) {
        return toClient({ type: "error", message: "tts failed: " + e.message });
      }
    }
    toClient({ type: "audio_end", turn: mine });
  }

  // --- browser → upstream ----------------------------------------------------
  client.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.event !== "audio_input" && m.event !== "end") return;   // don't proxy arbitrary frames
    const frame = JSON.stringify(m);
    up.readyState === WebSocket.OPEN ? up.send(frame) : pending.push(frame);
  });

  const shutdown = () => {
    clearInterval(ping);
    if (up.readyState === WebSocket.OPEN) up.close(1000);
    if (client.readyState === WebSocket.OPEN) client.close();
  };
  client.on("close", shutdown);
  up.on("close", (code) => { toClient({ type: "closed", code }); shutdown(); });
  up.on("error", (e) => toClient({ type: "error", message: "upstream: " + e.message }));
});

const split = (s) => s.match(/[^.!?।]+[.!?।]*\s*/g)?.filter((x) => x.trim()) ?? [s];

server.listen(3000, () => console.log("ws://localhost:3000/ws"));