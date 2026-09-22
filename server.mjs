#!/usr/bin/env node
// UpNote MCP server.
// Reads notes from a WAL-correct snapshot copy of UpNote's local SQLite file.
// Writes notes through UpNote's upnote:// x-callback-url scheme.
//
// The READ path copies the database and never opens the live file, so reading
// cannot corrupt UpNote's data. Writes do change your library, on purpose, but
// they go through UpNote's own URL scheme so UpNote itself does the writing.
//
// Unofficial. Not affiliated with or endorsed by UpNote.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_NOTEBOOK = process.env.UPNOTE_DEFAULT_NOTEBOOK || "Claude Notes";
// Guard against a silently truncated note. Verified intact end to end at 32,000
// characters of content, so this ceiling is generous rather than tight.
const URL_LIMIT = Number(process.env.UPNOTE_URL_LIMIT || 100000);

function findDb() {
  if (process.env.UPNOTE_DB) return process.env.UPNOTE_DB;
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  const candidates = [
    path.join(local, "Packages", "24862ThomasDao.UpNote_kq65c2wy2rx02",
      "LocalCache", "Roaming", "UpNote", "upnote.sqlite3"),
    path.join(roaming, "UpNote", "upnote.sqlite3"),
    path.join(os.homedir(), "Library", "Containers", "com.getupnote.mac", "Data",
      "Library", "Application Support", "UpNote", "upnote.sqlite3"),
    path.join(os.homedir(), "Library", "Containers", "com.getupnote.desktop", "Data",
      "Library", "Application Support", "UpNote", "upnote.sqlite3"),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error(
    "UpNote database not found. Set UPNOTE_DB to the full path of upnote.sqlite3."
  );
}

// --- snapshot -------------------------------------------------------------
// UpNote runs SQLite in WAL mode, so recent notes live in upnote.sqlite3-wal,
// not in the main file. Copying the main file alone yields stale data.
// This directory ends up holding a full copy of every note. It defaults to the
// system temp folder and is never deleted, so on a shared or managed machine
// point UPNOTE_SNAPSHOT_DIR somewhere only you can read.
const SNAP_DIR = process.env.UPNOTE_SNAPSHOT_DIR
  || path.join(os.tmpdir(), "upnote-mcp-snapshot");
const SNAP_DB = path.join(SNAP_DIR, "upnote.sqlite3");
const SUFFIXES = ["", "-wal", "-shm"];
let snapStamp = -1;
let db = null;

function sourceStamp(src) {
  let m = 0;
  for (const s of SUFFIXES) {
    try {
      const st = fs.statSync(src + s);
      m = Math.max(m, st.mtimeMs, st.size);
    } catch { /* file may not exist */ }
  }
  return m;
}

function getDb() {
  const src = findDb();
  const stamp = sourceStamp(src);
  if (stamp !== snapStamp || !fs.existsSync(SNAP_DB)) {
    if (db) { try { db.close(); } catch { /* already closed */ } db = null; }
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    for (const s of SUFFIXES) {
      const from = src + s, to = SNAP_DB + s;
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
      else if (fs.existsSync(to)) fs.rmSync(to);
    }
    snapStamp = stamp;
  }
  // Opened read-write on purpose: SQLite must replay the WAL into the copy to
  // see recent notes, and a read-only handle cannot do that. This is our copy.
  if (!db) db = new DatabaseSync(SNAP_DB);
  return db;
}

function q(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

// --- helpers --------------------------------------------------------------
function when(v) {
  if (!v) return null;
  const ms = v > 1e12 ? v : v * 1000;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function notebooks() {
  return q(`
    SELECT nb.id AS id, nb.title AS title,
      (SELECT COUNT(*) FROM lists l, json_each(l.content) j
         JOIN notes n ON n.id = j.value
        WHERE l.id = 'notebooks_' || nb.id AND COALESCE(n.trashed,0) = 0) AS noteCount
    FROM notebooks nb
    WHERE COALESCE(nb.deleted,0) = 0
    ORDER BY nb.title COLLATE NOCASE
  `);
}

function resolveNotebook(title) {
  if (!title) return null;
  const all = notebooks();
  const t = title.trim().toLowerCase();
  return all.find(n => (n.title || "").trim().toLowerCase() === t)
      || all.find(n => (n.title || "").toLowerCase().includes(t))
      || null;
}

function noteIdsIn(notebookId) {
  const row = q(`SELECT content FROM lists WHERE id = ?`, "notebooks_" + notebookId)[0];
  if (!row || !row.content) return [];
  try { return JSON.parse(row.content); } catch { return []; }
}

function snippet(text, query, len = 180) {
  if (!text) return "";
  let i = 0;
  if (query) {
    const k = text.toLowerCase().indexOf(String(query).toLowerCase());
    if (k > 0) i = Math.max(0, k - 40);
  }
  const cut = text.slice(i, i + len).replace(/\s+/g, " ").trim();
  return cut + (text.length > i + len ? "..." : "");
}

function fmtList(rows) {
  if (!rows.length) return "No matching notes.";
  return rows.map(r =>
    `- ${r.title || "(untitled)"}  [id: ${r.id}]  updated ${when(r.updatedAt) || "?"}` +
    (r.snippet ? `\n    ${r.snippet}` : "")
  ).join("\n");
}

// --- writes ---------------------------------------------------------------
// Note text travels as part of this URL, which becomes a process command line.
// On Windows any local process can read another process's command line, so on a
// shared machine treat note bodies as visible to other local users.
function opener(url) {
  switch (process.platform) {
    // rundll32 takes the URL as one argv entry, so the & separators in the
    // callback URL never reach a shell parser. It also sidesteps the 8191
    // character limit that "cmd /c start" would impose.
    case "win32": return ["rundll32", ["url.dll,FileProtocolHandler", url]];
    case "darwin": return ["open", [url]];
    default: return ["xdg-open", [url]];
  }
}

function openUrl(url) {
  return new Promise((resolve, reject) => {
    const [cmd, args] = opener(url);
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", e => reject(new Error(
      `Could not launch "${cmd}" to open the UpNote link (${e.message}). ` +
      `Is UpNote installed and is the upnote:// scheme registered?`)));
    p.on("spawn", () => { p.unref(); resolve(); });
  });
}

