// apps/central-api/src/nodes/nodes.controller.ts
import {
  Controller, Post, Get, Patch, Body, Headers,
  UnauthorizedException, BadRequestException, UseGuards, Request,
} from '@nestjs/common';
import { NodesService } from './nodes.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';

export class RegisterNodeDto {
  email!: string;
  displayName!: string;
  contributionDomain?: string;
  nodeRole?: string;
  walletAddress?: string;
  walletChain?: string;
}

export class UpdateNodeDto {
  displayName?: string;
  domain?: string;
  mcpEndpoint?: string;
  walletAddress?: string;
  contributionDomain?: string;
}

@Controller('api/v1/nodes')
export class NodesController {
  constructor(private nodes: NodesService) {}

  /** Register a new node. Returns nodeId + apiKey (shown ONCE). */
  @Post('register')
  async register(@Body() body: RegisterNodeDto) {
    if (!body.email || !body.displayName) {
      throw new BadRequestException('email and displayName are required');
    }
    return this.nodes.register(body);
  }

  /** Exchange API key for JWT token */
  @Post('auth')
  async auth(@Headers('authorization') authHeader: string) {
    const apiKey = this.extractBearer(authHeader);
    return this.nodes.authenticateApiKey(apiKey);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req: { node: { id: string } }) {
    return this.nodes.getNodeProfile(req.node.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me')
  async updateMe(@Request() req: { node: { id: string } }, @Body() body: UpdateNodeDto) {
    return this.nodes.updateNode(req.node.id, body);
  }

  /** Public endpoint — node discovery for MCP registry */
  @Get()
  async listNodes(
    @Body() body: { domain?: string; limit?: number; offset?: number },
  ) {
    return this.nodes.listPublicNodes(body.domain, body.limit ?? 20, body.offset ?? 0);
  }

  private extractBearer(header: string): string {
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token required');
    }
    return header.slice(7);
  }
}
