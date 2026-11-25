require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const { randomUUID } = require("crypto");
const ai = require("./lib/ai");
const store = require("./lib/store");
const prompts = require("./lib/prompts");
const { extractPages, chunkPages } = require("./lib/chunker");
const { searchChunks, graphRetrieve } = require("./lib/retriever");
const { normalizeGraph } = require("./lib/graph");
const ped = require("./lib/pedagogy");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CHUNKS = 600;  // keeps embedding cost bounded
const GRAPH_CHUNKS = 40; // passages shown to the model when building the graph

const fail = (status, message) => Object.assign(new Error(message), { status });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype === "application/pdf" ? cb(null, true) : cb(fail(400, "Only PDF files are accepted.")),
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Helpers ──────────────────────────────────────────────────
const route = (fn) => async (req, res, next) => {
  try { res.json(await fn(req)); } catch (e) { next(e); }
};
function needKey() {
  if (!ai.configured) throw fail(500, "Gemini API key not configured. Add GEMINI_API_KEY to your .env file.");
}
function load(req) {
  const s = store.get(req.params.id);
  if (!s) throw fail(404, "Session not found. Please upload the PDF again.");
  return s;
}
function findNode(s, id) {
  const node = s.graph.nodes.find((n) => n.id === id);
  if (!node) throw fail(404, "Unknown concept.");
  return node;
}
function text(v, max, name) {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw fail(400, `${name} is required.`);
  return t.slice(0, max);
}

// Embeddings are an upgrade, not a requirement: on failure fall back to keyword search and say so.
async function tryEmbed(texts, task) {
  try { return await ai.embed(texts, task); }
  catch (e) { console.warn("Embedding failed, using keyword search:", e.message); return null; }
}
async function embedQuery(q) {
  const v = await tryEmbed([q], "RETRIEVAL_QUERY");
  return v ? v[0] : null;
}
async function retrieve(s, query) {
  const vector = s.stats.semantic ? await embedQuery(query) : null;
  return { ...graphRetrieve(query, vector, s), mode: vector ? "hybrid" : "keyword" };
}

// A lesson or quiz must stay on its concept: use the concept's own passages, no graph expansion,
// and name the concepts that come later so the model does not drift into them.
async function evidence(s, node) {
  const own = s.chunks.filter((c) => node.chunkIds.includes(c.id)).slice(0, 8);
  const later = ped.laterConcepts(s.graph, node.id);
  if (own.length) return { chunks: own, later };
  const r = await retrieve(s, `${node.label} ${node.description}`);
  return { chunks: r.chunks, later };
}

// Citations to passages that were never retrieved are removed, not trusted.
function ground(body, chunks) {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const used = new Map();
  const cleaned = String(body || "").replace(/\[\s*(c\d+(?:\s*[,;]\s*c\d+)*)\s*\]/g, (_, list) =>
    list.split(/[,;]/).map((x) => x.trim()).filter((id) => byId.has(id))
      .map((id) => { used.set(id, byId.get(id)); return `[${id}]`; }).join(""));
  return { text: cleaned, citations: [...used.values()].map(({ id, page, text: t, via }) => ({ id, page, text: t, via })) };
}

const publicView = (s) => ({
  sessionId: s.id, fileName: s.fileName, query: s.query, graph: s.graph, stats: s.stats,
  mastery: ped.snapshot(s), next: ped.nextRevision(s),
});

// ─── Build the graph ──────────────────────────────────────────
app.post("/api/generate", upload.single("pdf"), route(async (req) => {
  if (!req.file) throw fail(400, "No PDF file uploaded.");
  const query = text(req.body.query, 200, "Query");
  needKey();

  let pages;
  try { pages = await extractPages(req.file.buffer); }
  catch { throw fail(422, "Could not parse PDF. Ensure it is a text-based PDF (not a scanned image)."); }
  const all = chunkPages(pages);
  if (all.reduce((n, c) => n + c.text.length, 0) < 50) {
    throw fail(422, "PDF appears to be empty or contains only images. Please use a text-based PDF.");
  }
  const chunks = all.slice(0, MAX_CHUNKS);

  const vectors = await tryEmbed(chunks.map((c) => c.text), "RETRIEVAL_DOCUMENT");
  if (vectors) chunks.forEach((c, i) => { c.vector = vectors[i]; });

  let context = chunks;
  if (chunks.length > GRAPH_CHUNKS) {
    const found = searchChunks(query, vectors ? await embedQuery(query) : null, chunks, GRAPH_CHUNKS);
    const picked = new Set((found.length ? found : chunks.slice(0, GRAPH_CHUNKS)).map((c) => c.id));
    context = chunks.filter((c) => picked.has(c.id)); // back in reading order
  }
  const graph = normalizeGraph(await ai.json(prompts.graph(context, query)), chunks);
  const s = {
    id: randomUUID(), fileName: req.file.originalname, query, chunks, graph, mastery: {}, quizzes: {},
    stats: { pages: pages.length, chunks: chunks.length, skippedChunks: all.length - chunks.length, semantic: !!vectors },
  };
  store.save(s);
  return publicView(s);
}));

app.get("/api/session/:id", route(async (req) => publicView(load(req))));

