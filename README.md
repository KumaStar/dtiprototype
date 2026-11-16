# AI Knowledge Graph Generator

An AI-powered tool that extracts concepts and relationships from PDF documents and visualizes them as an interactive knowledge graph.

## Features

- 📄 Upload PDF notes/documents
- 🔍 Enter a custom query to focus the extraction
- 🧠 Gemini AI extracts key concepts and their relationships
- 🕸️ Interactive D3.js force-directed graph visualization
- 🎨 Color-coded node clusters
- 🖱️ Drag, zoom, and pan the graph
- 📋 Hover tooltips with relationship details

## Tech Stack

- **Backend**: Node.js + Express
- **AI**: Google Gemini API (`gemini-3.1-flash`)
- **PDF Parsing**: `pdf-parse`
- **Frontend**: Vanilla HTML/CSS/JS + D3.js v7

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

## Usage

1. Click **"Upload PDF"** and select a PDF file (notes, research paper, textbook chapter, etc.)
2. Enter a **query** to focus the knowledge extraction (e.g., "machine learning concepts", "key arguments", "main topics")
3. Click **"Generate Knowledge Graph"**
4. Explore the interactive graph — drag nodes, zoom in/out, hover for relationship details

## How It Works

1. The PDF is parsed server-side using `pdf-parse`
2. Extracted text + your query are sent to Gemini API
3. Gemini identifies key concepts (nodes) and their relationships (edges)
4. The structured JSON is returned and rendered as an interactive D3.js force-directed graph

## Project Structure

```
dti/
├── server.js          # Express server + API routes
├── public/
│   └── index.html     # Frontend (single HTML file)
├── package.json
├── .env               # Your API key (not committed)
└── README.md
```
