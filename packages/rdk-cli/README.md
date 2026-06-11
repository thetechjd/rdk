# RDK — Retrieval Development Kit

[![npm version](https://img.shields.io/npm/v/@retrodeck/rdk.svg)](https://www.npmjs.com/package/@retrodeck/rdk)

Distributed knowledge network for AI agents. Index your notes locally,
query them via MCP from Claude Desktop, earn USDC tips when other
agents retrieve your public knowledge.

## Install

```bash
npm install -g @retrodeck/rdk
```

Other paths:

```bash
# macOS via Homebrew
brew tap thetechjd/rdk
brew install rdk

# Linux via curl (bundles its own Node — no system Node.js required)
curl -fsSL https://raw.githubusercontent.com/thetechjd/rdk/main/install.sh | bash
```

## Quick start

```bash
rdk init             # Interactive setup wizard
rdk service:install  # Auto-start on boot (optional)
```

## Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop. You should see the RDK connector in the tools
panel.

## Documentation

- Full docs: <https://retrodeck.ai/docs>
- Interactive walkthrough: <https://play.retrodeck.ai>
- Issues: <https://github.com/thetechjd/rdk/issues>

## License

MIT