// ─── 1. Graph-RAG answers ─────────────────────────────────────
app.post("/api/session/:id/ask", route(async (req) => {
  const s = load(req);
  const question = text(req.body.question, 500, "Question");
  needKey();
  const r = await retrieve(s, question);
  if (!r.chunks.length) {
    return { answerable: false, answer: "Nothing in this document matches that question.", citations: [], nodeIds: [], mode: r.mode };
  }
  const names = new Map(s.graph.nodes.map((n) => [n.id, n.label]));
  const out = await ai.json(prompts.answer(question, r, (id) => names.get(id)));
  const g = ground(out.answer, r.chunks);
  const answerable = out.answerable !== false;
  return { answerable, answer: g.text, citations: g.citations, mode: r.mode, nodeIds: answerable ? r.nodes.map((n) => n.id) : [] };
}));

// ─── 2. Pedagogical recomposition ─────────────────────────────
app.get("/api/session/:id/path", route(async (req) => {
  const s = load(req);
  const goal = typeof req.query.goal === "string" ? req.query.goal : "";
  if (goal) findNode(s, goal);
  return { steps: ped.learningPath(s, goal) };
}));

app.post("/api/session/:id/lesson", route(async (req) => {
  const s = load(req);
  const node = findNode(s, req.body.conceptId);
  const level = Object.hasOwn(prompts.LEVELS, req.body.level) ? req.body.level : "beginner";
  needKey();
  const r = await evidence(s, node);
  const snap = ped.snapshot(s);
  const known = s.graph.nodes.filter((n) => snap[n.id].score >= ped.UNLOCKED).map((n) => n.label);
  const out = await ai.json(prompts.lesson(node, r, known, level));
  const g = ground(out.lesson, r.chunks);
  return { label: node.label, lesson: g.text, citations: g.citations };
}));

// ─── 3. Adaptive revision ─────────────────────────────────────
function validQuestion(q) {
  return q && q.question && Array.isArray(q.options) && q.options.length === 4
    && new Set(q.options.map(String)).size === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4;
}
function shuffled(q, chunks) {
  // Models favour certain answer positions.
  const order = [0, 1, 2, 3].map((i) => [Math.random(), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const source = chunks.find((c) => c.id === q.chunkId);
  return {
    question: String(q.question), options: order.map((i) => String(q.options[i])), answer: order.indexOf(q.answer),
    explanation: String(q.explanation || ""), page: source ? source.page : null,
  };
}

app.post("/api/session/:id/quiz", route(async (req) => {
  const s = load(req);
  const next = req.body.conceptId ? null : ped.nextRevision(s);
  if (!req.body.conceptId && !next) return { done: true };
  const node = findNode(s, req.body.conceptId || next.id);
  needKey();
  const score = ped.snapshot(s)[node.id].score;
  const difficulty = score < 0.4 ? "easy, core definitions" : score < 0.7 ? "medium, applying the idea" : "hard, comparing and reasoning";
  const r = await evidence(s, node);
  const out = await ai.json(prompts.quiz(node, r, difficulty));
  const questions = (Array.isArray(out.questions) ? out.questions : []).filter(validQuestion).slice(0, 3).map((q) => shuffled(q, r.chunks));
  if (!questions.length) throw fail(502, "AI could not write a valid quiz. Please try again.");
  const quizId = randomUUID();
  s.quizzes = { [quizId]: { conceptId: node.id, questions } }; // only the latest quiz is open
  store.save(s);
  return {
    quizId, conceptId: node.id, label: node.label, difficulty, reason: next ? next.reason : "Chosen by you",
    questions: questions.map(({ question, options }) => ({ question, options })), // answers stay on the server
  };
}));

app.post("/api/session/:id/quiz/:quizId", route(async (req) => {
  const s = load(req);
  const quiz = Object.hasOwn(s.quizzes, req.params.quizId) ? s.quizzes[req.params.quizId] : null;
  if (!quiz) throw fail(404, "This quiz was already submitted or replaced.");
  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length !== quiz.questions.length || !answers.every((a) => Number.isInteger(a) && a >= 0 && a < 4)) {
    throw fail(400, "Answer every question.");
  }
  const results = quiz.questions.map((q, i) => ({ correct: answers[i] === q.answer, answer: q.answer, explanation: q.explanation, page: q.page }));
  const before = ped.snapshot(s)[quiz.conceptId].score;
  s.mastery[quiz.conceptId] = ped.updateMastery(s.mastery[quiz.conceptId], results.map((r) => r.correct));
  delete s.quizzes[req.params.quizId];
  store.save(s);
  const mastery = ped.snapshot(s);
  const { score, dueAt } = mastery[quiz.conceptId];
  return { results, before, after: score, dueAt, mastery, next: ped.nextRevision(s) };
}));

// ─── Misc ─────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", apiKeyConfigured: ai.configured }));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  const msg = err.message || "Internal server error.";
  let status = err.status || 500, error = msg;
  if (err.code === "LIMIT_FILE_SIZE") { status = 413; error = "File is too large (max 20 MB)."; }
  else if (/API_KEY_INVALID/.test(msg)) { status = 401; error = "Invalid Gemini API key. Check your .env file."; }
  else if (/quota|\b429\b/i.test(msg)) { status = 429; error = "Gemini API quota exceeded. Try again later."; }
  else if (/\b503\b|overloaded|aborted/i.test(msg)) { status = 503; error = "Gemini is busy right now. Try again in a moment."; }
  if (status >= 500) console.error(err);
  res.status(status).json({ error });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\nAgentic Graph-RAG running at http://localhost:${PORT}`);
    console.log(`Gemini API key: ${ai.configured ? "configured" : "MISSING - add GEMINI_API_KEY to .env"}\n`);
  });
}

module.exports = { app, ground };
