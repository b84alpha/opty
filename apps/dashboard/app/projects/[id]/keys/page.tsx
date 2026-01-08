export const dynamic = "force-dynamic";
export const revalidate = 0;

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "../../../lib/prisma";
import { ApiKeyStatus } from "@prisma/client";
import KeysClient, { SerializableApiKey } from "./keys-client";

type Params = { params: { id: string } };

export default async function ProjectKeysPage({ params }: Params) {
  const project = await prisma.project.findUnique({
    where: { id: params.id },
    include: { apiKeys: true },
  });

  if (!project) return notFound();

  const serializableKeys: SerializableApiKey[] = project.apiKeys.map((key) => ({
    id: key.id,
    prefix: key.prefix,
    status: key.status,
    createdAt: key.createdAt.toISOString(),
    updatedAt: key.updatedAt.toISOString(),
    lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
  }));

  const activeCount = project.apiKeys.filter(
    (k) => k.status === ApiKeyStatus.ACTIVE
  ).length;

  return (
    <div className="page">
      <div className="card">
        <div className="section-header" style={{ marginBottom: 10 }}>
          <div>
            <div className="pill small">Project</div>
            <h2 className="headline" style={{ marginTop: 8, marginBottom: 4 }}>
              {project.name}
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              Issue and disable API keys. Keep the generated key safe; it is
              only shown once.
            </p>
          </div>
          <Link className="button ghost" href="/projects">
            ← Back to projects
          </Link>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="muted-small">Active keys</div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>{activeCount}</div>
          </div>
          <div className="stat">
            <div className="muted-small">Project ID</div>
            <div className="monospace">{project.id}</div>
          </div>
        </div>

        <KeysClient projectId={project.id} initialKeys={serializableKeys} />
      </div>
    </div>
  );
}
