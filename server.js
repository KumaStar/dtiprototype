require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Gemini Client ─────────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "your_gemini_api_key_here") {
  console.warn(
    "\n⚠️  WARNING: GEMINI_API_KEY is not set.\n" +
    "   Create a .env file with your key from https://aistudio.google.com/app/apikey\n"
  );
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// ─── Multer (PDF upload — stored in memory) ────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted."));
    }
  },
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Helper: extract text from PDF buffer ─────────────────────────────────────
async function extractTextFromPDF(buffer) {
  // Dynamically require pdf-parse to avoid startup issues with its test suite
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(buffer);
  return data.text;
}

// ─── Helper: build the Gemini prompt ──────────────────────────────────────────
function buildPrompt(text, query) {
  const truncated = text.length > 15000 ? text.slice(0, 15000) + "\n\n[... document truncated for length ...]" : text;

  return `You are a knowledge graph extraction engine. Analyze the following document and extract a rich, meaningful knowledge graph based on the user's query focus.

USER QUERY / FOCUS: "${query}"

DOCUMENT TEXT:
---
${truncated}
---

INSTRUCTIONS:
1. Extract 10–25 key CONCEPTS (nodes) highly relevant to the query and document.
2. For each pair of related concepts, define a RELATIONSHIP (edge) with a concise label.
3. Assign each node a CATEGORY (e.g., "topic", "entity", "process", "attribute", "concept", "theory", "method", "tool", "person", "place") — these drive color-coding.
4. Assign each node an IMPORTANCE score (1–5, where 5 is most central).
5. Ensure the graph is CONNECTED — every node must have at least one edge.
6. Relationships should be directional and meaningful (not just "related to").

RESPOND ONLY with valid JSON — no markdown fences, no commentary, just raw JSON:

{
  "title": "Knowledge Graph: <brief descriptive title>",
  "nodes": [
    {
      "id": "unique_snake_case_id",
      "label": "Human Readable Label",
      "category": "concept",
      "importance": 4,
      "description": "One sentence describing this concept in context."
    }
  ],
  "edges": [
    {
      "source": "source_node_id",
      "target": "target_node_id",
      "label": "relationship label",
      "strength": 0.8
    }
  ]
}

Strength is 0.0–1.0 (how strong/direct the relationship is). Aim for 15–35 edges for a rich graph.`;
}

// ─── POST /api/generate ────────────────────────────────────────────────────────
app.post("/api/generate", upload.single("pdf"), async (req, res) => {
  try {
    // Validate inputs
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file uploaded." });
    }

    const query = (req.body.query || "").trim();
    if (!query) {
      return res.status(400).json({ error: "Query is required." });
    }

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "your_gemini_api_key_here") {
      return res.status(500).json({
        error: "Gemini API key not configured. Add GEMINI_API_KEY to your .env file.",
        docs: "https://aistudio.google.com/app/apikey",
      });
    }

    console.log(`📄 Processing PDF: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);
    console.log(`🔍 Query: "${query}"`);

    // Extract PDF text
    let pdfText;
    try {
      pdfText = await extractTextFromPDF(req.file.buffer);
    } catch (err) {
      return res.status(422).json({ error: "Could not parse PDF. Ensure it is a text-based PDF (not a scanned image)." });
    }

    if (!pdfText || pdfText.trim().length < 50) {
      return res.status(422).json({
        error: "PDF appears to be empty or contains only images. Please use a text-based PDF.",
      });
    }

    console.log(`📝 Extracted ${pdfText.length} characters from PDF`);

    // Call Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
    const prompt = buildPrompt(pdfText, query);

    console.log("🤖 Sending to Gemini...");
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse JSON from Gemini response
    let graphData;
    try {
      // Strip any accidental markdown code fences
      const cleaned = responseText.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      graphData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Failed to parse Gemini response as JSON:", responseText.slice(0, 500));
      return res.status(500).json({
        error: "AI returned an unexpected format. Please try again.",
        raw: responseText.slice(0, 300),
      });
    }

    // Validate graph structure
    if (!graphData.nodes || !graphData.edges || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      return res.status(500).json({ error: "AI returned incomplete graph data. Please try again." });
    }

    console.log(`✅ Graph generated: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
    res.json({ success: true, graph: graphData });

  } catch (err) {
    console.error("Error in /api/generate:", err);

    if (err.message && err.message.includes("API_KEY_INVALID")) {
      return res.status(401).json({ error: "Invalid Gemini API key. Check your .env file." });
    }
    if (err.message && err.message.includes("quota")) {
      return res.status(429).json({ error: "Gemini API quota exceeded. Try again later." });
    }

    res.status(500).json({ error: err.message || "Internal server error." });
  }
});

// ─── GET /api/health ───────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyConfigured: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here"),
  });
});

// ─── Fallback: serve index.html ────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Knowledge Graph Generator running at http://localhost:${PORT}`);
  console.log(`📋 API key status: ${process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here" ? "✅ Configured" : "❌ Missing — add to .env"}\n`);
});
