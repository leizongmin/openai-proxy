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

let requestCounter = 0;
const server = http.createServer((clientReq, clientRes) => {
  const url = new URL(clientReq.url, `http://${clientReq.headers.host}`);

  // handle root path, just return a plain text
  if (url.pathname === "/") {
    clientRes.writeHead(200, { "Content-Type": "text/plain" });
    clientRes.end("Server is running");
    return;
  }

  requestCounter++;
  const logFileName =
    String(requestCounter).padStart(6, "0") +
    "_" +
    getDateTimeString("yyyymmdd_hhmmss");
  const logFile = path.join(logDir, logFileName + ".log");
  const logRequestFile = path.join(logDir, logFileName + "_request.json");

  const options = {
    hostname: apiUrl.hostname,
    port: apiUrl.port || (apiUrlIsHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: clientReq.method,
    headers: clientReq.headers,
  };
  delete options.headers.host;
  log("Request %s %s", options.method, options.path);

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
      // if json request, modify the model name
      if (
        clientReq.headers["content-type"]?.includes("application/json") &&
        requestBody.length > 0
      ) {
        const data = JSON.parse(requestBody.toString());
        if (modelName && data.model) {
          data.model = modelName;
        }
        requestBody = Buffer.from(JSON.stringify(data));
        options.headers["content-length"] = requestBody.length;
      }

      // save the request body
      appendLog(logFile, requestBody);
      appendLog(logFile, "\n\n\n");
      if (requestBody.length > 0) {
        appendLog(
          logRequestFile,
          JSON.stringify(JSON.parse(requestBody.toString()), null, 2)
        );
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

function getDateTimeString(format = "yyyy-mm-dd hh:mm:ss", time = new Date()) {
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
    .replace(/mm/g, minutes)
    .replace(/ss/g, seconds);
}
