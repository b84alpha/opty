import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { gatewayPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.gatewayPrisma ||
  new PrismaClient({
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.gatewayPrisma = prisma;
}
