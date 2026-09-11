import http from "node:http";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://jcandrade3009.github.io";

function sendJson(res, status, data, origin = "") {
  const allow = origin && origin.startsWith(ALLOWED_ORIGIN) ? origin : ALLOWED_ORIGIN;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, maxBytes = 6_000_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new Error("Request too large");
  }
  return body ? JSON.parse(body) : {};
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function safeJson(text) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

function expandContractions(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\bi'm\b/g, "i am")
    .replace(/\bi've\b/g, "i have")
    .replace(/\bi'll\b/g, "i will")
    .replace(/\byou're\b/g, "you are")
    .replace(/\byou've\b/g, "you have")
    .replace(/\bwe're\b/g, "we are")
    .replace(/\bthey're\b/g, "they are")
    .replace(/\bit's\b/g, "it is")
    .replace(/\bthat's\b/g, "that is")
    .replace(/\bwhat's\b/g, "what is")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bdoesn't\b/g, "does not")
    .replace(/\bdidn't\b/g, "did not")
    .replace(/\bisn't\b/g, "is not")
    .replace(/\baren't\b/g, "are not")
    .replace(/\bwasn't\b/g, "was not")
    .replace(/\bweren't\b/g, "were not")
    .replace(/\bhaven't\b/g, "have not")
    .replace(/\bhasn't\b/g, "has not");
}

function words(text) {
  return expandContractions(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function levenshteinWords(a, b) {
  const m = a.length, n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function fluencyFromWpm(wpm) {
  if (!Number.isFinite(wpm) || wpm <= 0) return 0;
  if (wpm >= 90 && wpm <= 155) return 96;
  if (wpm >= 75 && wpm < 90) return Math.round(78 + (wpm - 75) * 1.2);
  if (wpm >= 60 && wpm < 75) return Math.round(60 + (wpm - 60) * 1.2);
  if (wpm > 155 && wpm <= 180) return Math.round(96 - (wpm - 155) * 0.8);
  if (wpm > 180) return clamp(Math.round(76 - (wpm - 180) * 0.8), 35, 76);
  return clamp(Math.round(35 + (wpm - 35) * 0.7), 30, 60);
}

function missingTargetWords(targetWords, transcriptWords) {
  const remaining = [...transcriptWords];
  const missing = [];
  for (const w of targetWords) {
    const idx = remaining.indexOf(w);
    if (idx >= 0) remaining.splice(idx, 1);
    else if (!missing.includes(w)) missing.push(w);
  }
  return missing.slice(0, 3);
}

function fileExtension(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "webm";
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") return sendJson(res, 204, {}, origin);

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "SocioTalk English Backend",
      model: OPENAI_MODEL,
      transcribeModel: OPENAI_TRANSCRIBE_MODEL,
      version: "v4"
    }, origin);
  }

  if (req.method === "POST" && req.url === "/coach") {
    try {
      if (!OPENAI_API_KEY) return sendJson(res, 503, { ok: false, error: "OPENAI_API_KEY is not configured" }, origin);

      const body = await readJsonBody(req, 250_000);
      const userText = String(body.userText || "").trim().slice(0, 1500);
      const scenario = String(body.scenario || "Vida diaria").trim().slice(0, 120);
      const level = String(body.level || "A1").trim().slice(0, 10);
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
      const inputMode = String(body.inputMode || "voice").trim().slice(0, 20);

      if (!userText) return sendJson(res, 400, { ok: false, error: "userText is required" }, origin);

      const systemPrompt = `You are SocioTalk Coach, a friendly English tutor for an adult Spanish-speaking learner.\nLevel: ${level}. Scenario: ${scenario}. Input mode: ${inputMode}.\nKeep the conversation realistic, supportive, useful, and short. Correct only meaningful grammar, word choice, or clarity issues.\n\nIMPORTANT FOR VOICE INPUT:\n- Speech recognition often removes apostrophes, punctuation, and capitalization. If inputMode is "voice", NEVER treat missing apostrophes, punctuation, or capitalization as spoken-English mistakes and NEVER lower the score for them.\n- Do not invent facts or change the learner's meaning.\n- "corrected" must preserve the exact intended meaning with only necessary fixes.\n- "natural" may sound more idiomatic in US English, but must not add information the learner did not say.\n- explanation_es should explain the most useful real language point, not formatting.\n- score should reflect spoken clarity, grammar, and word choice; not transcription formatting.\n\nReturn ONLY valid JSON with these keys:\ncorrected: corrected learner sentence while preserving meaning\nnatural: natural US English alternative preserving meaning\nexplanation_es: one short useful explanation in Spanish\nreply: the next conversational reply/question in English that directly responds to what the learner just said and fits the scenario\nhint_es: a short Spanish hint for answering the reply\nscore: integer 0-100 for clarity/grammar/word choice\nvocabulary: array of 0-3 useful English words or phrases from this turn.\nIf the learner's English is already fine, corrected may equal the original. Keep reply to 1-2 sentences.`;

      const historyText = history.map((m) => `${m.role === "assistant" ? "Coach" : "Learner"}: ${String(m.text || "").slice(0, 500)}`).join("\n");
      const inputText = `${historyText ? historyText + "\n" : ""}Learner: ${userText}`;

      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: [
            { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
            { role: "user", content: [{ type: "input_text", text: inputText }] }
          ]
        })
      });

      const data = await r.json();
      if (!r.ok) return sendJson(res, r.status, { ok: false, error: data?.error?.message || "OpenAI API error" }, origin);

      const result = safeJson(extractResponseText(data));
      return sendJson(res, 200, { ok: true, ...result }, origin);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || "Server error" }, origin);
    }
  }

  if (req.method === "POST" && req.url === "/pronunciation") {
    try {
      if (!OPENAI_API_KEY) return sendJson(res, 503, { ok: false, error: "OPENAI_API_KEY is not configured" }, origin);

      const body = await readJsonBody(req, 6_000_000);
      const target = String(body.target || "").trim().slice(0, 500);
      const audioBase64 = String(body.audioBase64 || "");
      const mimeType = String(body.mimeType || "audio/webm").slice(0, 80);
      const durationMs = clamp(Number(body.durationMs || 0), 400, 20_000);

      if (!target) return sendJson(res, 400, { ok: false, error: "target is required" }, origin);
      if (!audioBase64 || audioBase64.length < 100) return sendJson(res, 400, { ok: false, error: "audioBase64 is required" }, origin);
      if (audioBase64.length > 5_500_000) return sendJson(res, 413, { ok: false, error: "Audio clip is too large" }, origin);

      const audioBuffer = Buffer.from(audioBase64, "base64");
      if (!audioBuffer.length) return sendJson(res, 400, { ok: false, error: "Invalid audio" }, origin);

      const form = new FormData();
      form.append("model", OPENAI_TRANSCRIBE_MODEL);
      form.append("language", "en");
      form.append("file", new Blob([audioBuffer], { type: mimeType }), `pronunciation.${fileExtension(mimeType)}`);

      const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
        body: form
      });
      const tdata = await tr.json();
      if (!tr.ok) return sendJson(res, tr.status, { ok: false, error: tdata?.error?.message || "Transcription API error" }, origin);

      const transcript = String(tdata.text || "").trim();
      if (!transcript) return sendJson(res, 422, { ok: false, error: "No speech was detected" }, origin);

      const targetWords = words(target);
      const transcriptWords = words(transcript);
      const dist = levenshteinWords(targetWords, transcriptWords);
      const maxLen = Math.max(targetWords.length, transcriptWords.length, 1);
      const similarity = clamp(Math.round((1 - dist / maxLen) * 100), 0, 100);
      const completeness = clamp(Math.round((transcriptWords.length / Math.max(targetWords.length, 1)) * 100), 0, 100);
      const pronunciation = clamp(Math.round(similarity * 0.88 + Math.min(completeness, 100) * 0.12), 0, 100);
      const wpm = Math.round(transcriptWords.length * 60_000 / durationMs);
      const rateScore = fluencyFromWpm(wpm);
      const fluency = clamp(Math.round(rateScore * 0.65 + Math.min(pronunciation, 100) * 0.35), 0, 100);
      const focus = missingTargetWords(targetWords, transcriptWords);

      let feedback_es = "Muy bien. La frase se reconoció con claridad.";
      if (pronunciation < 70) feedback_es = "Repítela un poco más despacio y busca que cada palabra salga clara.";
      else if (pronunciation < 88) feedback_es = "Va bien. Repite una vez más cuidando las palabras marcadas.";
      else if (wpm < 75) feedback_es = "La pronunciación fue clara. Ahora intenta decirla un poco más fluida, sin separar tanto las palabras.";
      else if (wpm > 180) feedback_es = "La frase salió clara. Prueba bajar un poco la velocidad para ganar precisión.";
      else if (pronunciation >= 95) feedback_es = "Excelente repetición. Sonó clara y con un ritmo natural.";

      return sendJson(res, 200, {
        ok: true,
        transcript,
        target,
        pronunciation,
        fluency,
        wpm,
        durationMs: Math.round(durationMs),
        focus,
        feedback_es,
        method: "transcription-comparison",
        model: OPENAI_TRANSCRIBE_MODEL
      }, origin);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || "Server error" }, origin);
    }
  }

  return sendJson(res, 404, { ok: false, error: "Not found" }, origin);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SocioTalk backend v4 listening on ${PORT}`);
});
