import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

// ─── Configuration ──────────────────────────────────────────
const API_VERSION = "62.0";
const CLIENT_ID = "PlatformCLI";
const CALLBACK_PORT = 1717;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/OauthRedirect`;
const CREDS_DIR = join(homedir(), ".sf-claude");
const CREDS_FILE = join(CREDS_DIR, "credentials.json");

// ─── Credential Storage ────────────────────────────────────
function loadOrgs() {
  if (!existsSync(CREDS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CREDS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveOrgs(orgs) {
  if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(CREDS_FILE, JSON.stringify(orgs, null, 2));
}

function getOrg(alias) {
  const orgs = loadOrgs();
  const key = alias || process.env.DEFAULT_ORG;
  if (key && orgs[key]) return { _alias: key, ...orgs[key] };
  const keys = Object.keys(orgs);
  if (keys.length === 0) {
    throw new Error(
      "No Salesforce orgs connected. Use the sf_org_login tool to authenticate."
    );
  }
  return { _alias: keys[0], ...orgs[keys[0]] };
}

// ─── Token Refresh ─────────────────────────────────────────
async function refreshToken(org) {
  const res = await fetch(`${org.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: org.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(
      "Session expired. Re-authenticate with sf_org_login."
    );
  }
  const data = await res.json();
  const orgs = loadOrgs();
  if (orgs[org._alias]) {
    orgs[org._alias].accessToken = data.access_token;
    if (data.instance_url) orgs[org._alias].instanceUrl = data.instance_url;
    saveOrgs(orgs);
  }
  return data.access_token;
}

// ─── Salesforce API Helper ─────────────────────────────────
async function sfApi(orgAlias, path, opts = {}) {
  const org = getOrg(orgAlias);
  const doFetch = (token) =>
    fetch(
      `${org.instanceUrl}/services/data/v${API_VERSION}${path}`,
      {
        method: opts.method || "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...opts.headers,
        },
        body:
          opts.body != null
            ? typeof opts.body === "string"
              ? opts.body
              : JSON.stringify(opts.body)
            : undefined,
      }
    );

  let res = await doFetch(org.accessToken);
  if (res.status === 401 && org.refreshToken) {
    const newToken = await refreshToken(org);
    res = await doFetch(newToken);
  }
  if (res.status === 204) return { success: true };
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data, null, 2));
  return data;
}

// Raw API call (for endpoints with full path like /services/...)
async function sfRawApi(orgAlias, fullPath, opts = {}) {
  const org = getOrg(orgAlias);
  const doFetch = (token) =>
    fetch(`${org.instanceUrl}${fullPath}`, {
      method: opts.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
      body:
        opts.body != null
          ? typeof opts.body === "string"
            ? opts.body
            : JSON.stringify(opts.body)
          : undefined,
    });

  let res = await doFetch(org.accessToken);
  if (res.status === 401 && org.refreshToken) {
    const newToken = await refreshToken(org);
    res = await doFetch(newToken);
  }
  return res;
}

