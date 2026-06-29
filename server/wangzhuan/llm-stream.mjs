import { WangzhuanError } from "./http.mjs";
import { llmUsesGeminiNativeApi, llmUsesSkylinkGeminiChatBridge } from "./llm-config.mjs";

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function chatCompletionsUrl(endpoint) {
  const clean = String(endpoint || "").replace(/\/+$/, "");
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

function responsesUrl(endpoint) {
  const clean = String(endpoint || "").replace(/\/+$/, "");
  if (clean.endsWith("/responses")) return clean;
  if (clean.endsWith("/chat/completions")) return clean.replace(/\/chat\/completions$/, "/responses");
  return `${clean}/responses`;
}

function responsesInputFromMessages(messages = []) {
  return messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
        if (part?.type === "text") return { type: "input_text", text: part.text || "" };
        if (part?.type === "image_url") return { type: "input_image", image_url: part.image_url?.url || "" };
        if (part?.type === "file") {
          return {
            type: "input_file",
            filename: part.file?.filename || "reference-video.mp4",
            ...(part.file?.file_url ? { file_url: part.file.file_url } : { file_data: part.file?.file_data || "" })
          };
        }
        return part;
      })
      : [{ type: "input_text", text: String(message.content || "") }]
  }));
}

function canUseResponsesInput(messages = []) {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file"));
}

function modelInputMode(messages = []) {
  const hasFileUrlInput = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file" && part.file?.file_url));
  const hasFileDataInput = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === "file" && part.file?.file_data));
  return hasFileUrlInput ? "file_url" : hasFileDataInput ? "file_data" : "frames_only";
}

function shouldForceChatForFileUrl(llmConfig, messages) {
  return modelInputMode(messages) === "file_url"
    && String(llmConfig.provider || "").trim().toLowerCase() === "skylink"
    && /^gpt-5\.4(?:-(?:mini|nano))?$/i.test(String(llmConfig.model || "").trim());
}

function shouldFallbackFromResponsesStream(error) {
  if (!(error instanceof WangzhuanError)) return false;
  const status = Number(error.data?.status || 0);
  return [400, 404, 415, 422].includes(status) || status >= 500;
}

function nonStreamTextFromPayload(payload = {}) {
  const message = payload?.choices?.[0]?.message?.content;
  if (typeof message === "string" && message) return message;
  if (typeof payload?.output_text === "string" && payload.output_text) return payload.output_text;
  return "";
}

export function extractTextFromSkylinkSsePayload(payload = {}) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.error) return "";

  const chatDelta = payload?.choices?.[0]?.delta?.content;
  if (typeof chatDelta === "string" && chatDelta) return chatDelta;
  if (Array.isArray(chatDelta)) {
    return chatDelta
      .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
      .filter(Boolean)
      .join("");
  }

  if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") {
    return payload.delta;
  }
  if (payload?.type === "response.output_text.done") {
    return "";
  }

  const parts = payload?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("");
  }

  const messageContent = payload?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string" && messageContent) return messageContent;

  return "";
}

export function parseSseBlocks(buffer) {
  const events = [];
  let rest = buffer;
  let splitAt;
  while ((splitAt = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, splitAt);
    rest = rest.slice(splitAt + 2);
    if (!block.trim()) continue;
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    events.push({ event: eventName, data: dataLines.join("\n") });
  }
  return { events, rest };
}

