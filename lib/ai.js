const { GoogleGenerativeAI } = require("@google/generative-ai");
const key = process.env.GEMINI_API_KEY || "";
const configured = !!key && key !== "your_gemini_api_key_here";
const genAI = new GoogleGenerativeAI(key);
const CHAT = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash-lite,gemini-3.5-flash").split(",");
const TIMEOUT = 45000;
const EMBED = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";

function parse(text) {
  let value;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); } catch { /* handled below */ }
  if (value && typeof value === "object") return value;
  console.error("Unusable model response:", text.slice(0, 300), "...", text.slice(-100));
  throw Object.assign(new Error("AI returned an unexpected format. Please try again."), { status: 502 });
}

// Overload (503), malformed JSON (502) and timeouts are transient: retry once, then try the fallback models.
async function json(prompt) {
  const attempts = [CHAT, CHAT, ...FALLBACKS];
  for (let i = 0; ; i++) {
    try {
      const model = genAI.getGenerativeModel({ model: attempts[i], generationConfig: { responseMimeType: "application/json" } }, { timeout: TIMEOUT });
      return parse((await model.generateContent(prompt)).response.text());
    } catch (e) {
      const transient = [502, 503].includes(e.status) || /abort/i.test(`${e.name} ${e.message}`);
      if (!transient || i === attempts.length - 1) throw e;
      console.warn(`${attempts[i]}: ${e.status || "timeout"}, trying ${attempts[i + 1]}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function embed(texts, taskType) {
  const model = genAI.getGenerativeModel({ model: EMBED }, { timeout: TIMEOUT });
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const { embeddings } = await model.batchEmbedContents({
      requests: texts.slice(i, i + 100).map((text) => ({
        content: { role: "user", parts: [{ text }] }, taskType, outputDimensionality: 768,
      })),
    });
    out.push(...embeddings.map((e) => e.values.map((v) => +v.toFixed(5))));
  }
  return out;
}

module.exports = { json, embed, configured };
