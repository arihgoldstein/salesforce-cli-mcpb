import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const execFileAsync = promisify(execFile);
const DEFAULT_ORG = process.env.DEFAULT_ORG || "";

function findSfPath() {
  if (process.env.SF_PATH && process.env.SF_PATH !== "sf") {
    return process.env.SF_PATH;
  }
  const home = homedir();
  const candidates = [
    join(home, ".local", "nodejs", "bin", "sf"),
    join(home, ".local", "bin", "sf"),
    join(home, ".nvm", "current", "bin", "sf"),
    "/usr/local/bin/sf",
    "/opt/homebrew/bin/sf",
    "/usr/bin/sf",
    join(home, ".volta", "bin", "sf"),
    join(home, "AppData", "Roaming", "npm", "sf.cmd"),
    join(home, "AppData", "Roaming", "npm", "sf"),
  ];
  // Check nvm versioned dirs (e.g. ~/.nvm/versions/node/v22.x.x/bin/sf)
  const nvmVersionsDir = join(home, ".nvm", "versions", "node");
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = readdirSync(nvmVersionsDir).sort().reverse();
      for (const v of versions) {
        candidates.push(join(nvmVersionsDir, v, "bin", "sf"));
      }
    } catch {}
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "sf";
}

const SF_PATH = findSfPath();
// Add sf's directory to PATH so #!/usr/bin/env node resolves
const SF_DIR = dirname(SF_PATH);
const ENV = {
  ...process.env,
  SF_JSON_OUTPUT: "true",
  PATH: SF_DIR + ":" + (process.env.PATH || ""),
};

async function runSf(args) {
  try {
    const { stdout, stderr } = await execFileAsync(SF_PATH, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
      env: ENV,
    });
    return stdout || stderr;
  } catch (err) {
    if (err.stdout) return err.stdout;
    if (err.stderr) return err.stderr;
    throw new Error(`sf command failed: ${err.message}`);
  }
}

function resolveOrg(orgAlias) {
  return orgAlias || DEFAULT_ORG || undefined;
}

function orgArgs(orgAlias) {
  const org = resolveOrg(orgAlias);
  return org ? ["--target-org", org] : [];
}