// ─── OAuth Login Flow ──────────────────────────────────────
function oauthLogin(alias, loginUrl) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      scope: "api refresh_token",
    });
    const authUrl = `${loginUrl}/services/oauth2/authorize?${params}`;
    let settled = false;

    const httpServer = createServer(async (req, res) => {
      if (settled) return;
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/OauthRedirect") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error || !code) {
        settled = true;
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Authentication failed</h2><p>${error || "No authorization code received"}</p></body></html>`
        );
        httpServer.close();
        reject(new Error(error || "No authorization code received"));
        return;
      }

      try {
        const tokenRes = await fetch(
          `${loginUrl}/services/oauth2/token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: CLIENT_ID,
              redirect_uri: CALLBACK_URL,
              code,
            }),
          }
        );
        if (!tokenRes.ok) throw new Error(await tokenRes.text());
        const tokens = await tokenRes.json();

        let identity = {};
        try {
          const idRes = await fetch(tokens.id, {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          });
          if (idRes.ok) identity = await idRes.json();
        } catch {}

        const orgData = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          instanceUrl: tokens.instance_url,
          loginUrl,
          username: identity.username || "",
          orgId: identity.organization_id || "",
          displayName: identity.display_name || "",
          authenticatedAt: new Date().toISOString(),
        };

        const orgs = loadOrgs();
        orgs[alias] = orgData;
        saveOrgs(orgs);

        settled = true;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          [
            '<html><body style="font-family:system-ui;text-align:center;padding:60px">',
            '<h2 style="color:#22c55e">Connected to Salesforce</h2>',
            `<p style="font-size:18px"><b>${orgData.username}</b></p>`,
            `<p>Saved as: <code style="background:#f1f5f9;padding:2px 8px;border-radius:4px">${alias}</code></p>`,
            '<p style="color:#666;margin-top:24px">You can close this window and return to Claude.</p>',
            "</body></html>",
          ].join("")
        );
        httpServer.close();
        resolve(orgData);
      } catch (err) {
        settled = true;
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(
          `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Authentication failed</h2><pre>${err.message}</pre></body></html>`
        );
        httpServer.close();
        reject(err);
      }
    });

    httpServer.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `Could not start login server on port ${CALLBACK_PORT}: ${err.message}. Is another sf login in progress?`
          )
        );
      }
    });

    httpServer.listen(CALLBACK_PORT, () => {
      const open =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      exec(`${open} "${authUrl}"`);
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        httpServer.close();
        reject(new Error("Login timed out after 2 minutes. Try again."));
      }
    }, 120000);
  });
}

// ─── Tool Definitions ──────────────────────────────────────
const TOOLS = [
  {
    name: "sf_org_login",
    description:
      "Connect a Salesforce org by opening a browser login window. Use login_url 'https://test.salesforce.com' for sandboxes.",
    inputSchema: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description:
            "Short name for this org (e.g. 'prod', 'dev', 'staging')",
        },
        login_url: {
          type: "string",
          description:
            "https://login.salesforce.com (production, default) or https://test.salesforce.com (sandbox)",
        },
      },
      required: ["alias"],
    },
  },
  {
    name: "sf_org_logout",
    description: "Disconnect a Salesforce org and remove stored credentials.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Org alias to disconnect" },
      },
      required: ["alias"],
    },
  },
  {
    name: "sf_org_list",
    description:
      "List all connected Salesforce orgs with aliases, usernames, and instance URLs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sf_org_display",
    description:
      "Show detailed information about a connected org.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Org alias" },
      },
    },
  },
  {
    name: "sf_query",
    description:
      "Execute a SOQL query. Returns matching records in JSON.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'SOQL query (e.g. "SELECT Id, Name FROM Account LIMIT 10")',
        },
        org: { type: "string", description: "Org alias" },
        tooling: {
          type: "boolean",
          description: "Query the Tooling API instead",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sf_search",
    description: "Execute a SOSL text search across objects.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'SOSL query (e.g. "FIND {Acme} IN ALL FIELDS")',
        },
        org: { type: "string", description: "Org alias" },
      },
      required: ["query"],
    },
  },
  {
    name: "sf_describe",
    description:
      "Describe an SObject — returns fields, types, relationships, picklist values.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: {
          type: "string",
          description: "API name (e.g. Account, Opportunity, Custom__c)",
        },
        org: { type: "string", description: "Org alias" },
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
        org: { type: "string", description: "Org alias" },
      },
    },
  },
  {
    name: "sf_create_record",
    description: "Create a new record.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "SObject API name" },
        values: {
          type: "object",
          description:
            'Field values as JSON (e.g. {"Name": "Acme", "Industry": "Technology"})',
        },
        org: { type: "string", description: "Org alias" },
      },
      required: ["sobject", "values"],
    },
  },
  {
    name: "sf_update_record",
    description: "Update an existing record.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "SObject API name" },
        record_id: { type: "string", description: "Record ID" },
        values: {
          type: "object",
          description: "Field values to update",
        },
        org: { type: "string", description: "Org alias" },
      },
      required: ["sobject", "record_id", "values"],
    },
  },
  {
    name: "sf_delete_record",
    description: "Delete a record.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "SObject API name" },
        record_id: { type: "string", description: "Record ID" },
        org: { type: "string", description: "Org alias" },
      },
      required: ["sobject", "record_id"],
    },
  },
  {
    name: "sf_get_record",
    description: "Retrieve a single record by ID.",
    inputSchema: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "SObject API name" },
        record_id: { type: "string", description: "Record ID" },
        fields: {
          type: "string",
          description: "Comma-separated field names (optional, returns all if omitted)",
        },
        org: { type: "string", description: "Org alias" },
      },
      required: ["sobject", "record_id"],
    },
  },
  {
    name: "sf_apex_run",
    description: "Execute anonymous Apex code.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Apex code to execute" },
        org: { type: "string", description: "Org alias" },
      },
      required: ["code"],
    },
  },
  {
    name: "sf_apex_test",
    description: "Run Apex tests.",
    inputSchema: {
      type: "object",
      properties: {
        class_names: {
          type: "string",
          description: "Comma-separated test class names",
        },
        test_level: {
          type: "string",
          enum: ["RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"],
          description: "Test level",
        },
        org: { type: "string", description: "Org alias" },
      },
    },
  },
  {
    name: "sf_apex_log",
    description: "List or retrieve Apex debug logs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get"],
          description: "List recent logs or get a specific log body",
        },
        log_id: {
          type: "string",
          description: "Log ID (for 'get' action)",
        },
        org: { type: "string", description: "Org alias" },
      },
    },
  },
  {
    name: "sf_list_metadata",
    description:
      "List metadata components (ApexClass, ApexTrigger, CustomObject, Flow, etc.) via Tooling API.",
    inputSchema: {
      type: "object",
      properties: {
        metadata_type: {
          type: "string",
          description:
            "Tooling API type (e.g. ApexClass, ApexTrigger, CustomObject, Flow)",
        },
        org: { type: "string", description: "Org alias" },
      },
      required: ["metadata_type"],
    },
  },
  {
    name: "sf_org_limits",
    description: "Show API request limits and usage.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", description: "Org alias" },
      },
    },
  },
  {
    name: "sf_rest_api",
    description:
      "Make a raw REST API request. Use for any endpoint not covered by other tools.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          description:
            "Full API path (e.g. /services/data/v62.0/sobjects/Account/describe)",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
          description: "HTTP method (default: GET)",
        },
        body: {
          type: "object",
          description: "Request body for POST/PATCH/PUT",
        },
        org: { type: "string", description: "Org alias" },
      },
      required: ["endpoint"],
    },
  },
];

