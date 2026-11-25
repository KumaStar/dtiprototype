# Agentic Graph-RAG System for Dynamic Pedagogical Knowledge Recomposition & Adaptive Revision Intelligence

Turns a PDF into a concept graph, answers questions from it with page citations, rebuilds it as a learning path, and adapts revision to the student.

## Features

| Part | What it does | Code |
|---|---|---|
| Knowledge graph | Concepts, relations, difficulty and prerequisites, each linked to source passages | `lib/graph.js` |
| Graph-RAG | Embeddings + BM25 (rank fusion), then one-hop graph expansion; invented citations are removed | `lib/retriever.js` |
| Knowledge recomposition | Prerequisite-ordered path to any goal; lessons at three levels, building on mastered concepts | `lib/pedagogy.js`, `lib/prompts.js` |
| Adaptive revision | Quizzes, Bayesian Knowledge Tracing, forgetting, spaced review, prerequisite-gap detection | `lib/pedagogy.js` |

**Next milestone:** an agent that chooses between retrieving, teaching, quizzing and revising. Today the student chooses the tab; only *what to revise next* is automatic.

## Tech stack

Node.js + Express, Gemini (`gemini-3.1-flash-lite`, `gemini-embedding-001`), pdf-parse, D3.js v7. When Gemini is overloaded the app retries, then falls back to other models. Override models with `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS` (comma-separated) and `GEMINI_EMBED_MODEL`.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file in the root directory:

```env
GEMINI_API_KEY=your_gemini_api_key_here
PORT=3000
```

Get your free Gemini API key at: https://aistudio.google.com/app/apikey

### 3. Run the app

```bash
npm start
```

Then open your browser at: **http://localhost:3000**

Run the tests with `npm test` (no API key needed).

## Usage

1. Upload a text-based PDF, enter a focus, and generate the graph.
2. **Ask** questions. Concepts used are outlined on the graph; click a page tag to see its source.
3. **Learn**: pick a goal and level, then open lessons in order.
4. **Revise**: take the suggested quiz. Rings on the graph show mastery.

## Limits

- Scanned PDFs are not supported. Documents beyond 600 passages are cut, and the app says so.
- For long documents the graph is built from the 40 passages most relevant to the focus; Ask searches all indexed passages.
- Progress is saved in `data/` on the server. There are no user accounts, so run it locally.
- The mastery parameters are standard starting values, not fitted to student data.
