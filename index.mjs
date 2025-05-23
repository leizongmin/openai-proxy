import { Buffer } from "node:buffer";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";
import util from "node:util";

const port = parseInt(process.env.PORT || "8080", 10);
if (!(port > 0)) {
  throw new Error(`invalid port: ${port} (env PORT=${process.env.PORT})`);
}

const logToStdout = (() => {
  const flag = String(process.env.LOG_STDOUT).toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on") {
    // enable log to stdout if env LOG_STDOUT is set
    console.log("LOG_STDOUT is enabled");
    return true;
  } else {
    // default: disable log to stdout
    return false;
  }
})();

const logDir = path.resolve(process.env.LOG_DIR || "./logs");
if (!logToStdout && !fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function appendLog(file, content) {
  if (logToStdout) {
    console.log(file, content.toString());
  } else {
    fs.appendFileSync(file, content);
  }
}

const modelName = (process.env.MODEL_NAME || "").trim();
log("Target model name: %s", modelName);

// API_SERVER example: https://example.com
const apiServer = (process.env.API_SERVER || "").trim();
if (!apiServer) {
  throw new Error(
    `invalid api server: ${apiServer} (env API_SERVER=${process.env.API_SERVER})`
  );
}
const apiUrl = new URL(apiServer);
const apiUrlIsHttps = apiUrl.protocol === "https:";
log("Target api server: %s", apiServer);

const apiKey = (process.env.API_KEY || "").trim();
log(
  "Replace api key: %s",
  apiKey ? apiKey.slice(0, 3) + "***" + apiKey.slice(-3) : ""
);

const allowedPaths = (() => {
  if (process.env.ALLOWED_PATH) {
    const allowedPaths = process.env.ALLOWED_PATH.split(",");
    log("Allowed paths: %s", allowedPaths.join(", "));
    return allowedPaths.map((path) => {
      path = path.trim();
      if (!path.startsWith("/")) {
        path = "/" + path;
      }
      if (!path.endsWith("/")) {
        path = path + "/";
      }
      return path;
    });
  } else {
    return ["/"];
  }
})();

let requestCounter = 0;
const server = http.createServer((clientReq, clientRes) => {
  const url = new URL(clientReq.url, `http://${clientReq.headers.host}`);

  // handle root path, just return a plain text
  if (url.pathname === "/") {
    clientRes.writeHead(200, { "Content-Type": "text/plain" });
    clientRes.end("Server is running, uptime: " + process.uptime() + "s");
    return;
  }

  // check the path
  if (!allowedPaths.some((path) => url.pathname.startsWith(path))) {
    clientRes.writeHead(403);
    clientRes.end("Forbidden");
    log(
      "Forbidden %s %s%s from %s, UA=%s",
      clientReq.method,
      clientReq.headers.host || "",
      clientReq.url,
      clientReq.socket.remoteAddress,
      clientReq.headers["user-agent"] || "none"
    );
    return;
  }

  requestCounter++;
  const logFileName =
    getDateTimeString("yyyymmdd") +
    "/PID" +
    process.pid +
    "_" +
    String(requestCounter).padStart(6, "0") +
    "_" +
    getDateTimeString("hhiiss");
  const logFile = path.join(logDir, logFileName + ".log");
  const logRequestFile = path.join(logDir, logFileName + "_request.json");
  const logResponseFile = path.join(logDir, logFileName + "_response.jsonl");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const options = {
    hostname: apiUrl.hostname,
    port: apiUrl.port || (apiUrlIsHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: clientReq.method,
    headers: clientReq.headers,
  };
  delete options.headers.host;
  log(
    "Proxy request %s %s%s from %s, UA=%s",
    options.method,
    clientReq.headers.host || "",
    options.path,
    clientReq.socket.remoteAddress,
    clientReq.headers["user-agent"] || "none"
  );

  // modify the api key
  if (apiKey) {
    options.headers.authorization = `Bearer ${apiKey}`;
  }

  // remove accept-encoding header
  delete options.headers["accept-encoding"];

  // save the request info
  const requestChunks = [];
  let requestBody;
  let requestHeaders = `${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}\r\n`;
  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (key.toLowerCase() === "authorization") {
      const authValue = value.toString();
      const maskedValue = authValue.slice(0, 7) + "***" + authValue.slice(-3);
      requestHeaders += `${key}: ${maskedValue}\r\n`;
    } else {
      requestHeaders += `${key}: ${value}\r\n`;
    }
  }
  requestHeaders += "\r\n";
  appendLog(logFile, requestHeaders);

  clientReq.on("data", (chunk) => {
    requestChunks.push(chunk);
  });

  clientReq.on("end", () => {
    try {
      requestBody = Buffer.concat(requestChunks);
      // if json request, rewrite it
      if (
        clientReq.headers["content-type"]?.includes("application/json") &&
        requestBody.length > 0
      ) {
        const data = JSON.parse(requestBody.toString());

        // modify the model name
        if (modelName && data.model) {
          data.model = modelName;
          log("Rewrite model name: %s", data.model);
        }

        // normalize the prompt
        if (Array.isArray(data.system)) {
          data.messages.unshift({
            role: "system",
            content: data.system,
          });
          delete data.system;
          log("Rewrite system to messages");
        }

        // normalize the tools
        if (
          Array.isArray(data.tools) &&
          data.tools.length > 0 &&
          typeof data.tools[0].name === "string"
        ) {
          for (let i = 0; i < data.tools.length; i++) {
            const tool = data.tools[i];
            tool.parameters = tool.input_schema;
            delete tool.input_schema;
            data.tools[i] = {
              type: "function",
              function: tool,
            };
          }
          log("Rewrite tools format: %d", data.tools.length);
        }

        // normalize the tool choice
        if (data.tool_choice && typeof data.tool_choice.type === "string") {
          data.tool_choice = data.tool_choice.type;
          log("Rewrite tool_choice to string: %s", data.tool_choice);
        }

        requestBody = Buffer.from(JSON.stringify(data));
        options.headers["content-length"] = requestBody.length;
      }

      // save the request body
      appendLog(logFile, requestBody);
      appendLog(logFile, "\n\n--------------------\n");
      if (requestBody.length > 0) {
        try {
          appendLog(
            logRequestFile,
            JSON.stringify(JSON.parse(requestBody.toString()), null, 2)
          );
        } catch (err) {
          log("Request body is not json, save it as plain text");
          appendLog(logRequestFile, requestBody.toString());
        }
      }

      const proxyReq = (apiUrlIsHttps ? https : http).request(
        options,
        (proxyRes) => {
          // save the response info
          let responseChunks = [];
          let responseBody;
          let responseHeaders = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            responseHeaders += `${key}: ${value}\r\n`;
          }
          responseHeaders += "\r\n";
          appendLog(logFile, responseHeaders);

          proxyRes.on("data", (chunk) => {
            responseChunks.push(chunk);

            // if stream response, save the data
            const chunkLines = chunk.toString().split("\n");
            for (const line of chunkLines) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                appendLog(logResponseFile, line.slice(6).trim() + "\n");
              }
            }
          });

          proxyRes.on("end", () => {
            // save the response body
            responseBody = Buffer.concat(responseChunks);
            appendLog(logFile, responseBody);
          });

          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(clientRes);
        }
      );

      proxyReq.on("error", (err) => {
        error("Proxy request error:", err);
        appendLog(logFile, util.format(err));
        clientRes.writeHead(500);
        clientRes.end("Request error");
      });

      proxyReq.end(requestBody);
    } catch (err) {
      error("Process request error:", err);
      appendLog(logFile, util.format(err));
      clientRes.writeHead(500);
      clientRes.end("Internal error");
    }
  });
});

server.listen(port, () => {
  log(`Proxy server running on http://localhost:${port}`);
});

function log(...args) {
  console.log(getDateTimeString(), util.format(...args));
}

function error(...args) {
  console.error(getDateTimeString(), util.format(...args));
}

function getDateTimeString(format = "yyyy-mm-dd hh:ii:ss", time = new Date()) {
  const year = time.getFullYear();
  const month = String(time.getMonth() + 1).padStart(2, "0");
  const date = String(time.getDate()).padStart(2, "0");
  const hours = String(time.getHours()).padStart(2, "0");
  const minutes = String(time.getMinutes()).padStart(2, "0");
  const seconds = String(time.getSeconds()).padStart(2, "0");
  return format
    .replace(/yyyy/g, year)
    .replace(/mm/g, month)
    .replace(/dd/g, date)
    .replace(/hh/g, hours)
    .replace(/ii/g, minutes)
    .replace(/ss/g, seconds);
}
