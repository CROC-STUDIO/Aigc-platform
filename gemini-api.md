# Gemini API

## Overview

This gateway exposes a Gemini-compatible API surface for Gemini CLI and SDK clients.

Supported route groups:

- `/v1beta`
- `/v1`

Supported operations:

- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`
- `POST /v1/models/{model}:generateContent`
- `POST /v1/models/{model}:streamGenerateContent`

The gateway validates the Skylink `project_api_key`, converts Gemini requests into the gateway's existing OpenAI-compatible chat completion request, and converts the upstream response back into Gemini format.

## Authentication

The gateway accepts the API key in the following order:

1. Query parameter `key`
2. Header `x-goog-api-key`
3. Header `Authorization: Bearer <project_api_key>`

Example:

```bash
curl -X POST 'https://skylink-gateway.com/api/v1beta/models/gemini-3.5-flash:generateContent?key=<project_api_key>'
```

## Model Path

The `{model}` path segment accepts:

- `gemini-3.5-flash`
- `models/gemini-3.5-flash`
- any path containing `/models/...`

The gateway normalizes:

- `models/gemini-3.5-flash` -> `gemini-3.5-flash`
- `gemini-3.1-pro-preview-customtools` -> `gemini-3.1-pro-preview`

## Endpoints

### 1. generateContent

```http
POST /v1beta/models/{model}:generateContent
POST /v1/models/{model}:generateContent
Content-Type: application/json
```

Returns a complete Gemini-style response body.

### 2. streamGenerateContent

```http
POST /v1beta/models/{model}:streamGenerateContent
POST /v1/models/{model}:streamGenerateContent
Content-Type: application/json
```

Returns `text/event-stream`.

Current behavior is single-shot SSE, not token-by-token incremental streaming.

## Request Body

### Basic Example

```json
{
  "systemInstruction": {
    "parts": [
      { "text": "你是一个中文助手。" }
    ]
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "请总结这段内容" }
      ]
    }
  ],
  "generationConfig": {
    "temperature": 0.2,
    "topP": 0.9,
    "maxOutputTokens": 1024
  }
}
```

## Supported Fields

### systemInstruction

Only `parts[].text` is consumed and mapped into an upstream `system` message.

### contents

Gemini `contents` are converted into upstream chat messages.

Role mapping:

- `model` -> `assistant`
- everything else -> `user`

Supported part types in this compatibility layer:

- `text`
- `functionCall`
- `functionResponse`

### generationConfig

Supported mappings:

- `temperature` -> `temperature`
- `topP` -> `top_p`
- `maxOutputTokens` -> `max_tokens`

## Function Calling

### Tool Declaration

```json
{
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "获取天气",
          "parameters": {
            "type": "object",
            "properties": {
              "city": { "type": "string" }
            },
            "required": ["city"]
          }
        }
      ]
    }
  ]
}
```

### toolConfig

Supported `functionCallingConfig.mode` values:

- `NONE` -> `tool_choice: "none"`
- `AUTO` -> `tool_choice: "auto"`
- `ANY`
  - if `allowedFunctionNames` exists, the gateway selects the first one
  - otherwise it maps to `tool_choice: "required"`

## Response Format

### Success Example

```json
{
  "candidates": [
    {
      "index": 0,
      "content": {
        "role": "model",
        "parts": [
          { "text": "这是回答内容" }
        ]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 50,
    "totalTokenCount": 150
  },
  "modelVersion": "gemini-3.5-flash"
}
```

### Function Call Example

```json
{
  "candidates": [
    {
      "index": 0,
      "content": {
        "role": "model",
        "parts": [
          {
            "functionCall": {
              "name": "get_weather",
              "args": {
                "city": "北京"
              }
            }
          },
          {
            "text": "我先帮你查询天气。"
          }
        ]
      },
      "finishReason": "STOP"
    }
  ]
}
```

## Error Format

All errors use a Gemini-style envelope:

```json
{
  "error": {
    "code": 400,
    "message": "错误信息",
    "status": "ERROR"
  }
}
```

Common cases:

- missing API key -> `401`
- request body is not a JSON object -> `400`
- model is empty -> `400`
- contents is empty -> `400`
- upstream gateway error -> propagated HTTP error code with normalized Gemini envelope

## curl Examples

### Text Generation

```bash
curl -X POST 'https://skylink-gateway.com/api/v1beta/models/gemini-3.5-flash:generateContent?key=<project_api_key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "systemInstruction": {
      "parts": [{"text": "你是一个中文助手。"}]
    },
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "请用三句话介绍这个产品。"}]
      }
    ],
    "generationConfig": {
      "temperature": 0.3,
      "topP": 0.9,
      "maxOutputTokens": 512
    }
  }'
```

### Function Calling

```bash
curl -X POST 'https://skylink-gateway.com/api/v1/models/gemini-3.5-flash:generateContent' \
  -H 'Content-Type: application/json' \
  -H 'x-goog-api-key: <project_api_key>' \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "帮我查北京天气"}]
      }
    ],
    "tools": [
      {
        "functionDeclarations": [
          {
            "name": "get_weather",
            "description": "获取天气",
            "parameters": {
              "type": "object",
              "properties": {
                "city": { "type": "string" }
              },
              "required": ["city"]
            }
          }
        ]
      }
    ],
    "toolConfig": {
      "functionCallingConfig": {
        "mode": "AUTO"
      }
    }
  }'
```

### Stream Generation

```bash
curl -N -X POST 'https://skylink-gateway.com/api/v1beta/models/gemini-3.5-flash:streamGenerateContent' \
  -H 'Authorization: Bearer <project_api_key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "写一段简短的接口接入说明"}]
      }
    ]
  }'
```

## Notes

- This compatibility layer reuses the gateway's `/llm/chat/completions` backend path.
- The current stream endpoint emits a complete response as one SSE event.
- The compatibility layer is best suited for Gemini CLI and SDK text and function-calling flows.