const TOOLS = [
  {
    name: "sf_org_list",
    description:
      "List all authenticated Salesforce orgs. Returns aliases, usernames, org IDs, and connection status.",
    inputSchema: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description: "Include expired and deleted scratch orgs",
        },
      },
    },
  },
  {
    name: "sf_org_display",
    description:
      "Display detailed information about a specific org including instance URL, username, access token expiry, and org type.",
    inputSchema: {
      type: "object",
      properties: {
        org: {
          type: "string",
          description: "Org alias or username",
        },
      },
      required: ["org"],
    },
  },
  {
    name: "sf_query",
    description:
      "Execute a SOQL query against a Salesforce org. Returns records in JSON format.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SOQL query string" },
        org: { type: "string", description: "Org alias or username" },
        tooling: {
          type: "boolean",
          description: "Use Tooling API instead of standard API",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sf_search",
    description: "Execute a SOSL text search against a Salesforce org.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SOSL query string" },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["query"],
    },
  },
  {
    name: "sf_describe",
    description:
      "Describe an SObject — returns all fields, field types, relationships, picklist values, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "API name of the SObject" },
        org: { type: "string", description: "Org alias or username" },
        tooling: { type: "boolean", description: "Use Tooling API" },
      },
      required: ["sobject"],
    },
  },
  {
    name: "sf_list_objects",
    description: "List all SObjects available in the org.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Org alias or username" },
        category: {
          type: "string",
          description: "Filter by category: all, custom, standard",
        },
      },
    },
  },
  {
    name: "sf_create_record",
    description: "Create a new record on a Salesforce SObject.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "API name of the SObject" },
        values: {
          type: "string",
          description:
            'Field values in format: "Field1=value1 Field2=value2"',
        },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["sobject", "values"],
    },
  },
  {
    name: "sf_update_record",
    description: "Update an existing record on a Salesforce SObject.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "API name of the SObject" },
        record_id: { type: "string", description: "Record ID to update" },
        where: {
          type: "string",
          description:
            'Alternative to record_id: field=value pairs to identify record (e.g. "Name=Acme")',
        },
        values: {
          type: "string",
          description:
            'Field values to update in format: "Field1=value1 Field2=value2"',
        },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["sobject", "values"],
    },
  },
  {
    name: "sf_delete_record",
    description: "Delete a record from a Salesforce SObject.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "API name of the SObject" },
        record_id: { type: "string", description: "Record ID to delete" },
        where: {
          type: "string",
          description: "Alternative: field=value pairs to identify record",
        },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["sobject"],
    },
  },
  {
    name: "sf_get_record",
    description: "Retrieve a single record by ID or field criteria.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "API name of the SObject" },
        record_id: { type: "string", description: "Record ID" },
        where: {
          type: "string",
          description: "Alternative: field=value pairs",
        },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["sobject"],
    },
  },
  {
    name: "sf_bulk_import",
    description:
      "Bulk import records into an SObject from a CSV file using Bulk API 2.0.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "API name of the SObject" },
        file: { type: "string", description: "Path to CSV file" },
        org: { type: "string", description: "Org alias or username" },
        operation: {
          type: "string",
          enum: ["insert", "upsert"],
          description: "Bulk operation type",
        },
        external_id: {
          type: "string",
          description: "External ID field for upsert operations",
        },
      },
      required: ["sobject", "file"],
    },
  },
  {
    name: "sf_bulk_export",
    description:
      "Bulk export records from an SObject to a file using Bulk API 2.0.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SOQL query for export" },
        output_file: {
          type: "string",
          description: "Path to output file",
        },
        format: {
          type: "string",
          enum: ["csv", "json"],
          description: "Output format",
          default: "csv",
        },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["query", "output_file"],
    },
  },
  {
    name: "sf_deploy",
    description:
      "Deploy metadata to an org from a local source directory or manifest.",
    inputSchema: {
      type: "object",
      properties: {
        source_dir: {
          type: "string",
          description: "Path to source directory to deploy",
        },
        metadata: {
          type: "string",
          description:
            'Metadata components to deploy (e.g. "ApexClass:MyClass")',
        },
        manifest: {
          type: "string",
          description: "Path to package.xml manifest",
        },
        org: { type: "string", description: "Org alias or username" },
        dry_run: {
          type: "boolean",
          description: "Validate only, don't deploy",
        },
        test_level: {
          type: "string",
          enum: [
            "NoTestRun",
            "RunSpecifiedTests",
            "RunLocalTests",
            "RunAllTestsInOrg",
          ],
          description: "Test level for deployment",
        },
      },
    },
  },
  {
    name: "sf_retrieve",
    description: "Retrieve metadata from an org to a local directory.",
    inputSchema: {
      type: "object",
      properties: {
        metadata: {
          type: "string",
          description:
            'Metadata components to retrieve (e.g. "ApexClass:MyClass")',
        },
        manifest: {
          type: "string",
          description: "Path to package.xml manifest",
        },
        source_dir: {
          type: "string",
          description: "Source files to retrieve",
        },
        output_dir: {
          type: "string",
          description: "Output directory for retrieved files",
        },
        org: { type: "string", description: "Org alias or username" },
      },
    },
  },
  {
    name: "sf_apex_run",
    description:
      "Execute anonymous Apex code in an org. Provide either inline code or a file path.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Inline Apex code to execute",
        },
        file: {
          type: "string",
          description: "Path to .apex file to execute",
        },
        org: { type: "string", description: "Org alias or username" },
      },
    },
  },
  {
    name: "sf_apex_test",
    description: "Run Apex tests in an org.",
    inputSchema: {
      type: "object",
      properties: {
        class_names: {
          type: "string",
          description: "Comma-separated test class names",
        },
        suite_names: {
          type: "string",
          description: "Comma-separated test suite names",
        },
        test_level: {
          type: "string",
          enum: [
            "RunSpecifiedTests",
            "RunLocalTests",
            "RunAllTestsInOrg",
          ],
          description: "Test level",
        },
        org: { type: "string", description: "Org alias or username" },
        code_coverage: {
          type: "boolean",
          description: "Include code coverage results",
        },
      },
    },
  },
  {
    name: "sf_apex_log",
    description: "List or retrieve Apex debug logs from an org.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get"],
          description: "List logs or get a specific log",
        },
        log_id: {
          type: "string",
          description: "Log ID to retrieve (for get action)",
        },
        number: {
          type: "number",
          description: "Number of most recent logs to retrieve",
        },
        org: { type: "string", description: "Org alias or username" },
      },
    },
  },
  {
    name: "sf_list_metadata",
    description: "List metadata components of a specified type in an org.",
    inputSchema: {
      type: "object",
      properties: {
        metadata_type: {
          type: "string",
          description:
            "Metadata type name (e.g. CustomObject, ApexClass, Flow)",
        },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["metadata_type"],
    },
  },
  {
    name: "sf_org_limits",
    description:
      "Display API limits and usage for an org (DailyApiRequests, DataStorageMB, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Org alias or username" },
      },
    },
  },
  {
    name: "sf_rest_api",
    description:
      "Make a raw REST API request to a Salesforce org. Use for endpoints not covered by other tools.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description:
            "REST API endpoint path (e.g. /services/data/v62.0/sobjects/Account/describe)",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
          description: "HTTP method",
          default: "GET",
        },
        body: {
          type: "string",
          description: "Request body (JSON string) for POST/PATCH/PUT",
        },
        org: { type: "string", description: "Org alias or username" },
      },
      required: ["endpoint"],
    },
  },
  {
    name: "sf_run_command",
    description:
      "Run any arbitrary sf CLI command. Use when no specific tool covers your need. Provide the full command after 'sf'.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'The sf CLI command to run (everything after "sf", e.g. "org list --all --json")',
        },
      },
      required: ["command"],
    },
  },
];

