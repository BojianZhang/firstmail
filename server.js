const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// 简易 .env 加载（无第三方依赖）：把同目录 .env 里的 KEY=VALUE 注入 process.env。
function loadDotEnv() {
  try {
    const content = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    content.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) return;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    });
  } catch (error) {
    // 没有 .env 文件就忽略，使用真实环境变量。
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
// 默认绑定 127.0.0.1：部署到服务器时用 Nginx 反代到本地端口最安全。
// 如需让 Node 直接对外监听，可设置环境变量 HOST=0.0.0.0。
const HOST = process.env.HOST || "127.0.0.1";
const CHANGE_PASSWORD_API_URL = "https://firstmail.ltd/api/v1/email/password/change/";
const MESSAGES_API_URL = "https://firstmail.ltd/api/v1/email/messages";
const LATEST_MESSAGE_API_URL = "https://firstmail.ltd/api/v1/email/messages/latest";
// API Key 只从环境变量 / .env 读取，绝不写死在源码里（避免泄露到仓库）。
const API_KEY = process.env.FIRSTMAIL_API_KEY || "";
if (!API_KEY) {
  console.error("[启动失败] 未设置 FIRSTMAIL_API_KEY。请在 .env 文件或环境变量中配置后再启动。");
  process.exit(1);
}
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readBinaryBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function hasCredentialFields(data) {
  if (!data || typeof data !== "object") return false;
  const fields = ["access_token", "refresh_token", "id_token", "email", "client_id", "account_id", "password", "plan_type"];
  return fields.some(field => Object.prototype.hasOwnProperty.call(data, field));
}

function normalizeCredentialAccounts(data, sourceFile) {
  let accounts = [];

  if (Array.isArray(data)) {
    accounts = data;
  } else if (data && Array.isArray(data.accounts)) {
    accounts = data.accounts;
  } else if (data && data.credentials) {
    accounts = [data];
  } else if (hasCredentialFields(data)) {
    accounts = [{ name: data.email || "", platform: "", type: data.type || "", credentials: data }];
  }

  return accounts
    .filter(account => account && typeof account === "object")
    .map((account, index) => ({
      index: index + 1,
      name: account.name || account.email || (account.credentials && account.credentials.email) || "",
      platform: account.platform || "",
      type: account.type || "",
      source_file: sourceFile || account.source_file || "",
      credentials: account.credentials && typeof account.credentials === "object" ? account.credentials : {}
    }))
    .filter(account => Object.keys(account.credentials).length > 0);
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("Invalid ZIP file");
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory");
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    if (!name.endsWith("/")) {
      entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local header: ${entry.name}`);
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
}

async function parseCredentialsZip(req, res) {
  try {
    const buffer = await readBinaryBody(req);
    const entries = readZipEntries(buffer).filter(entry => /\.json$/i.test(entry.name));
    const accounts = [];
    const skipped = [];

    for (const entry of entries) {
      try {
        const text = readZipEntry(buffer, entry).toString("utf8");
        const data = JSON.parse(text);
        accounts.push(...normalizeCredentialAccounts(data, entry.name));
      } catch (error) {
        skipped.push({ file: entry.name, error: error.message });
      }
    }

    sendJson(res, 200, {
      accounts,
      total_json_files: entries.length,
      parsed_accounts: accounts.length,
      skipped
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "ZIP parse failed" });
  }
}

async function proxyChangePassword(req, res) {
  let payload;

  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: "Invalid JSON request body" });
    return;
  }

  if (!payload.email || !payload.current_password || !payload.new_password) {
    sendJson(res, 400, { error: "Missing email/current_password/new_password" });
    return;
  }

  try {
    const upstream = await fetch(CHANGE_PASSWORD_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "X-API-KEY": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "FirstMailLocalBatchTool/1.0"
      },
      body: JSON.stringify({
        email: payload.email,
        current_password: payload.current_password,
        new_password: payload.new_password
      })
    });

    const contentType = upstream.headers.get("content-type") || "";
    const text = await upstream.text();

    if (contentType.includes("text/html") || /<title>\s*Captcha\s*<\/title>/i.test(text)) {
      sendJson(res, 403, {
        error: "The upstream API returned a captcha/protection page instead of JSON"
      });
      return;
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = { message: text || `HTTP ${upstream.status}` };
    }

    sendJson(res, upstream.status, data || { message: upstream.ok ? "Password changed" : `HTTP ${upstream.status}` });
  } catch (error) {
    sendJson(res, 502, { error: `Local proxy request failed: ${error.message}` });
  }
}

async function proxyMessages(req, res) {
  let payload;

  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: "Invalid JSON request body" });
    return;
  }

  if (!payload.email || !payload.password) {
    sendJson(res, 400, { error: "Missing email/password" });
    return;
  }

  const limit = Math.max(1, Math.min(100, Number(payload.limit) || 10));
  const folder = payload.folder || "INBOX";

  try {
    const upstream = await fetch(MESSAGES_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "X-API-KEY": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "FirstMailLocalMessageTool/1.0"
      },
      body: JSON.stringify({
        email: payload.email,
        password: payload.password,
        limit,
        folder
      })
    });

    const contentType = upstream.headers.get("content-type") || "";
    const text = await upstream.text();

    if (contentType.includes("text/html") || /<title>\s*Captcha\s*<\/title>/i.test(text)) {
      sendJson(res, 403, {
        error: "The upstream API returned a captcha/protection page instead of JSON"
      });
      return;
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = { message: text || `HTTP ${upstream.status}` };
    }

    sendJson(res, upstream.status, data || { message: upstream.ok ? "Messages loaded" : `HTTP ${upstream.status}` });
  } catch (error) {
    sendJson(res, 502, { error: `Local proxy request failed: ${error.message}` });
  }
}

async function proxyLatestMessage(req, res) {
  let payload;

  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: "Invalid JSON request body" });
    return;
  }

  if (!payload.email || !payload.password) {
    sendJson(res, 400, { error: "Missing email/password" });
    return;
  }

  const folder = payload.folder || "INBOX";

  try {
    const upstream = await fetch(LATEST_MESSAGE_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "X-API-KEY": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "FirstMailLocalMessageTool/1.0"
      },
      body: JSON.stringify({
        email: payload.email,
        password: payload.password,
        folder
      })
    });

    const contentType = upstream.headers.get("content-type") || "";
    const text = await upstream.text();

    if (contentType.includes("text/html") || /<title>\s*Captcha\s*<\/title>/i.test(text)) {
      sendJson(res, 403, {
        error: "The upstream API returned a captcha/protection page instead of JSON"
      });
      return;
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = { message: text || `HTTP ${upstream.status}` };
    }

    sendJson(res, upstream.status, data || { message: upstream.ok ? "Latest message loaded" : `HTTP ${upstream.status}` });
  } catch (error) {
    sendJson(res, 502, { error: `Local proxy request failed: ${error.message}` });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  // 用 ROOT + 分隔符做前缀判断，避免 /etc 误匹配 /etc-evil 这类越界路径。
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/change-password") {
    proxyChangePassword(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/messages/latest") {
    proxyLatestMessage(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/messages") {
    proxyMessages(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/credentials/zip") {
    parseCredentialsZip(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  console.log(`FirstMail batch tool listening on http://${HOST}:${PORT}/`);
});
