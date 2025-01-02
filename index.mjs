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

const logDir = path.resolve(process.env.LOG_DIR || "./logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
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

  requestCounter++;
  const logFile = path.join(
    logDir,
    `${getDateTimeString()}_${String(requestCounter).padStart(6, "0")}.log`
  );

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
  fs.writeFileSync(logFile, requestHeaders);

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
      fs.appendFileSync(logFile, requestBody);
      fs.appendFileSync(logFile, "\n\n\n");

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
          fs.appendFileSync(logFile, responseHeaders);

          proxyRes.on("data", (chunk) => {
            responseChunks.push(chunk);
          });

          proxyRes.on("end", () => {
            // save the response body
            responseBody = Buffer.concat(responseChunks);
            fs.appendFileSync(logFile, responseBody);
          });

          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(clientRes);
        }
      );

      proxyReq.on("error", (err) => {
        error("Proxy request error:", err);
        fs.appendFileSync(logFile, util.format(err));
        clientRes.writeHead(500);
        clientRes.end("Request error");
      });

      proxyReq.end(requestBody);
    } catch (err) {
      error("Process request error:", err);
      fs.appendFileSync(logFile, util.format(err));
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

function getDateTimeString(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const date = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${date}_${hours}${minutes}${seconds}`;
}
