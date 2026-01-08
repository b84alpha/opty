"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ApiKeyStatus } from "@prisma/client";
import { createApiKey, disableApiKey } from "../../../actions";

export type SerializableApiKey = {
  id: string;
  prefix: string;
  status: ApiKeyStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

type Props = {
  projectId: string;
  initialKeys: SerializableApiKey[];
};

export default function KeysClient({ projectId, initialKeys }: Props) {
  const router = useRouter();
  const [latestKey, setLatestKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [keys, setKeys] = useState(initialKeys);

  useEffect(() => {
    setKeys(initialKeys);
  }, [initialKeys]);

  const handleCreate = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await createApiKey(projectId);
        if (result?.apiKey) {
          setLatestKey(result.apiKey);
          setCopied(false);
        }
        router.refresh();
      } catch (err: any) {
        setError(err?.message || "Failed to create key");
      }
    });
  };

  const handleDisable = (id: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await disableApiKey(id, projectId);
        router.refresh();
      } catch (err: any) {
        setError(err?.message || "Failed to disable key");
      }
    });
  };

  const copyKey = async () => {
    if (!latestKey) return;
    await navigator.clipboard.writeText(latestKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const formatDate = (value: string | null) => {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  };

  return (
    <div className="section" style={{ marginTop: 24 }}>
      <div className="section-header">
        <h3 style={{ margin: 0 }}>API keys</h3>
        <button className="button" onClick={handleCreate} disabled={isPending}>
          {isPending ? "Working..." : "Generate key"}
        </button>
      </div>
      <p className="muted-small" style={{ marginTop: 6 }}>
        Keys are returned once. Copy them immediately and treat them like secrets.
      </p>
      {error && (
        <p style={{ color: "#b91c1c", marginTop: 8, marginBottom: 8 }}>
          {error}
        </p>
      )}

      {latestKey && (
        <div className="copy-box" style={{ marginTop: 12 }}>
          <div>
            <div className="muted-small">New key (copy now):</div>
            <div className="monospace">{latestKey}</div>
          </div>
          <button className="button secondary" onClick={copyKey}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Prefix</th>
            <th>Status</th>
            <th>Created</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id}>
              <td className="monospace">{key.prefix}...</td>
              <td>
                <span
                  className={`badge ${
                    key.status === ApiKeyStatus.ACTIVE ? "success" : "warn"
                  }`}
                >
                  {key.status}
                </span>
              </td>
              <td>{formatDate(key.createdAt)}</td>
              <td>{formatDate(key.lastUsedAt)}</td>
              <td style={{ textAlign: "right" }}>
                <button
                  className="button ghost"
                  disabled={key.status === ApiKeyStatus.DISABLED || isPending}
                  onClick={() => handleDisable(key.id)}
                >
                  Disable
                </button>
              </td>
            </tr>
          ))}
          {keys.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No keys yet. Generate one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
