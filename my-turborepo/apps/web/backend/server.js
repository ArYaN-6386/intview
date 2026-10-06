// server.js — WebSocket relay: browser ⇄ Sarvam realtime STT ⇄ Ollama ⇄ Bulbul TTS
//
//   npm i ws sarvamai dotenv          (package.json needs "type": "module")
//   SARVAM_API_KEY=... node server.js
//
// ── Protocol your frontend implements ───────────────────────────────────────
//
// Connect to  ws://HOST:4000/ws
//
// Client → server (JSON text frames, nothing else is forwarded):
//   { event: "audio_input", audio: "<base64>" }   16 kHz mono linear16 PCM,
//                                                 ~100 ms per frame (3200 bytes)
//   { event: "init", github: <data> }             initialize session with candidate data
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
import dotenv from "dotenv";
dotenv.config();

const KEY = process.env.SARVAM_API_KEY;
if (!KEY) throw new Error("set SARVAM_API_KEY");

const sarvam = new SarvamAIClient({ apiSubscriptionKey: KEY });

// Tune these three for conversational feel.
const STT = {
  model: process.env.SARVAM_STT_MODEL || "saaras:v3-realtime",
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
  model: process.env.OLLAMA_MODEL || "qwen3.5:latest",
  key: process.env.OLLAMA_API_KEY || null,
};

function buildSystemPrompt(gh) {
  const data = JSON.stringify(gh).slice(0, 6000);
  console.log("DEBUG: FINAL SYSTEM PROMPT DATA:", data);
  return `You are a professional Technical Interviewer.

  CRITICAL CONTEXT: The following is the candidate's actual GitHub data. You MUST use this data to personalize the interview.
  CANDIDATE DATA: ${data}

  INTERVIEW RULES:
  1. PRIMARY GOAL: Conduct a technical interview based SPECIFICALLY on the projects, languages, and commits in the Candidate Data above.
  2. STARTING POINT: Your first question must reference a specific project or technology found in the Candidate Data.
  3. FORMAT: Ask only ONE clear, short question at a time (max 2 sentences).
  4. NO MARKDOWN: No bolding, lists, or special characters.
  5. FALLBACK: Only if the data is completely empty should you ask general technical questions.
  6. FACTUALITY: Do not invent projects. Only use what is provided.`;
}

const ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",");

const server = http.createServer((_, res) => res.writeHead(404).end());
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin }) => !origin || ORIGINS.includes(origin),
});

wss.on("connection", (client) => {
  let sys = process.env.SYSTEM_PROMPT || "You are a helpful technical interviewer.";
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
    console.log(`Reply triggered with text: "${text}"`);
    const mine = ++turn;
    const language_code = lang && lang !== "auto" ? lang : FALLBACK_LANG;
    history.push({ role: "user", content: text });

    let answer;
    try {
      console.log(`Calling Ollama with model ${OLLAMA.model}...`);
      const res = await fetch(OLLAMA.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(OLLAMA.key ? { Authorization: `Bearer ${OLLAMA.key}` } : {}),
        },
        body: JSON.stringify({
          model: OLLAMA.model,
          stream: false,
          messages: [{ role: "system", content: sys }, ...history.slice(-10)],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const json = await res.json();
      answer = (json.message?.content || "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim();

      if (!answer) {
        console.log("Warning: Ollama returned empty completion. Using fallback.");
        answer = "Hello! I've reviewed your GitHub profile. Could you start by telling me about your most favorite project?";
      }
      console.log(`Ollama answered: "${answer}"`);
    } catch (e) {
      console.error("Ollama Error:", e);
      return toClient({ type: "error", message: "ollama failed: " + e.message });
    }
    if (mine !== turn) {
      console.log("Reply discarded: user interrupted (turn mismatch)");
      return;
    }
    history.push({ role: "assistant", content: answer });
    toClient({ type: "reply", text: answer });

    for (const chunk of split(answer)) {
      if (mine !== turn) return;
      try {
        console.log(`Synthesizing chunk: "${chunk}"`);
        const res = await sarvam.textToSpeech.convert({
          text: chunk,
          target_language_code: language_code,
          ...VOICE
        });
        if (mine !== turn) return;
        toClient({ type: "audio", b64: res.audios.join(""), turn: mine });
      } catch (e) {
        console.error("TTS Error:", e);
        return toClient({ type: "error", message: "tts failed: " + e.message });
      }
    }
    toClient({ type: "audio_end", turn: mine });
    console.log("Reply cycle complete.");
  }

  // --- browser → upstream ----------------------------------------------------
  client.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === "init") {
      console.log("Received init event for GitHub data:", m.github);
      sys = buildSystemPrompt(m.github);
      console.log("System prompt built. Triggering first reply...");
      reply("Analyze the provided candidate data and begin the interview with a greeting and a specific question about one of their projects.", FALLBACK_LANG);
      return;
    }

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

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`ws://localhost:${PORT}/ws`));