export async function consumeSkylinkSseResponse(response, { onDelta, onRawEvent } = {}) {
  if (!response?.body) {
    throw new WangzhuanError("model_failed", "上游未返回可读取的流式响应", {
      status: response?.status || 0
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseBlocks(buffer);
    buffer = parsed.rest;

    for (const item of parsed.events) {
      if (item.data === "[DONE]") {
        return fullText;
      }
      let payload = {};
      try {
        payload = JSON.parse(item.data);
      } catch {
        continue;
      }
      onRawEvent?.(payload, item);
      if (payload?.error) {
        throw new WangzhuanError("model_failed", "模型拆解请求失败", {
          status: response.status,
          upstreamMessage: String(payload.error?.message || payload.message || "").slice(0, 300)
        });
      }
      const delta = extractTextFromSkylinkSsePayload(payload);
      if (delta) {
        fullText += delta;
        onDelta?.(delta, fullText);
      }
    }
  }

  return fullText;
}

async function consumeOpenAiCompatibleStream(url, body, llmConfig, handlers, { mode, controller, fetchOptions = {} }) {
  handlers.onRequest?.({ url, mode });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${llmConfig.apiKey}`
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
    ...fetchOptions
  });

  if (!response.ok) {
    const payload = response.headers.get("content-type")?.includes("json")
      ? await response.json().catch(() => ({}))
      : {};
    throw new WangzhuanError("model_failed", "模型拆解请求失败", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      status: response.status,
      inputMode: mode,
      upstreamMessage: String(payload?.error?.message || payload?.message || "").slice(0, 300)
    });
  }

  const contentType = String(response.headers.get("content-type") || "");
  if (!contentType.includes("text/event-stream")) {
    const payload = await response.json().catch(() => ({}));
    const message = nonStreamTextFromPayload(payload);
    if (typeof message === "string" && message) {
      handlers.onDelta?.(message, message);
      return message;
    }
    throw new WangzhuanError("model_failed", "上游未返回 SSE 流", {
      status: response.status,
      inputMode: mode
    });
  }

  return consumeSkylinkSseResponse(response, {
    onDelta: handlers.onDelta
  });
}

export async function callOpenAiCompatibleLlmStream(llmConfig, messages, handlers = {}, fetchOptions = {}) {
  if (!llmConfig.apiKey) {
    const apiKeyEnv = llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY";
    throw new WangzhuanError("model_failed", "未配置网赚拆解模型 API Key", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      apiKeyEnv
    });
  }

  const controller = new AbortController();
  const timeoutMs = numberOrZero(llmConfig.timeoutMs) || 180000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const chatPayload = {
    model: llmConfig.model,
    messages,
    temperature: llmConfig.temperature,
    response_format: { type: "json_object" },
    stream: true,
    stream_options: { include_usage: true }
  };
  const responsesPayload = {
    model: llmConfig.model,
    input: responsesInputFromMessages(messages),
    temperature: llmConfig.temperature,
    text: { format: { type: "json_object" } },
    stream: true
  };
  const useResponses = canUseResponsesInput(messages)
    && !shouldForceChatForFileUrl(llmConfig, messages)
    && !llmUsesSkylinkGeminiChatBridge(llmConfig);
  const chatUrl = chatCompletionsUrl(llmConfig.endpoint);

  try {
    if (useResponses) {
      try {
        return await consumeOpenAiCompatibleStream(
          responsesUrl(llmConfig.endpoint),
          responsesPayload,
          llmConfig,
          handlers,
          { mode: "responses.stream", controller, fetchOptions }
        );
      } catch (error) {
        if (!shouldFallbackFromResponsesStream(error)) throw error;
      }
    }
    return await consumeOpenAiCompatibleStream(
      chatUrl,
      chatPayload,
      llmConfig,
      handlers,
      { mode: "chat.completions.stream", controller, fetchOptions }
    );
  } catch (error) {
    if (error instanceof WangzhuanError) throw error;
    const reason = error?.name === "AbortError" ? "timeout" : "request_failed";
    throw new WangzhuanError("model_failed", reason === "timeout" ? "模型拆解请求超时" : "模型拆解请求失败", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      inputMode: useResponses ? "responses.stream" : "chat.completions.stream",
      reason
    });
  } finally {
    clearTimeout(timer);
  }
}

function geminiStreamGenerateContentUrl(endpoint, model) {
  const clean = String(endpoint || "").replace(/\/+$/, "");
  const encoded = encodeURIComponent(String(model || "").trim());
  if (clean.endsWith("/v1beta")) return `${clean}/models/${encoded}:streamGenerateContent?alt=sse`;
  if (clean.endsWith("/api")) return `${clean}/v1beta/models/${encoded}:streamGenerateContent?alt=sse`;
  if (clean.endsWith("/v1")) return `${clean}beta/models/${encoded}:streamGenerateContent?alt=sse`;
  return `${clean}/v1beta/models/${encoded}:streamGenerateContent?alt=sse`;
}

export async function callGeminiCompatibleLlmStream(llmConfig, messages, handlers = {}, bodyFactory) {
  if (!llmConfig.apiKey) {
    const apiKeyEnv = llmConfig.apiKeyEnv || "WANGZHUAN_LLM_API_KEY";
    throw new WangzhuanError("model_failed", "未配置网赚拆解模型 API Key", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      apiKeyEnv
    });
  }

  const controller = new AbortController();
  const timeoutMs = numberOrZero(llmConfig.timeoutMs) || 180000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = typeof bodyFactory === "function" ? bodyFactory(messages) : bodyFactory;
  const url = geminiStreamGenerateContentUrl(llmConfig.endpoint, llmConfig.model);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": llmConfig.apiKey
  };

  try {
    handlers.onRequest?.({ url, mode: "gemini.streamGenerateContent" });
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new WangzhuanError("model_failed", "模型拆解请求失败", {
        provider: llmConfig.provider,
        model: llmConfig.model,
        status: response.status,
        inputMode: "gemini_contents.stream",
        upstreamMessage: String(payload?.error?.message || payload?.message || "").slice(0, 300)
      });
    }

    return await consumeSkylinkSseResponse(response, {
      onDelta: handlers.onDelta
    });
  } catch (error) {
    if (error instanceof WangzhuanError) throw error;
    const reason = error?.name === "AbortError" ? "timeout" : "request_failed";
    throw new WangzhuanError("model_failed", reason === "timeout" ? "模型拆解请求超时" : "模型拆解请求失败", {
      provider: llmConfig.provider,
      model: llmConfig.model,
      inputMode: "gemini_contents.stream",
      reason
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function callLlmStreaming(llmConfig, messages, handlers, geminiBodyFactory) {
  if (llmUsesGeminiNativeApi(llmConfig)) {
    return callGeminiCompatibleLlmStream(llmConfig, messages, handlers, geminiBodyFactory);
  }
  return callOpenAiCompatibleLlmStream(llmConfig, messages, handlers);
}
