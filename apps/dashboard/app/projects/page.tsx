export const dynamic = "force-dynamic";
export const revalidate = 0;

import Link from "next/link";
import { prisma } from "../lib/prisma";
import { createProject } from "../actions";
import { ApiKeyStatus } from "@prisma/client";

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "desc" },
    include: { apiKeys: true },
  });

  return (
    <div className="page">
      <div className="card">
        <div className="section-header">
          <div>
            <div className="pill small">Projects</div>
            <h2 className="headline" style={{ marginTop: 8, marginBottom: 4 }}>
              Manage projects and API keys
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              Create projects, then issue API keys to call the gateway.
            </p>
          </div>
        </div>

        <div className="section" style={{ marginTop: 16 }}>
          <form action={createProject} className="form-inline">
            <input
              className="input"
              name="name"
              placeholder="Project name"
              required
            />
            <button type="submit" className="button">
              Create project
            </button>
          </form>
        </div>

        <div className="section">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Keys</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const activeKeys = project.apiKeys.filter(
                  (k) => k.status === ApiKeyStatus.ACTIVE
                );
                return (
                  <tr key={project.id}>
                    <td>
                      <div style={{ fontWeight: 700 }}>{project.name}</div>
                      <div className="muted-small">{project.id}</div>
                    </td>
                    <td>
                      <span className="badge success">
                        {activeKeys.length} active
                      </span>
                    </td>
                    <td>
                      {project.createdAt.toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        className="button secondary"
                        href={`/projects/${project.id}/keys`}
                      >
                        API Keys
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {projects.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No projects yet. Create one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