const TOOL_HANDLERS = {
  async sf_org_list({ all }) {
    const args = ["org", "list", "--json"];
    if (all) args.push("--all");
    return runSf(args);
  },

  async sf_org_display({ org }) {
    return runSf(["org", "display", ...orgArgs(org), "--json"]);
  },

  async sf_query({ query, org, tooling }) {
    const args = ["data", "query", "-q", query, ...orgArgs(org), "--json"];
    if (tooling) args.push("--use-tooling-api");
    return runSf(args);
  },

  async sf_search({ query, org }) {
    return runSf([
      "data",
      "search",
      "-q",
      query,
      ...orgArgs(org),
      "--json",
    ]);
  },

  async sf_describe({ sobject, org, tooling }) {
    const args = [
      "sobject",
      "describe",
      "-s",
      sobject,
      ...orgArgs(org),
      "--json",
    ];
    if (tooling) args.push("--use-tooling-api");
    return runSf(args);
  },

  async sf_list_objects({ org, category }) {
    const args = ["sobject", "list", ...orgArgs(org), "--json"];
    if (category) args.push("-s", category);
    return runSf(args);
  },

  async sf_create_record({ sobject, values, org }) {
    return runSf([
      "data",
      "create",
      "record",
      "-s",
      sobject,
      "-v",
      values,
      ...orgArgs(org),
      "--json",
    ]);
  },

  async sf_update_record({ sobject, record_id, where, values, org }) {
    const args = [
      "data",
      "update",
      "record",
      "-s",
      sobject,
      "-v",
      values,
      ...orgArgs(org),
      "--json",
    ];
    if (record_id) args.push("-i", record_id);
    if (where) args.push("-w", where);
    return runSf(args);
  },

  async sf_delete_record({ sobject, record_id, where, org }) {
    const args = [
      "data",
      "delete",
      "record",
      "-s",
      sobject,
      ...orgArgs(org),
      "--json",
    ];
    if (record_id) args.push("-i", record_id);
    if (where) args.push("-w", where);
    return runSf(args);
  },

  async sf_get_record({ sobject, record_id, where, org }) {
    const args = [
      "data",
      "get",
      "record",
      "-s",
      sobject,
      ...orgArgs(org),
      "--json",
    ];
    if (record_id) args.push("-i", record_id);
    if (where) args.push("-w", where);
    return runSf(args);
  },

  async sf_bulk_import({ sobject, file, org, operation, external_id }) {
    if (operation === "upsert" && external_id) {
      return runSf([
        "data",
        "upsert",
        "bulk",
        "-s",
        sobject,
        "-f",
        file,
        "-i",
        external_id,
        ...orgArgs(org),
        "--json",
        "-w",
        "10",
      ]);
    }
    return runSf([
      "data",
      "import",
      "bulk",
      "-s",
      sobject,
      "-f",
      file,
      ...orgArgs(org),
      "--json",
      "-w",
      "10",
    ]);
  },

  async sf_bulk_export({ query, output_file, format, org }) {
    return runSf([
      "data",
      "export",
      "bulk",
      "-q",
      query,
      "--output-file",
      output_file,
      "-r",
      format || "csv",
      ...orgArgs(org),
      "--json",
      "-w",
      "10",
    ]);
  },

  async sf_deploy({ source_dir, metadata, manifest, org, dry_run, test_level }) {
    const args = ["project", "deploy", "start", ...orgArgs(org), "--json"];
    if (source_dir) args.push("-d", source_dir);
    if (metadata) args.push("-m", metadata);
    if (manifest) args.push("-x", manifest);
    if (dry_run) args.push("--dry-run");
    if (test_level) args.push("-l", test_level);
    return runSf(args);
  },

  async sf_retrieve({ metadata, manifest, source_dir, output_dir, org }) {
    const args = [
      "project",
      "retrieve",
      "start",
      ...orgArgs(org),
      "--json",
    ];
    if (metadata) args.push("-m", metadata);
    if (manifest) args.push("-x", manifest);
    if (source_dir) args.push("-d", source_dir);
    if (output_dir) args.push("-r", output_dir);
    return runSf(args);
  },

  async sf_apex_run({ code, file, org }) {
    const args = ["apex", "run", ...orgArgs(org), "--json"];
    if (file) {
      args.push("-f", file);
    }
    // For inline code, we write to stdin — but sf CLI doesn't support that well via execFile.
    // Instead, use a temp approach: write to a temp file.
    if (code && !file) {
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const tmpFile = join(tmpdir(), `sf-apex-${Date.now()}.apex`);
      writeFileSync(tmpFile, code);
      args.push("-f", tmpFile);
      try {
        const result = await runSf(args);
        unlinkSync(tmpFile);
        return result;
      } catch (e) {
        unlinkSync(tmpFile);
        throw e;
      }
    }
    return runSf(args);
  },

  async sf_apex_test({ class_names, suite_names, test_level, org, code_coverage }) {
    const args = ["apex", "run", "test", ...orgArgs(org), "--json"];
    if (class_names) args.push("-n", class_names);
    if (suite_names) args.push("-s", suite_names);
    if (test_level) args.push("-l", test_level);
    if (code_coverage) args.push("-c");
    return runSf(args);
  },

  async sf_apex_log({ action, log_id, number, org }) {
    if (action === "get" && log_id) {
      return runSf([
        "apex",
        "get",
        "log",
        "-i",
        log_id,
        ...orgArgs(org),
        "--json",
      ]);
    }
    if (action === "get" && number) {
      return runSf([
        "apex",
        "get",
        "log",
        "-n",
        String(number),
        ...orgArgs(org),
        "--json",
      ]);
    }
    return runSf(["apex", "list", "log", ...orgArgs(org), "--json"]);
  },

  async sf_list_metadata({ metadata_type, org }) {
    return runSf([
      "org",
      "list",
      "metadata",
      "-m",
      metadata_type,
      ...orgArgs(org),
      "--json",
    ]);
  },

  async sf_org_limits({ org }) {
    return runSf(["org", "list", "limits", ...orgArgs(org), "--json"]);
  },

  async sf_rest_api({ endpoint, method, body, org }) {
    const args = [
      "api",
      "request",
      "rest",
      endpoint,
      ...orgArgs(org),
      "--json",
    ];
    if (method) args.push("-X", method);
    if (body) args.push("-b", body);
    return runSf(args);
  },

  async sf_run_command({ command }) {
    const args = command.split(/\s+/);
    if (!args.includes("--json")) args.push("--json");
    return runSf(args);
  },
};

const server = new Server(
  { name: "salesforce-cli", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await handler(args || {});
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