// ─── Tool Handlers ─────────────────────────────────────────
const TOOL_HANDLERS = {
  async sf_org_login({ alias, login_url }) {
    const result = await oauthLogin(
      alias,
      login_url || "https://login.salesforce.com"
    );
    return JSON.stringify(
      {
        success: true,
        alias,
        username: result.username,
        instanceUrl: result.instanceUrl,
        orgId: result.orgId,
      },
      null,
      2
    );
  },

  async sf_org_logout({ alias }) {
    const orgs = loadOrgs();
    if (!orgs[alias])
      return JSON.stringify({ error: `Org "${alias}" not found` });
    delete orgs[alias];
    saveOrgs(orgs);
    return JSON.stringify({ success: true, removed: alias });
  },

  async sf_org_list() {
    const orgs = loadOrgs();
    const list = Object.entries(orgs).map(([alias, o]) => ({
      alias,
      username: o.username,
      instanceUrl: o.instanceUrl,
      orgId: o.orgId,
      authenticatedAt: o.authenticatedAt,
    }));
    if (list.length === 0) {
      return JSON.stringify({
        message:
          "No orgs connected. Use sf_org_login to authenticate a Salesforce org.",
      });
    }
    return JSON.stringify(list, null, 2);
  },

  async sf_org_display({ org }) {
    const o = getOrg(org);
    try {
      const versions = await sfApi(org, "");
      return JSON.stringify(
        {
          alias: o._alias,
          username: o.username,
          instanceUrl: o.instanceUrl,
          orgId: o.orgId,
          authenticatedAt: o.authenticatedAt,
          latestApiVersion: Array.isArray(versions)
            ? versions[versions.length - 1]?.version
            : undefined,
        },
        null,
        2
      );
    } catch {
      return JSON.stringify(
        {
          alias: o._alias,
          username: o.username,
          instanceUrl: o.instanceUrl,
          orgId: o.orgId,
          authenticatedAt: o.authenticatedAt,
        },
        null,
        2
      );
    }
  },

  async sf_query({ query, org, tooling }) {
    const prefix = tooling ? "/tooling" : "";
    const result = await sfApi(
      org,
      `${prefix}/query?q=${encodeURIComponent(query)}`
    );
    return JSON.stringify(result, null, 2);
  },

  async sf_search({ query, org }) {
    const result = await sfApi(
      org,
      `/search?q=${encodeURIComponent(query)}`
    );
    return JSON.stringify(result, null, 2);
  },

  async sf_describe({ sobject, org }) {
    const result = await sfApi(org, `/sobjects/${sobject}/describe`);
    return JSON.stringify(result, null, 2);
  },

  async sf_list_objects({ org }) {
    const result = await sfApi(org, "/sobjects");
    return JSON.stringify(result, null, 2);
  },

  async sf_create_record({ sobject, values, org }) {
    const result = await sfApi(org, `/sobjects/${sobject}`, {
      method: "POST",
      body: values,
    });
    return JSON.stringify(result, null, 2);
  },

  async sf_update_record({ sobject, record_id, values, org }) {
    await sfApi(org, `/sobjects/${sobject}/${record_id}`, {
      method: "PATCH",
      body: values,
    });
    return JSON.stringify({ success: true, id: record_id });
  },

  async sf_delete_record({ sobject, record_id, org }) {
    await sfApi(org, `/sobjects/${sobject}/${record_id}`, {
      method: "DELETE",
    });
    return JSON.stringify({ success: true, deleted: record_id });
  },

  async sf_get_record({ sobject, record_id, fields, org }) {
    let path = `/sobjects/${sobject}/${record_id}`;
    if (fields) path += `?fields=${encodeURIComponent(fields)}`;
    const result = await sfApi(org, path);
    return JSON.stringify(result, null, 2);
  },

  async sf_apex_run({ code, org }) {
    const result = await sfApi(
      org,
      `/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(code)}`
    );
    return JSON.stringify(result, null, 2);
  },

  async sf_apex_test({ class_names, test_level, org }) {
    if (class_names) {
      const tests = class_names
        .split(",")
        .map((c) => ({ className: c.trim() }));
      const result = await sfApi(org, "/tooling/runTestsSynchronous", {
        method: "POST",
        body: { tests },
      });
      return JSON.stringify(result, null, 2);
    }
    if (test_level) {
      const result = await sfApi(org, "/tooling/runTestsAsynchronous", {
        method: "POST",
        body: { testLevel: test_level },
      });
      return JSON.stringify(result, null, 2);
    }
    return JSON.stringify({
      error: "Provide class_names or test_level",
    });
  },

  async sf_apex_log({ action, log_id, org }) {
    if (action === "get" && log_id) {
      const res = await sfRawApi(
        org,
        `/services/data/v${API_VERSION}/sobjects/ApexLog/${log_id}/Body`
      );
      return await res.text();
    }
    const result = await sfApi(
      org,
      `/tooling/query?q=${encodeURIComponent(
        "SELECT Id, LogLength, Request, Operation, Application, Status, StartTime, DurationMilliseconds FROM ApexLog ORDER BY StartTime DESC LIMIT 20"
      )}`
    );
    return JSON.stringify(result, null, 2);
  },

  async sf_list_metadata({ metadata_type, org }) {
    const query = `SELECT Id, Name, NamespacePrefix FROM ${metadata_type} ORDER BY Name`;
    const result = await sfApi(
      org,
      `/tooling/query?q=${encodeURIComponent(query)}`
    );
    return JSON.stringify(result, null, 2);
  },

  async sf_org_limits({ org }) {
    const result = await sfApi(org, "/limits");
    return JSON.stringify(result, null, 2);
  },

  async sf_rest_api({ endpoint, method, body, org }) {
    const res = await sfRawApi(org, endpoint, {
      method: method || "GET",
      body,
    });
    const text = await res.text();
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  },
};

// ─── MCP Server ────────────────────────────────────────────
const server = new Server(
  { name: "salesforce-cli", version: "2.0.0" },
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
