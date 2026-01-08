'use client';

import { useEffect, useState } from "react";
import Link from "next/link";
import { defaultGatewayPort } from "@optyx/shared";

type HealthState = "idle" | "loading" | "ok" | "fail";

export default function HomePage() {
  const [health, setHealth] = useState<HealthState>("idle");
  const gatewayBase =
    process.env.NEXT_PUBLIC_GATEWAY_URL ||
    `http://localhost:${defaultGatewayPort}`;

  const checkHealth = async () => {
    setHealth("loading");
    try {
      const res = await fetch(`${gatewayBase}/health`);
      if (res.ok) {
        setHealth("ok");
        return;
      }
      setHealth("fail");
    } catch (err) {
      console.error(err);
      setHealth("fail");
    }
  };

  useEffect(() => {
    void checkHealth();
  }, []);

  return (
    <div className="page">
      <div className="card">
        <div className="pill">
          <span>Sprint 1</span>
        </div>
        <h1 className="headline">AI Gateway + Optimization Console</h1>
        <p className="muted">
          Manage projects, issue API keys, and watch live gateway traffic. Health
          checks ensure the gateway proxy is reachable before you run calls.
        </p>
        <div className="cta-row">
          <Link className="button" href="/projects">
            Manage Projects
          </Link>
          <Link className="button secondary" href="/logs">
            View Logs
          </Link>
          <button className="button ghost" onClick={checkHealth}>
            Check Gateway
          </button>
          <div
            className={`status ${
              health === "ok" ? "ok" : health === "fail" ? "fail" : ""
            }`}
          >
            {health === "ok" && "Gateway OK"}
            {health === "fail" && "Gateway Unreachable"}
            {health === "loading" && "Checking..."}
            {health === "idle" && "Not checked"}
          </div>
        </div>
        <p className="muted" style={{ marginTop: 20 }}>
          Target gateway URL: <strong>{gatewayBase}</strong>
        </p>
      </div>
    </div>
  );
}
