/**
 * Popular MCP servers offered on the add sheet. Every URL and package was checked when added
 * (2026-10-28): the remote ones answer `initialize` without a sign-in (Context7, Hugging Face,
 * Cloudflare docs, DeepWiki) or a 401 with an OAuth `WWW-Authenticate` / `resource_metadata`
 * (Linear, Notion, Sentry, Supabase; GitHub's OAuth needs a pre-registered app, so it takes a
 * token); the packages exist on npm (`@modelcontextprotocol/server-filesystem` 2.0.1,
 * `server-memory` 2.0.0) and PyPI (`mcp-server-fetch` 2026.10.24). Servers omp replaces with its
 * own tools (Exa search, browser automation) are left out: omp would skip them.
 */
import type { McpServerDraft } from "@/core/gen";

export type TemplateTag = "OAuth" | "Token" | "No sign-in" | "Local";

/** A value the template asks for, and where it goes in the definition. */
export interface McpTemplateInput {
  id: string;
  label: string;
  placeholder?: string;
  description?: string;
  secret?: boolean;
  required?: boolean;
  /** A host path (`~` is expanded with the host's home). */
  path?: boolean;
  target: { arg: number } | { header: string; prefix?: string } | { env: string };
}

export interface McpTemplate {
  id: string;
  /** Suggested config name. */
  name: string;
  title: string;
  description: string;
  tag: TemplateTag;
  /** Logo letters and brand colours of the card. */
  mark: string;
  color: string;
  ink?: string;
  homepage: string;
  /** What the host needs to run it (local servers). */
  needs?: string;
  server: McpServerDraft;
  inputs?: McpTemplateInput[];
}

function http(url: string): McpServerDraft {
  return { transport: "http", url, args: [], env: [], headers: [] };
}

function stdio(command: string, args: string[]): McpServerDraft {
  return { transport: "stdio", command, args, env: [], headers: [] };
}

export const MCP_TEMPLATES: readonly McpTemplate[] = [
  {
    id: "context7",
    name: "context7",
    title: "Context7",
    description: "Up-to-date docs and code examples for any library or framework",
    tag: "No sign-in",
    mark: "C7",
    color: "#0f9f6e",
    homepage: "https://context7.com",
    server: http("https://mcp.context7.com/mcp"),
  },
  {
    id: "github",
    name: "github",
    title: "GitHub",
    description: "Repositories, issues, pull requests and Actions runs",
    tag: "Token",
    mark: "GH",
    color: "#2f353d",
    homepage: "https://github.com/github/github-mcp-server",
    server: { ...http("https://api.githubcopilot.com/mcp/"), headers: [{ key: "Authorization", value: "", secret: true }] },
    inputs: [
      {
        id: "token",
        label: "Personal access token",
        placeholder: "github_pat_…",
        description: "Create one at github.com/settings/personal-access-tokens with the repositories and permissions omp may use.",
        secret: true,
        required: true,
        target: { header: "Authorization", prefix: "Bearer " },
      },
    ],
  },
  {
    id: "linear",
    name: "linear",
    title: "Linear",
    description: "Find, create and update issues, projects and cycles",
    tag: "OAuth",
    mark: "Li",
    color: "#5e6ad2",
    homepage: "https://linear.app/docs/mcp",
    server: http("https://mcp.linear.app/mcp"),
  },
  {
    id: "notion",
    name: "notion",
    title: "Notion",
    description: "Search, read and edit pages and databases",
    tag: "OAuth",
    mark: "N",
    color: "#ececea",
    ink: "#111111",
    homepage: "https://developers.notion.com/docs/mcp",
    server: http("https://mcp.notion.com/mcp"),
  },
  {
    id: "sentry",
    name: "sentry",
    title: "Sentry",
    description: "Errors, issues, releases and Seer root-cause analysis",
    tag: "OAuth",
    mark: "S",
    color: "#433d72",
    homepage: "https://docs.sentry.io/product/sentry-mcp/",
    server: http("https://mcp.sentry.dev/mcp"),
  },
  {
    id: "supabase",
    name: "supabase",
    title: "Supabase",
    description: "Tables, SQL, migrations, edge functions and logs",
    tag: "OAuth",
    mark: "Sb",
    color: "#3ecf8e",
    ink: "#0b2a1c",
    homepage: "https://supabase.com/docs/guides/getting-started/mcp",
    server: http("https://mcp.supabase.com/mcp"),
  },
  {
    id: "huggingface",
    name: "huggingface",
    title: "Hugging Face",
    description: "Search models, datasets, Spaces and papers on the Hub",
    tag: "No sign-in",
    mark: "HF",
    color: "#ffcf2e",
    ink: "#3a2a00",
    homepage: "https://huggingface.co/settings/mcp",
    server: http("https://huggingface.co/mcp"),
  },
  {
    id: "cloudflare-docs",
    name: "cloudflare-docs",
    title: "Cloudflare docs",
    description: "Search Cloudflare's developer documentation",
    tag: "No sign-in",
    mark: "CF",
    color: "#f38020",
    homepage: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    server: http("https://docs.mcp.cloudflare.com/mcp"),
  },
  {
    id: "deepwiki",
    name: "deepwiki",
    title: "DeepWiki",
    description: "Ask questions about any public GitHub repository",
    tag: "No sign-in",
    mark: "DW",
    color: "#2563eb",
    homepage: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    server: http("https://mcp.deepwiki.com/mcp"),
  },
  {
    id: "filesystem",
    name: "filesystem",
    title: "Filesystem",
    description: "Read, write and search files inside folders you choose",
    tag: "Local",
    mark: "Fs",
    color: "#5b6b82",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    needs: "Runs with npx (Node.js) on the host",
    server: stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem"]),
    inputs: [{ id: "folder", label: "Folder", placeholder: "~/code", description: "Its tools can only touch files inside this folder.", required: true, path: true, target: { arg: 2 } }],
  },
  {
    id: "memory",
    name: "memory",
    title: "Memory",
    description: "A knowledge graph omp keeps across sessions",
    tag: "Local",
    mark: "M",
    color: "#8b5cf6",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    needs: "Runs with npx (Node.js) on the host",
    server: stdio("npx", ["-y", "@modelcontextprotocol/server-memory"]),
  },
  {
    id: "fetch",
    name: "fetch",
    title: "Fetch",
    description: "Fetch web pages and read them as Markdown",
    tag: "Local",
    mark: "Fe",
    color: "#0ea5e9",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    needs: "Runs with uvx (uv) on the host",
    server: stdio("uvx", ["mcp-server-fetch"]),
  },
];
