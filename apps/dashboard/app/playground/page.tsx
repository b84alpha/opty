'use client';

import { useState } from "react";
import { chatCompletion, chatCompletionStream } from "../../src/lib/gatewayClient";

export default function PlaygroundPage() {
  const [input, setInput] = useState("Output exactly:\nA\nB");
  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("optyx_api_key") || "";
  });
  const [controller, setController] = useState<AbortController | null>(null);
  const hasKey = Boolean(apiKey);

  const run = async () => {
    setLoading(true);
    setOutput("");
    setError(null);
    const aborter = new AbortController();
    setController(aborter);
    try {
      if (!stream) {
        const text = await chatCompletion({
          messages: [{ role: "user", content: input }],
          apiKey,
        });
        setOutput(text);
      } else {
        for await (const chunk of chatCompletionStream({
          messages: [{ role: "user", content: input }],
          apiKey,
          signal: aborter.signal,
        })) {
          setOutput((prev) => prev + chunk);
        }
      }
    } catch (err: any) {
      setError(err?.message || "Error");
      if (err?.payload) {
        setOutput(JSON.stringify(err.payload, null, 2));
      }
    } finally {
      setLoading(false);
      setController(null);
    }
  };

  const stop = () => {
    if (controller) {
      controller.abort();
      setController(null);
      setLoading(false);
    }
  };

  const saveKey = () => {
    localStorage.setItem("optyx_api_key", apiKey);
  };

  const clearKey = () => {
    localStorage.removeItem("optyx_api_key");
    setApiKey("");
  };

  return (
    <div className="page" style={{ gap: 16 }}>
      <h1>Playground</h1>
      <div className="card" style={{ width: "100%", maxWidth: 800 }}>
        <label className="muted">API Key</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="button secondary" onClick={saveKey} disabled={!apiKey}>
            Save
          </button>
          <button className="button ghost" onClick={clearKey}>
            Clear
          </button>
          <span className="muted" style={{ minWidth: 80 }}>
            {hasKey ? "Key saved" : "No key"}
          </span>
        </div>
        <label className="muted">Prompt</label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={6}
          style={{ width: "100%" }}
        />
        <label style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={stream}
            onChange={(e) => setStream(e.target.checked)}
          />{" "}
          Stream
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button" onClick={run} disabled={loading}>
            {loading ? (stream ? "Streaming..." : "Sending...") : "Send"}
          </button>
          <button className="button ghost" onClick={stop} disabled={!controller}>
            Stop
          </button>
        </div>
        {error && <div className="muted" style={{ color: "#d33" }}>{error}</div>}
        <label className="muted" style={{ marginTop: 12 }}>
          Output
        </label>
        <textarea value={output} readOnly rows={8} style={{ width: "100%" }} />
      </div>
    </div>
  );
}
