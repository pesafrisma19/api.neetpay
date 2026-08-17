-- AlterTable
ALTER TABLE "public"."provider_events" ALTER COLUMN "providerRefId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_providerId_providerRefId_key" ON "public"."provider_events"("providerId", "providerRefId");
