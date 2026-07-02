import { WangzhuanError } from "./http.mjs";
import { errorEnvelope, okEnvelope } from "./http.mjs";

export function initWangzhuanSse(res, requestId) {
  res.socket?.setNoDelay?.(true);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Request-Id": requestId
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

function flushSse(res) {
  if (typeof res.flush === "function") {
    res.flush();
  }
}

export function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  flushSse(res);
}

export function writeSseLog(res, line) {
  writeSseEvent(res, "log", { line: String(line || "") });
}

export function writeSseDelta(res, text) {
  if (!text) return;
  writeSseEvent(res, "delta", { text: String(text) });
}

export function writeSseReset(res) {
  writeSseEvent(res, "reset", {});
}

export function writeSseDone(res, data, requestId) {
  writeSseEvent(res, "done", okEnvelope(data, requestId));
  res.end();
}

export function writeSseError(res, error, requestId) {
  const payload = error instanceof WangzhuanError
    ? errorEnvelope(error, requestId)
    : errorEnvelope(error?.code ? error : new WangzhuanError("internal_error", error?.message || "系统错误"), requestId);
  writeSseEvent(res, "error", payload);
  res.end();
}
