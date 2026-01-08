import { PrismaClient, MembershipRole, ApiKeyStatus, LedgerEntryType } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();

function hashKey(key: string) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function main() {
  const org = await prisma.org.upsert({
    where: { id: "seed-org-1" },
    update: {},
    create: {
      id: "seed-org-1",
      name: "Optyx Demo Org"
    }
  });

  const user = await prisma.user.upsert({
    where: { email: "founder@optyx.local" },
    update: {},
    create: {
      id: "seed-user-1",
      email: "founder@optyx.local",
      name: "Demo User"
    }
  });

  await prisma.membership.upsert({
    where: { id: "seed-membership-1" },
    update: {},
    create: {
      id: "seed-membership-1",
      orgId: org.id,
      userId: user.id,
      role: MembershipRole.OWNER
    }
  });

  const project = await prisma.project.upsert({
    where: { id: "seed-project-1" },
    update: {},
    create: {
      id: "seed-project-1",
      name: "Demo Project",
      orgId: org.id
    }
  });

  // Base providers to start configuring routes later.
  const providers = [
    { provider: "openai", displayName: "OpenAI" },
    { provider: "anthropic", displayName: "Anthropic" },
    { provider: "google", displayName: "Google" },
    { provider: "deepseek", displayName: "DeepSeek" }
  ];

  for (const base of providers) {
    await prisma.provider.upsert({
      where: { provider: base.provider },
      update: { displayName: base.displayName },
      create: base
    });
  }

  const priceRows = [
    {
      id: "seed-price-nano",
      provider: "openai",
      model: "gpt-5-nano",
      inputPerMtok: 0.05,
      outputPerMtok: 0.40,
      cacheHitPerMtok: null,
      effectiveFrom: new Date(),
      source: "seed",
      version: 1,
      isActive: true
    },
    {
      id: "seed-price-mini",
      provider: "openai",
      model: "gpt-5-mini",
      inputPerMtok: 0.25,
      outputPerMtok: 2.0,
      cacheHitPerMtok: null,
      effectiveFrom: new Date(),
      source: "seed",
      version: 1,
      isActive: true
    },
    {
      id: "seed-price-google-flash-lite",
      provider: "google",
      model: "gemini-2.0-flash-lite",
      inputPerMtok: 0.07,
      outputPerMtok: 0.30,
      cacheHitPerMtok: null,
      effectiveFrom: new Date(),
      source: "seed",
      version: 1,
      isActive: true
    },
    {
      id: "seed-price-google-embed-1",
      provider: "google",
      model: "gemini-embedding-001",
      inputPerMtok: 0.15,
      outputPerMtok: 0,
      cacheHitPerMtok: null,
      effectiveFrom: new Date(),
      source: "seed",
      version: 1,
      isActive: true
    }
  ];

  for (const row of priceRows) {
    const { id, ...data } = row;
    await prisma.providerModelPrice.upsert({
      where: { id },
      update: data,
      create: { id, ...data }
    });
  }

  const seedPlainKey = "optyx_seed_demo_key_change_me";

  await prisma.apiKey.upsert({
    where: { id: "seed-apikey-1" },
    update: {},
    create: {
      id: "seed-apikey-1",
      projectId: project.id,
      hashedKey: hashKey(seedPlainKey),
      prefix: seedPlainKey.slice(0, 10),
      status: ApiKeyStatus.ACTIVE
    }
  });

  await prisma.route.upsert({
    where: { id: "seed-route-1" },
    update: {},
    create: {
      id: "seed-route-1",
      projectId: project.id,
      name: "FAST",
      tag: "fast"
    }
  });

  await prisma.policy.upsert({
    where: { id: "seed-policy-1" },
    update: {},
    create: {
      id: "seed-policy-1",
      projectId: project.id,
      name: "Default Policy",
      definition: { allow: true }
    }
  });

  await prisma.ledgerEntry.upsert({
    where: { id: "seed-ledger-1" },
    update: {},
    create: {
      id: "seed-ledger-1",
      projectId: project.id,
      type: LedgerEntryType.DEPOSIT,
      amount: 100,
      currency: "USDC",
      reference: "seed-funding",
      metadataJson: { note: "seed deposit" }
    }
  });

  console.log("Seed data created", { org: org.id, user: user.id, project: project.id });
  console.log("Seed API key (plaintext)", seedPlainKey);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
