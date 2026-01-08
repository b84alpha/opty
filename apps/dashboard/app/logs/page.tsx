import { prisma } from "../lib/prisma";
import ProjectPicker from "./project-picker";

type LogsPageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};

type SerializableLog = {
  id: string;
  status: string | null;
  httpStatus: number | null;
  provider: string | null;
  model: string | null;
  tier: string | null;
  routeTag: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsdc: number | null;
  createdAt: string;
  latencyMs: number | null;
  apiKeyPrefix: string | null;
};

export default async function LogsPage({ searchParams }: LogsPageProps) {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  const projectId =
    (searchParams?.projectId as string | undefined) || projects[0]?.id;

  const logs: SerializableLog[] = projectId
    ? (
        await prisma.requestsLog.findMany({
          where: { projectId },
          orderBy: { createdAt: "desc" },
          include: { apiKey: true },
          take: 100,
        })
      ).map((log) => ({
        id: log.id,
        status: log.status,
        httpStatus: log.httpStatus ?? null,
        provider: log.provider,
        model: log.model,
        tier: log.tier,
        routeTag: log.routeTag,
        tokensIn: log.tokensIn,
        tokensOut: log.tokensOut,
        estimatedCostUsdc: log.estimatedCostUsdc
          ? Number(log.estimatedCostUsdc)
          : null,
        createdAt: log.createdAt.toISOString(),
        latencyMs: log.latencyMs ?? null,
        apiKeyPrefix: log.apiKey?.prefix ?? null,
      }))
    : [];

  const formatCost = (value: number | null) =>
    value == null ? "—" : `$${value.toFixed(6)}`;

  return (
    <div className="page">
      <div className="card">
        <div className="section-header" style={{ marginBottom: 10 }}>
          <div>
            <div className="pill small">Logs</div>
            <h2 className="headline" style={{ marginTop: 8, marginBottom: 4 }}>
              Last 100 requests
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              Filter by project to see request outcomes, tokens, and costs.
            </p>
          </div>
          {projects.length > 0 && (
            <ProjectPicker projects={projects} selectedId={projectId} />
          )}
        </div>

        {projectId ? (
          <table className="table" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Status</th>
                <th>Provider / Model</th>
                <th>Tier</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Latency</th>
                <th>API key</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{new Date(log.createdAt).toLocaleString()}</td>
                  <td>
                    <span
                      className={`badge ${
                        log.status === "success"
                          ? "success"
                          : log.status === "in_progress"
                          ? "warn"
                          : "error"
                      }`}
                    >
                      {log.status ?? "unknown"}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 700 }}>
                      {log.provider ?? "openai"}
                    </div>
                    <div className="muted-small">{log.model ?? "—"}</div>
                  </td>
                  <td>
                    <span className="chip">{log.tier ?? "FAST"}</span>
                    {log.routeTag && (
                      <div className="muted-small">tag: {log.routeTag}</div>
                    )}
                  </td>
                  <td>
                    <div className="muted-small">
                      in: {log.tokensIn ?? "—"}, out: {log.tokensOut ?? "—"}
                    </div>
                  </td>
                  <td>{formatCost(log.estimatedCostUsdc)}</td>
                  <td>{log.latencyMs != null ? `${log.latencyMs} ms` : "—"}</td>
                  <td>{log.apiKeyPrefix ? `${log.apiKeyPrefix}...` : "—"}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No logs yet for this project.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <p className="muted">Create a project to view logs.</p>
        )}
      </div>
    </div>
  );
}
