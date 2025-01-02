# openai-proxy

A simple HTTP proxy server designed specifically for forwarding and logging OpenAI API requests.

## Features

- HTTP/HTTPS proxy forwarding support
- Automatic logging of all requests and responses
- Support for modifying model names in requests
- Detailed request logging

## Requirements

- Node.js
- Environment variables configuration (see below)

## Environment Variables

| Variable   | Description                                                                             | Default Value |
| ---------- | --------------------------------------------------------------------------------------- | ------------- |
| PORT       | Proxy server listening port                                                             | 8080          |
| LOG_DIR    | Log files directory                                                                     | ./logs        |
| MODEL_NAME | Model name to replace (optional)                                                        | -             |
| API_SERVER | Target API server address (format: https://domain.com, example: https://api.openai.com) | Required      |
| API_KEY    | OpenAI API key to override the original request (optional)                              | -             |

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

```bash
export API_SERVER="https://api.openai.com"
export PORT=8080
export LOG_DIR="./logs"
export MODEL_NAME="gpt-4"  # optional
```

3. Start the server:

```bash
npm start
```

## Logging

- All requests and responses are logged to the directory specified by LOG_DIR
- Log file naming format: `YYYY-MM-DD_HHMMSS_sequence.log`
- Each log file contains complete request headers, request body, response headers, and response body

## License

MIT License
