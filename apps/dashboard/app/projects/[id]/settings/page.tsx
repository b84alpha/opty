import Link from "next/link";
import { prisma } from "../../../lib/prisma";
import { modelCatalog } from "@optyx/shared";
import { updateProjectSettings } from "../../../actions";

type Params = { params: { id: string } };

export default async function ProjectSettingsPage({ params }: Params) {
  const project = await prisma.project.findUnique({
    where: { id: params.id },
  });
  if (!project) {
    return <div className="page"><div className="card">Project not found</div></div>;
  }

  const allowed = Array.isArray(project.allowedModels)
    ? (project.allowedModels as any[]).map((m) => String(m))
    : [];

  return (
    <div className="page">
      <div className="card">
        <div className="section-header" style={{ marginBottom: 10 }}>
          <div>
            <div className="pill small">Project Settings</div>
            <h2 className="headline" style={{ marginTop: 8, marginBottom: 4 }}>
              {project.name}
            </h2>
            <p className="muted" style={{ margin: 0 }}>
              Configure default tier and which models are allowed for this project.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Link className="button ghost" href={`/projects/${project.id}/keys`}>API Keys</Link>
            <Link className="button ghost" href="/projects">Projects</Link>
          </div>
        </div>

        <form action={async (formData) => updateProjectSettings(project.id, formData)}>
          <div className="section">
            <h4 style={{ marginBottom: 8 }}>Default Tier</h4>
            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="defaultTier" value="fast" defaultChecked={project.defaultTier === "fast"} />
                FAST (default to gpt-5-nano)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="defaultTier" value="smart" defaultChecked={project.defaultTier === "smart"} />
                SMART (default to gpt-5-mini)
              </label>
            </div>
          </div>

          <div className="section">
            <h4 style={{ marginBottom: 8 }}>Allowed Models</h4>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
              <input type="checkbox" name="allowAllModels" defaultChecked={project.allowAllModels} />
              Allow all catalog models
            </label>
            <div className="card-grid">
              {modelCatalog.map((model) => (
                <label key={model.id} className="stat" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    name="allowedModels"
                    value={model.id}
                    defaultChecked={project.allowAllModels || allowed.includes(model.id)}
                  />
                  <div>
                    <div style={{ fontWeight: 700 }}>{model.id}</div>
                    <div className="muted-small">
                      {model.provider} · {model.type} {model.tierDefaultAllowed ? `· ${model.tierDefaultAllowed.join("/")}` : ""}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <button className="button" type="submit">Save settings</button>
        </form>
      </div>
    </div>
  );
}
