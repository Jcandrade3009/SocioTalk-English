import http from "node:http";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
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

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) throw new Error("Request too large");
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

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") return sendJson(res, 204, {}, origin);

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, service: "SocioTalk English Backend", model: OPENAI_MODEL }, origin);
  }

  if (req.method === "POST" && req.url === "/coach") {
    try {
      if (!OPENAI_API_KEY) {
        return sendJson(res, 503, { ok: false, error: "OPENAI_API_KEY is not configured" }, origin);
      }

      const body = await readBody(req);
      const userText = String(body.userText || "").trim().slice(0, 1500);
      const scenario = String(body.scenario || "Vida diaria").trim().slice(0, 120);
      const level = String(body.level || "A1").trim().slice(0, 10);
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

      if (!userText) return sendJson(res, 400, { ok: false, error: "userText is required" }, origin);

      const systemPrompt = `You are SocioTalk Coach, a friendly English tutor for an adult Spanish-speaking learner.\nLevel: ${level}. Scenario: ${scenario}.\nKeep the conversation realistic, supportive, and short. Correct only what matters. Do not shame the learner.\nReturn ONLY valid JSON with these keys:\ncorrected: the learner sentence corrected while preserving meaning\nnatural: a natural US English alternative\nexplanation_es: a very short explanation in Spanish\nreply: your next conversational reply/question in English, appropriate for ${level}\nhint_es: a short Spanish hint for answering the reply\nscore: integer 0-100 for clarity/grammar\nvocabulary: array of 0-3 useful English words or phrases from this turn.\nIf the learner's English is already fine, corrected may equal the original. Keep reply to 1-2 sentences.`;

      const historyText = history.map((m) => `${m.role === "assistant" ? "Coach" : "Learner"}: ${String(m.text || "").slice(0, 500)}`).join("\n");
      const inputText = `${historyText ? historyText + "\n" : ""}Learner: ${userText}`;

      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: [
            { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
            { role: "user", content: [{ type: "input_text", text: inputText }] }
          ]
        })
      });

      const data = await r.json();
      if (!r.ok) {
        return sendJson(res, r.status, { ok: false, error: data?.error?.message || "OpenAI API error" }, origin);
      }

      const text = extractResponseText(data);
      const result = safeJson(text);
      return sendJson(res, 200, { ok: true, ...result }, origin);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err?.message || "Server error" }, origin);
    }
  }

  return sendJson(res, 404, { ok: false, error: "Not found" }, origin);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SocioTalk backend listening on ${PORT}`);
});
