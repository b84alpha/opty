'use client';

import { useState } from "react";
import { chatCompletion, chatCompletionStream } from "../../src/lib/gatewayClient";

export default function PlaygroundPage() {
  const [input, setInput] = useState("Output exactly:\nA\nB");
  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setOutput("");
    setError(null);
    try {
      if (!stream) {
        const text = await chatCompletion({
          messages: [{ role: "user", content: input }],
        });
        setOutput(text);
      } else {
        for await (const chunk of chatCompletionStream({
          messages: [{ role: "user", content: input }],
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
    }
  };

  return (
    <div className="page" style={{ gap: 16 }}>
      <h1>Playground</h1>
      <div className="card" style={{ width: "100%", maxWidth: 800 }}>
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
        <button className="button" onClick={run} disabled={loading}>
          {loading ? "Sending..." : "Send"}
        </button>
        {error && <div className="muted" style={{ color: "#d33" }}>{error}</div>}
        <label className="muted" style={{ marginTop: 12 }}>
          Output
        </label>
        <textarea value={output} readOnly rows={8} style={{ width: "100%" }} />
      </div>
    </div>
  );
}
