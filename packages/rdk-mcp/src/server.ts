// packages/rdk-mcp/src/server.ts
// RDK MCP Server — all 6 tools exposed via stdio transport.
// Activation is tool-call driven, not passive.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { RDKNode } from './node.js';

const RDK_TOOLS = [
  {
    name: 'rdk_query',
    description: `Search the RDK network for relevant knowledge. Returns chunks from: (1) your private encrypted chunks, (2) private chunks shared with you by team members, (3) public chunks from any node on the network. Use this BEFORE making any LLM call about factual domain knowledge. Reduces token usage by serving pre-computed answers.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The question or topic to retrieve context for' },
        domain: { type: 'string', description: 'Optional domain filter (e.g. fintech, legal, engineering)' },
        includePrivate: { type: 'boolean', default: true },
        includeNetwork: { type: 'boolean', default: true },
        topK: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'rdk_index',
    description: `Index content as a PRIVATE encrypted chunk on the RDK network. The chunk is searchable by you and any team members with vault access. Use this for personal notes, work-in-progress, sensitive information. Set isPublic: true to publish publicly instead (irreversible — public chunks cannot be made private again).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        title: { type: 'string' },
        isPublic: { type: 'boolean', default: false },
        domain: { type: 'string' },
        categories: { type: 'array', items: { type: 'string' } },
      },
      required: ['content', 'title'],
    },
  },
  {
    name: 'rdk_index_url',
    description: `Fetch and index a URL as a chunk on the RDK network. Private (encrypted) by default; set isPublic: true to publish publicly (earns tips, irreversible).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string' },
        isPublic: { type: 'boolean', default: false },
        domain: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'rdk_index_vault',
    description: `Re-index files from your local vault (Obsidian, filesystem, Logseq, or Notion). Files are indexed as private encrypted chunks by default. Files in folders marked public via vault:set-public are indexed as public.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        forceReindex: { type: 'boolean', default: false },
        publicOnly: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'rdk_status',
    description: `Get current RDK node status: chunks indexed, network connectivity, plan, vault sync.`,
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'rdk_earnings',
    description: `View tip earnings from other nodes retrieving your contributed knowledge.`,
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

export async function startMcpServer() {
  const node = new RDKNode();
  await node.init();

  const server = new Server(
    { name: 'rdk', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: RDK_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case 'rdk_query':
          return await node.handleQuery(a.query as string, {
            domain: a.domain as string | undefined,
            includePrivate: a.includePrivate !== false,
            includeNetwork: a.includeNetwork !== false,
            topK: (a.topK as number | undefined) ?? 5,
          });
        case 'rdk_index':
          return await node.handleIndex({
            content: a.content as string,
            title: a.title as string,
            isPublic: a.isPublic as boolean | undefined,
            domain: a.domain as string | undefined,
            categories: a.categories as string[] | undefined,
          });
        case 'rdk_index_url':
          return await node.handleIndexUrl({
            url: a.url as string,
            isPublic: a.isPublic as boolean | undefined,
            domain: a.domain as string | undefined,
          });
        case 'rdk_index_vault':
          return await node.handleIndexVault({
            forceReindex: a.forceReindex as boolean | undefined,
            publicOnly: a.publicOnly as boolean | undefined,
          });
        case 'rdk_status':
          return await node.handleStatus();
        case 'rdk_earnings':
          return await node.handleEarnings();
        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `RDK error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startMcpServer().catch(console.error);