function callbackUrl(endpoint, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `upnote://x-callback-url/${endpoint}${qs ? "?" + qs : ""}`;
}

// --- tools ----------------------------------------------------------------
const TOOLS = [
  {
    name: "upnote_create_note",
    description:
      "Create a new note in UpNote. Use this to save a summary, plan, snippet or " +
      `session output. If no notebook is given it goes to "${DEFAULT_NOTEBOOK}". ` +
      "Content is Markdown. Cannot set tags and cannot edit an existing note.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title." },
        content: { type: "string", description: "Note body in Markdown." },
        notebook: {
          type: "string",
          description: `Notebook title. Defaults to "${DEFAULT_NOTEBOOK}".`,
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "upnote_create_notebook",
    description: "Create a new notebook in UpNote.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "upnote_list_notebooks",
    description: "List every UpNote notebook with its live note count.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "upnote_list_notes",
    description: "List the notes in one notebook, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        notebook: { type: "string", description: "Notebook title." },
        limit: { type: "number", description: "Default 50." },
      },
      required: ["notebook"],
    },
  },
  {
    name: "upnote_search_notes",
    description:
      "Full text search across note titles and bodies. Optionally scoped to one notebook.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        notebook: { type: "string", description: "Optional notebook title to scope to." },
        limit: { type: "number", description: "Default 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "upnote_get_note",
    description: "Get the full text of one note by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        max_chars: { type: "number", description: "Truncate body. Default 20000." },
      },
      required: ["id"],
    },
  },
  {
    name: "upnote_recent_notes",
    description: "The most recently updated notes across the whole library.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 20." } },
    },
  },
  {
    name: "upnote_list_tags",
    description: "List all tags in UpNote.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "upnote_open_note",
    description: "Open a note in the UpNote app by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "upnote_open_notebook",
    description: "Open a notebook in the UpNote app by title.",
    inputSchema: {
      type: "object",
      properties: { notebook: { type: "string" } },
      required: ["notebook"],
    },
  },
];

const text = t => ({ content: [{ type: "text", text: t }] });

