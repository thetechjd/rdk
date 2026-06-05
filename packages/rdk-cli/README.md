# RDK — Retrieval Development Kit

Distributed knowledge infrastructure. Connects your private notes to Claude and
other AI agents via semantic search, reducing LLM token usage by 80–90%.

## Install

```bash
npm install -g rdk
rdk init
```

That's it. `rdk init` is an interactive wizard that walks you through:
- Creating an account
- Connecting your knowledge vault (Obsidian, filesystem, Logseq, or Notion)
- Joining the RDK network + enabling Claude MCP
- Optionally adding a wallet to earn USDC tips

Components are downloaded on-demand — the base install is ~15 seconds.

## Commands

```
rdk init                  Full setup wizard
rdk status                Check what's installed and connected
rdk vault:index           Re-index vault after adding files
rdk vault:search <query>  Test private search
rdk network:join          Install embedding model + MCP (~50MB, one-time)
rdk mcp:serve             Start MCP server for Claude Desktop
rdk tips:enable           Enable on-chain tip earnings
rdk account               View plan and node stats
rdk account:upgrade       Upgrade plan
```

## Add to Claude Desktop

After `rdk network:join`, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rdk": {
      "command": "rdk",
      "args": ["mcp:serve"]
    }
  }
}
```

Restart Claude Desktop. Then ask Claude:
> "Use rdk_query to search my vault for [anything]"
