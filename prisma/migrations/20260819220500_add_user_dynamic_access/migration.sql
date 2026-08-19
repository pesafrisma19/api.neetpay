-- AlterTable
ALTER TABLE "users" ADD COLUMN "hasDynamicAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "dynamicActivatedAt" TIMESTAMP(3);
