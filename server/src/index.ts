#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildContext, buildServer } from "./server.js";

const ctx = buildContext();
const server = buildServer(ctx);
await server.connect(new StdioServerTransport());
