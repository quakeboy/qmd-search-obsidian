# QMD Desktop-only Search for Obsidian

An Obsidian plugin that integrates [QMD](https://github.com/tobi/qmd) local search (BM25 full-text search, vector semantic search, and LLM re-ranking) into a native-feeling search modal.

## Prerequisites

1. **QMD installed** via `bun install -g https://github.com/tobi/qmd`
2. **A QMD collection named `obsidian`** pointing to your vault:
   ```bash
   qmd collection add /path/to/your/vault --name obsidian
   qmd embed
   ```
3. **Embeddings generated** (run `qmd embed` after indexing)

## Install (manual)

```bash
# Clone or copy this folder into your vault's plugins directory
cp -r obsidian-qmd-search /path/to/vault/.obsidian/plugins/qmd-search

# Build
cd /path/to/vault/.obsidian/plugins/qmd-search
npm install
npm run build

# Enable the plugin in Obsidian Settings > Community Plugins
```

## Usage

1. Open the command palette (Cmd/Ctrl + P)
2. Search for **"QMD"** and choose from one of the three search mode commands
3. Type your query and press **Enter**
4. Wait for results (hybrid search uses LLM reranking, may take a few seconds)
5. Click a result or use arrow keys + Enter to open the file

## Settings

- **QMD binary path**: defaults to `qmd`. If Obsidian can't find it, set the full path (e.g. `/Users/you/.bun/bin/qmd`)
- **Collection name**: defaults to `obsidian`
- **Max results**: defaults to 16

## Notes

- This plugin is desktop-only (it uses `child_process` to call the qmd CLI)
- The `qmd query` command uses hybrid search with LLM reranking, which gives the best quality results but is slower than plain `qmd search`. First run may be slow if models need to load.
- Keep your index fresh with `qmd update` and `qmd embed` periodically
