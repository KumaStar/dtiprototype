// Study panel: Ask (Graph-RAG), Learn (recomposition), Revise (adaptive).
// All model and PDF text is inserted with textContent, never innerHTML.
let session = null;
const $ = (id) => document.getElementById(id);
const SAVED = "graphrag-session";

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
}
async function api(path, body) {
  const r = await fetch(`/api/session/${session.sessionId}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Server error");
  return j;
}
const pct = (x) => Math.round(x * 100) + "%";
const scoreColor = (s) => (s >= 0.8 ? "#10b981" : s >= 0.6 ? "#f59e0b" : "#ef4444");
const labelOf = (id) => session.graph.nodes.find((n) => n.id === id)?.label || id;

// Runs an action with a busy state; drops the result if another document was loaded meanwhile.
async function run(button, out, busy, fn) {
  const owner = session;
  button.disabled = true;
  out.replaceChildren(el("p", { className: "muted", textContent: busy }));
  try {
    const result = await fn();
    if (owner === session) out.replaceChildren(...result);
  } catch (e) {
    if (owner === session) out.replaceChildren(el("p", { className: "bad", textContent: e.message }));
  } finally { button.disabled = false; }
}

function openSession(data) {
  session = data;
  localStorage.setItem(SAVED, data.sessionId);
  $("studyPanel").hidden = false;
  for (const id of ["askOut", "lessonOut", "quizOut"]) $(id).replaceChildren();
  renderGraph(data.graph);
  const s = data.stats;
  $("docStats").textContent = `${data.fileName} · ${s.pages} pages · ${s.chunks} passages · ${s.semantic ? "semantic + keyword search" : "keyword search only (embeddings unavailable)"}`
    + (s.skippedChunks ? ` · ${s.skippedChunks} passages skipped (document too long)` : "");
  const all = el("option", { value: "", textContent: "The whole document" });
  $("goal").replaceChildren(all, ...data.graph.nodes.map((n) => el("option", { value: n.id, textContent: n.label })));
  showMastery();
  loadPath();
}

function showMastery() {
  d3.selectAll(".node .importance-ring")
    .attr("stroke", (d) => (session.mastery[d.id].attempts ? scoreColor(session.mastery[d.id].score) : getColor(d.category)))
    .attr("stroke-width", (d) => (session.mastery[d.id].attempts ? 5 : 2))
    .style("opacity", (d) => (session.mastery[d.id].attempts ? 1 : 0.3));
  const all = Object.values(session.mastery);
  $("overall").textContent = `${all.filter((m) => m.attempts).length} of ${all.length} concepts tested · ${all.filter((m) => m.score >= 0.8).length} mastered`;
  const n = session.next;
  $("nextUp").replaceChildren(...(n
    ? [el("strong", { textContent: n.label }), el("span", { className: "muted", textContent: n.reason })]
    : [el("strong", { textContent: "All caught up" }), el("span", { className: "muted", textContent: "Nothing is weak or due." })]));
  $("quizBtn").disabled = !n;
}
function focusNodes(ids) {
  const set = new Set(ids);
  d3.selectAll(".node").classed("rag-used", (d) => set.has(d.id));
}

// Text with [c3] markers -> paragraphs with page-number buttons and a source list.
function cited(text, citations) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const sources = new Map(citations.map((c) => [c.id, el("details", { className: "source" },
    el("summary", { textContent: `Page ${c.page}${c.via === "graph" ? " · found through the graph" : ""}` }),
    el("p", { textContent: c.text }))]));
  const paras = text.split(/\n{2,}/).map((p) => el("p", {}, ...p.split(/(\[c\d+\])/).filter(Boolean).map((part) => {
    const c = /^\[c\d+\]$/.test(part) ? byId.get(part.slice(1, -1)) : null;
    if (!c) return document.createTextNode(part);
    return el("button", { className: "cite", textContent: `p.${c.page}`, title: "Show source", onclick: () => {
      const d = sources.get(c.id); d.open = true; d.scrollIntoView({ block: "nearest" });
    } });
  })));
  return [...paras, ...(citations.length ? [el("div", { className: "section-label", textContent: "Sources" }), ...sources.values()] : [])];
}

// ── Ask ──────────────────────────────────────────────────────
$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const question = $("question").value.trim();
  if (!question) return;
  run($("askBtn"), $("askOut"), "Retrieving passages through the graph…", async () => {
    const owner = session;
    const a = await api("/ask", { question });
    if (owner !== session) return [];
    focusNodes(a.nodeIds);
    const notes = [];
    if (!a.answerable) notes.push(el("p", { className: "warn", textContent: "Not answered by this document" }));
    else if (!a.citations.length) notes.push(el("p", { className: "warn", textContent: "No verified citation for this answer. Check it against the document." }));
    return [...notes, ...cited(a.answer, a.citations), el("p", { className: "muted",
      textContent: `${a.mode === "hybrid" ? "Semantic + keyword" : "Keyword"} retrieval · ${a.nodeIds.length} concepts outlined on the graph` })];
  });
});

// ── Learn ────────────────────────────────────────────────────
async function loadPath() {
  const owner = session, goal = $("goal").value;
  try {
    const { steps } = await api(`/path?goal=${encodeURIComponent(goal)}`);
    if (owner !== session || goal !== $("goal").value) return;
    $("pathOut").replaceChildren(...steps.map((s) => el("li", { className: s.status },
      el("button", { className: "step", onclick: (e) => openLesson(s.id, e.currentTarget) },
        el("span", { textContent: s.label }),
        el("span", { className: "muted", textContent: `${["", "Foundation", "Intermediate", "Advanced"][s.difficulty]} · ${
          s.status === "mastered" ? "mastered, can skip" : s.status === "locked" ? `first: ${s.blockedBy.map(labelOf).join(", ")}` : "ready"}` })))));
  } catch (e) { $("pathOut").replaceChildren(el("li", { className: "bad", textContent: e.message })); }
}
function openLesson(id, button) {
  focusNodes([id]);
  $("lessonOut").scrollIntoView({ block: "nearest" });
  run(button, $("lessonOut"), "Recomposing the lesson…", async () => {
    const l = await api("/lesson", { conceptId: id, level: $("level").value });
    return [el("h3", { textContent: l.label }), ...cited(l.lesson, l.citations),
      el("button", { className: "btn-sm", textContent: "Quiz me on this", onclick: () => { showTab("revise"); startQuiz(id); } })];
  });
}
$("goal").addEventListener("change", loadPath);

// ── Revise ───────────────────────────────────────────────────
function startQuiz(conceptId) {
  run($("quizBtn"), $("quizOut"), "Writing questions at your level…", async () => {
    const q = await api("/quiz", conceptId ? { conceptId } : {});
    if (q.done) return [el("p", { textContent: "Nothing is weak or due." })];
    focusNodes([q.conceptId]);
    const form = el("form", {}, el("h3", { textContent: q.label }),
      el("p", { className: "muted", textContent: `${q.reason} · ${q.difficulty}` }));
    q.questions.forEach((item, i) => form.append(el("fieldset", {}, el("legend", { textContent: `${i + 1}. ${item.question}` }),
      ...item.options.map((o, j) => el("label", { className: "option" },
        el("input", { type: "radio", name: `q${i}`, value: String(j), required: true }), el("span", { textContent: o }))))));
    const submit = el("button", { className: "btn-sm", textContent: "Check answers" });
    const error = el("p", { className: "bad" });
    form.append(submit, error);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const owner = session;
      const answers = q.questions.map((_, i) => Number(new FormData(form).get(`q${i}`)));
      submit.disabled = true;
      error.textContent = "";
      try {
        const r = await api(`/quiz/${q.quizId}`, { answers });
        if (owner !== session) return;
        Object.assign(session, { mastery: r.mastery, next: r.next });
        form.querySelectorAll("fieldset").forEach((fs, i) => {
          const res = r.results[i];
          fs.disabled = true;
          fs.querySelectorAll(".option").forEach((o, j) => {
            if (j === res.answer) o.classList.add("right");
            else if (j === answers[i]) o.classList.add("wrong");
          });
          fs.append(el("p", { className: res.correct ? "good" : "bad",
            textContent: `${res.correct ? "Correct." : "Not quite."} ${res.explanation}${res.page ? ` (page ${res.page})` : ""}` }));
        });
        submit.remove();
        form.append(el("p", { textContent: `Mastery ${pct(r.before)} → ${pct(r.after)} · next review ${new Date(r.dueAt).toLocaleDateString()}` }));
        showMastery();
        loadPath();
      } catch (err) { submit.disabled = false; error.textContent = err.message; }
    });
    return [form];
  }).then(() => { if (session) $("quizBtn").disabled = !session.next; });
}
$("quizBtn").addEventListener("click", () => startQuiz());

// ── Tabs and restore ─────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  for (const t of ["ask", "learn", "revise"]) $(`tab-${t}`).hidden = t !== name;
}
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

(async () => {
  const id = localStorage.getItem(SAVED);
  if (!id) return;
  try {
    const r = await fetch(`/api/session/${encodeURIComponent(id)}`);
    if (r.status === 404) return localStorage.removeItem(SAVED);
    if (r.ok && !session) openSession(await r.json());
  } catch { /* server unreachable: start empty */ }
})();
