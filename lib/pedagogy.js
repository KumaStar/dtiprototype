// Learner model: Bayesian Knowledge Tracing, forgetting, learning paths, revision choice.
const DAY = 86400000;
const PRIOR = 0.2, SLIP = 0.1, GUESS = 0.25, LEARN = 0.15; // GUESS = 1 of 4 options
const MASTERED = 0.8, UNLOCKED = 0.6;

function retained(m, now = Date.now()) {
  if (!m) return PRIOR;
  const days = Math.max(0, now - m.last) / DAY;
  const floor = Math.min(PRIOR, m.known);
  return floor + (m.known - floor) * Math.exp(-days / (m.stability * 4));
}

function updateMastery(prev, results, now = Date.now()) {
  const m = prev ? { ...prev } : { known: PRIOR, attempts: 0, correct: 0, stability: 1, last: null };
  // Evidence is applied to what is still remembered, not to the old peak.
  let p = retained(prev, now);
  for (const right of results) {
    const post = right
      ? (p * (1 - SLIP)) / (p * (1 - SLIP) + (1 - p) * GUESS)
      : (p * SLIP) / (p * SLIP + (1 - p) * (1 - GUESS));
    p = post + (1 - post) * LEARN;
    m.attempts++;
    if (right) m.correct++;
  }
  const good = results.filter(Boolean).length >= results.length * 2 / 3;
  // The interval grows only if time passed: cramming must not inflate it.
  const rested = m.last === null || now - m.last >= 0.5 * m.stability * DAY;
  if (!good) m.stability = 1;
  else if (rested) m.stability = Math.min(60, m.stability * 2);
  m.known = p;
  m.last = now;
  return m;
}

function snapshot(session, now = Date.now()) {
  return Object.fromEntries(session.graph.nodes.map((n) => {
    const m = session.mastery[n.id];
    return [n.id, {
      score: retained(m, now), attempts: m ? m.attempts : 0, correct: m ? m.correct : 0,
      dueAt: m ? m.last + m.stability * DAY : null,
    }];
  }));
}

const directPrereqs = (graph, id) => graph.prerequisites.filter((p) => p.after === id).map((p) => p.before);

// Everything that depends on `id`, directly or not.
function laterConcepts(graph, id) {
  const found = new Set();
  const visit = (x) => graph.prerequisites.filter((p) => p.before === x && !found.has(p.after))
    .forEach((p) => { found.add(p.after); visit(p.after); });
  visit(id);
  return graph.nodes.filter((n) => found.has(n.id)).map((n) => n.label);
}

// Topological order (easier, then more important on ties), limited to what `goal` needs.
function learningPath(session, goal, now = Date.now()) {
  const { graph } = session;
  const snap = snapshot(session, now);
  let include = new Set(graph.nodes.map((n) => n.id));
  if (goal) {
    include = new Set();
    const visit = (id) => { if (!include.has(id)) { include.add(id); directPrereqs(graph, id).forEach(visit); } };
    visit(goal);
  }
  const left = graph.nodes.filter((n) => include.has(n.id));
  const done = new Set(), steps = [];
  while (left.length) {
    const n = left.filter((x) => directPrereqs(graph, x.id).every((p) => done.has(p)))
      .sort((a, b) => a.difficulty - b.difficulty || b.importance - a.importance)[0];
    left.splice(left.indexOf(n), 1);
    done.add(n.id);
    const blockedBy = directPrereqs(graph, n.id).filter((p) => snap[p].score < UNLOCKED);
    const status = snap[n.id].score >= MASTERED ? "mastered" : blockedBy.length ? "locked" : "ready";
    steps.push({ id: n.id, label: n.label, difficulty: n.difficulty, score: snap[n.id].score, blockedBy, status });
  }
  return steps;
}

// Due reviews first, then weak concepts by importance; drop to the weakest unmet prerequisite.
function nextRevision(session, now = Date.now()) {
  const snap = snapshot(session, now);
  const byId = new Map(session.graph.nodes.map((n) => [n.id, n]));
  const ranked = session.graph.nodes.map((n) => {
    const s = snap[n.id];
    const due = s.dueAt !== null && s.dueAt <= now;
    return { n, s, due, priority: (1 - s.score) * n.importance + (due ? 5 : 0) + (s.attempts && s.score < UNLOCKED ? 2 : 0) };
  }).filter((x) => x.due || x.s.score < MASTERED).sort((a, b) => b.priority - a.priority);
  if (!ranked.length) return null;

  const top = ranked[0];
  let id = top.n.id;
  let reason = top.due ? "Scheduled review is due"
    : !top.s.attempts ? "Important and not yet tested"
    : top.s.correct < top.s.attempts ? "You have missed questions here" : "Not yet mastered";
  if (!top.due) {
    for (;;) {
      const weak = directPrereqs(session.graph, id).filter((p) => snap[p].score < UNLOCKED)
        .sort((a, b) => snap[a].score - snap[b].score || byId.get(b).importance - byId.get(a).importance)[0];
      if (!weak) break;
      id = weak; // terminates: prerequisites are acyclic
    }
    if (id !== top.n.id) reason = `Prerequisite gap: needed before "${top.n.label}"`;
  }
  return { id, label: byId.get(id).label, score: snap[id].score, reason };
}

module.exports = { updateMastery, retained, snapshot, learningPath, laterConcepts, nextRevision, MASTERED, UNLOCKED, DAY };
