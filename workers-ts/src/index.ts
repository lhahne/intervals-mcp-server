import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import type { Env } from "./types.js";
import { authEnabled } from "./config.js";
import { D1AuthRepository } from "./repository.js";
import { handleOAuthRoute, verifyBearerToken } from "./oauth.js";
import { registerTools } from "./tools.js";
import { unauthorized } from "./utils.js";

function createServer(env: Env): McpServer {
  const server = new McpServer(
    {
      name: "intervals-icu",
      version: "0.1.0",
    },
    {
      instructions: "Intervals.icu MCP server for athlete activities, events, workouts, wellness data, and credential management.",
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  registerTools(server, env, () => new D1AuthRepository(env));
  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const oauthResponse = await handleOAuthRoute(env, request);
    if (oauthResponse) {
      return oauthResponse;
    }

    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    const authInfo = await verifyBearerToken(env, request);
    if (authEnabled(env) && !authInfo) {
      return unauthorized("Bearer token required for MCP access.");
    }

    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createServer(env);
    await server.connect(transport);
    return transport.handleRequest(request, { authInfo: authInfo ?? undefined });
  },
};
