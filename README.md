# upnote-mcp

Let Claude read and write your [UpNote](https://getupnote.com/) notes.

Ask Claude to "save this to UpNote", or "summarise my Cardiology notebook", and it works.
Everything runs on your own machine. No account, no cloud, no API key.

> **Unofficial.** Not affiliated with, endorsed by, or supported by UpNote or Thomas Dao.
> UpNote is their trademark, used here only to say what this connects to. It reads an
> undocumented local database, which can change in any UpNote update. Back up your notes.

---

## Setup

You need **UpNote** installed, and **Node 22.13 or later** (`node --version` to check).

### 1. Download it

```bash
git clone https://github.com/ahmedco88/upnote-mcp.git
cd upnote-mcp
npm install
```

Note the full path to the folder. You need it in the next step.

### 2. Add it to your config file

Find your config file:

| Client | Windows | macOS |
| --- | --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code | `~/.claude.json` | `~/.claude.json` |

If you use both, add it to both. They are separate files and neither reads the other.

Paste this in, changing only the path to `server.mjs`:

```json
{
  "mcpServers": {
    "upnote": {
      "command": "node",
      "args": ["/full/path/to/upnote-mcp/server.mjs"]
    }
  }
}
```

If the file already has an `mcpServers` section, add the `"upnote"` block inside it rather
than pasting a second `mcpServers`.

**Windows paths:** use forward slashes (`C:/Users/you/upnote-mcp/server.mjs`) or double
backslashes. A single backslash breaks the JSON.

### 3. Restart your client

Fully quit and reopen it. Then ask Claude "what UpNote notebooks do I have?" to check it works.

### Or let Claude Code do all three

If you already have Claude Code, point it at this repo and ask it to install it:

> Clone https://github.com/ahmedco88/upnote-mcp, run npm install, then register it as an MCP
> server called "upnote" pointing at server.mjs. I'm on Windows / macOS. Show me the config
> change before you make it.

It handles the clone, the install, and finding and editing the right config file, which is the
step most people get wrong. Ask to see the change first so you know what it edited. You still
have to restart the client yourself.

---

## Using it

Just ask in plain language:

- "Save this conversation to UpNote"
- "Save this to UpNote in my Recipes notebook"
- "Search my notes for anything about sourdough"
- "Summarise my Travel notebook"

New notes go to a notebook called `Claude Notes` unless you name another one. Change that
default with the `UPNOTE_DEFAULT_NOTEBOOK` setting below.

### What it can do

| Tool | What it does |
| --- | --- |
| `upnote_create_note` | Create a note from a title and Markdown body. |
| `upnote_create_notebook` | Create a notebook. |
| `upnote_list_notebooks` | List notebooks with note counts. |
| `upnote_list_notes` | List the notes in a notebook. |
| `upnote_search_notes` | Search titles and bodies, optionally within one notebook. |
| `upnote_get_note` | Read one note in full. |
| `upnote_recent_notes` | Most recently updated notes. |
| `upnote_list_tags` | List tags. |
| `upnote_open_note` | Open a note in the UpNote app. |
| `upnote_open_notebook` | Open a notebook in the UpNote app. |

### What it cannot do

These are UpNote's limits, not this server's. UpNote's automation only offers "create note"
and "create notebook", so:

- **No editing or appending.** Existing notes cannot be changed. New notes only.
- **No tags on creation.** Add them yourself afterwards.
- Creating a note brings UpNote to the front and opens the new note. Expected.
- Reads only see what has synced to that computer. Phone notes appear after that machine syncs.

---

## Settings

All optional. Add them as an `"env"` block inside the `"upnote"` config above:

```json
"env": { "UPNOTE_DEFAULT_NOTEBOOK": "My Inbox" }
```

| Setting | Default | What it does |
| --- | --- | --- |
| `UPNOTE_DEFAULT_NOTEBOOK` | `Claude Notes` | Where notes go when you don't name a notebook. |
| `UPNOTE_DB` | auto-detected | Path to `upnote.sqlite3`. Set only if detection fails. |
| `UPNOTE_SNAPSHOT_DIR` | system temp folder | Where the note snapshot is kept. See below. |
| `UPNOTE_URL_LIMIT` | `100000` | Refuse notes longer than this, to avoid silent truncation. |

Auto-detected database locations:

- Windows (Store): `%LOCALAPPDATA%\Packages\24862ThomasDao.UpNote_kq65c2wy2rx02\LocalCache\Roaming\UpNote\upnote.sqlite3`
- Windows (installer): `%APPDATA%\UpNote\upnote.sqlite3`
- macOS (older builds): `~/Library/Containers/com.getupnote.mac/Data/Library/Application Support/UpNote/upnote.sqlite3`
- macOS (current builds): `~/Library/Containers/com.getupnote.desktop/Data/Library/Application Support/UpNote/upnote.sqlite3`

---

## Before you trust it with private notes

- **It leaves a copy of all your notes in your temp folder.** Reading works from a snapshot
  copy, and nothing deletes it afterwards. Anything that can read your temp folder can read
  your whole library. On a shared or work machine, set `UPNOTE_SNAPSHOT_DIR` to somewhere
  only you can read.
- **Note text passes through a process command line** when creating a note. On Windows, other
  local processes can read that.
- It never writes to UpNote's own database file. Reading cannot corrupt your notes. Writing
  goes through UpNote's public URL scheme, so UpNote itself does the writing.

---

## Troubleshooting

**Claude says it has no UpNote tools.** The config file was not saved, has a JSON syntax error,
or the client was not fully restarted. Check the path to `server.mjs` is correct and absolute.

**"UpNote database not found".** Auto-detection failed. Find `upnote.sqlite3` yourself and set
`UPNOTE_DB` to its full path.

**`Cannot find module 'node:sqlite'`.** Your Node is older than 22.13. Upgrade it.

**Every notebook shows 0 notes, or notes look old.** You are probably running a different tool,
not this one. See the notes below on WAL and notebook membership.

**Nothing happens when Claude creates a note.** UpNote must be installed and the `upnote://`
scheme registered, which normal installs do automatically.

---

## For anyone building something similar

Four things cost real time here, and none of them produce an error message.

**UpNote runs SQLite in WAL mode.** Recent notes live in `upnote.sqlite3-wal`, not the main
file. Copy `upnote.sqlite3` alone and you get a stale snapshot, in testing months out of date,
silently. Copy `.sqlite3`, `-wal` and `-shm` together, and open the copy **read-write** so
SQLite can replay the log. A read-only handle cannot replay a WAL, so opening read-only "for
safety" is exactly what serves you the old data.

**Notebook membership is not where you would look.** The `organizers` table is empty, and
`notebooks.notes` is `[]` on every row. It lives in the `lists` table, in rows keyed
`notebooks_<notebookId>`, each holding a JSON array of note ids:

```sql
SELECT nb.title, COUNT(*) FROM lists l
JOIN notebooks nb ON nb.id = replace(l.id, 'notebooks_', '')
, json_each(l.content) j
JOIN notes n ON n.id = j.value AND COALESCE(n.trashed, 0) = 0
WHERE l.id LIKE 'notebooks_%' GROUP BY nb.title;
```

**Trashed notes are in the same table**, around 60 percent of rows in one real library. Filter
`COALESCE(trashed, 0) = 0` or every count is wrong.

**Opening the URL:** callback URLs contain `&` separators. On Windows this uses
`rundll32 url.dll,FileProtocolHandler <url>` with the URL as a single argv entry, so no shell
parses it and the 8191 character command line limit does not apply. 32,000 characters of note
content were verified intact end to end. macOS uses `open`, Linux `xdg-open`.

## Platform support

Built and tested on Windows 11 with the Microsoft Store build of UpNote. macOS and Linux have
code paths for both the database location and the URL opener, but they are **untested**.
Reports welcome.

## Test

```bash
node test-client.mjs read     # side effect free
node test-client.mjs write    # creates real notes you will have to trash by hand
```

Override the fixtures with `TEST_NOTEBOOK` and `TEST_QUERY`.

## License

MIT.