async function handle(name, a = {}) {
  switch (name) {
    case "upnote_list_notebooks": {
      const rows = notebooks();
      return text(rows.map(r => `- ${r.title} (${r.noteCount})`).join("\n")
        || "No notebooks found.");
    }

    case "upnote_list_tags": {
      const rows = q(`SELECT title FROM tags WHERE COALESCE(deleted,0)=0 ORDER BY title`);
      return text(rows.map(r => `- ${r.title}`).join("\n") || "No tags.");
    }

    case "upnote_recent_notes": {
      const rows = q(`
        SELECT id, title, updatedAt FROM notes
        WHERE COALESCE(trashed,0)=0 AND length(COALESCE(title,'')) > 0
        ORDER BY updatedAt DESC LIMIT ?`, Math.trunc(a.limit || 20));
      return text(fmtList(rows));
    }

    case "upnote_list_notes": {
      const nb = resolveNotebook(a.notebook);
      if (!nb) return text(`No notebook matching "${a.notebook}". Try upnote_list_notebooks.`);
      const ids = noteIdsIn(nb.id);
      if (!ids.length) return text(`"${nb.title}" has no notes.`);
      const ph = ids.map(() => "?").join(",");
      const rows = q(`
        SELECT id, title, updatedAt FROM notes
        WHERE id IN (${ph}) AND COALESCE(trashed,0)=0
        ORDER BY updatedAt DESC LIMIT ?`, ...ids, Math.trunc(a.limit || 50));
      return text(`Notebook: ${nb.title}\n\n${fmtList(rows)}`);
    }

    case "upnote_search_notes": {
      const needle = `%${String(a.query).toLowerCase()}%`;
      let rows;
      if (a.notebook) {
        const nb = resolveNotebook(a.notebook);
        if (!nb) return text(`No notebook matching "${a.notebook}".`);
        const ids = noteIdsIn(nb.id);
        if (!ids.length) return text(`"${nb.title}" has no notes.`);
        const ph = ids.map(() => "?").join(",");
        rows = q(`
          SELECT id, title, text, updatedAt,
                 CASE WHEN lower(COALESCE(title,'')) LIKE ? THEN 2 ELSE 1 END AS rank
          FROM notes
          WHERE id IN (${ph}) AND COALESCE(trashed,0)=0
            AND (lower(COALESCE(title,'')) LIKE ? OR lower(COALESCE(text,'')) LIKE ?)
          ORDER BY rank DESC, updatedAt DESC LIMIT ?`,
          needle, ...ids, needle, needle, Math.trunc(a.limit || 20));
      } else {
        rows = q(`
          SELECT id, title, text, updatedAt,
                 CASE WHEN lower(COALESCE(title,'')) LIKE ? THEN 2 ELSE 1 END AS rank
          FROM notes
          WHERE COALESCE(trashed,0)=0
            AND (lower(COALESCE(title,'')) LIKE ? OR lower(COALESCE(text,'')) LIKE ?)
          ORDER BY rank DESC, updatedAt DESC LIMIT ?`,
          needle, needle, needle, Math.trunc(a.limit || 20));
      }
      for (const r of rows) r.snippet = snippet(r.text, a.query);
      return text(fmtList(rows));
    }

    case "upnote_get_note": {
      const r = q(`SELECT id, title, text, updatedAt, createdAt FROM notes WHERE id = ?`, a.id)[0];
      if (!r) return text(`No note with id ${a.id}.`);
      const cap = Math.trunc(a.max_chars || 20000);
      const full = r.text || "";
      const cut = full.length > cap ? `\n\n[truncated, ${full.length} chars total]` : "";
      return text(`# ${r.title || "(untitled)"}\n` +
        `created ${when(r.createdAt)} | updated ${when(r.updatedAt)}\n\n` +
        full.slice(0, cap) + cut);
    }

    case "upnote_create_note": {
      const notebook = a.notebook || DEFAULT_NOTEBOOK;
      const url = callbackUrl("note/new", {
        title: a.title,
        text: a.content,
        notebook,
        markdown: "true",
      });
      if (url.length > URL_LIMIT) {
        return text(
          `Note too long for UpNote's URL scheme ` +
          `(${url.length} encoded chars, limit ${URL_LIMIT}). ` +
          `Split it into shorter notes and create them separately.`
        );
      }
      await openUrl(url);
      return text(`Created "${a.title}" in notebook "${notebook}".`);
    }

    case "upnote_create_notebook": {
      await openUrl(callbackUrl("notebook/new", { title: a.title }));
      return text(`Created notebook "${a.title}".`);
    }

    case "upnote_open_note": {
      await openUrl(callbackUrl("openNote", { noteId: a.id }));
      return text(`Opened note ${a.id}.`);
    }

    case "upnote_open_notebook": {
      const nb = resolveNotebook(a.notebook);
      if (!nb) return text(`No notebook matching "${a.notebook}".`);
      await openUrl(callbackUrl("openNotebook", { notebookId: nb.id }));
      return text(`Opened notebook "${nb.title}".`);
    }

    default:
      return text(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: "upnote", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await handle(req.params.name, req.params.arguments || {});
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
