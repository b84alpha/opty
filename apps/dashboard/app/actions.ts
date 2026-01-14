"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "../lib/prisma";
import crypto from "crypto";
import { ApiKeyStatus } from "@prisma/client";
import { modelCatalog, defaultFastModelId, defaultSmartModelId } from "@optyx/shared";

function hashKey(key: string) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function getDefaultOrgId() {
  const existing = await prisma.org.findFirst();
  if (existing) return existing.id;
  const org = await prisma.org.create({
    data: { name: "Default Org" },
  });
  return org.id;
}

export async function createProject(formData: FormData): Promise<void> {
  const name = (formData.get("name") as string | null)?.trim() || "New Project";
  const orgId = await getDefaultOrgId();
  const project = await prisma.project.create({
    data: {
      name,
      orgId,
    },
  });
  revalidatePath("/projects");
  revalidatePath("/logs");
  redirect(`/projects/${project.id}/keys`);
}

export async function createApiKey(projectId: string) {
  if (!projectId) throw new Error("projectId required");
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found");

  const random = crypto.randomBytes(32).toString("hex");
  const plainKey = `optyx_${random}`;
  const prefix = plainKey.slice(0, 10);
  const hashedKey = hashKey(plainKey);

  await prisma.apiKey.create({
    data: {
      projectId,
      hashedKey,
      prefix,
      status: ApiKeyStatus.ACTIVE,
    },
  });

  revalidatePath(`/projects/${projectId}/keys`);
  return { apiKey: plainKey, prefix };
}

export async function disableApiKey(keyId: string, projectId: string) {
  if (!keyId) throw new Error("apiKeyId required");
  await prisma.apiKey.update({
    where: { id: keyId },
    data: { status: ApiKeyStatus.DISABLED },
  });
  revalidatePath(`/projects/${projectId}/keys`);
  return { ok: true };
}

export async function updateProjectSettings(projectId: string, formData: FormData) {
  if (!projectId) throw new Error("projectId required");
  const defaultTierRaw = (formData.get("defaultTier") as string | null)?.toLowerCase() || "fast";
  const allowAll = formData.get("allowAllModels") === "on";
  const chosen = formData.getAll("allowedModels").map((v) => String(v));
  const allowedModels = allowAll ? modelCatalog.map((m) => m.id) : chosen;
  const defaultTier = defaultTierRaw === "smart" ? "smart" : "fast";
  await prisma.project.update({
    where: { id: projectId },
    data: {
      defaultTier,
      allowedModels,
      allowAllModels: allowAll,
    },
  });
  revalidatePath(`/projects/${projectId}/settings`);
  revalidatePath(`/projects/${projectId}/keys`);
  revalidatePath("/logs");
}
