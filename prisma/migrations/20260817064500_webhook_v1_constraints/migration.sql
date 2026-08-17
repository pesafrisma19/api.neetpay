-- CreateIndex
CREATE UNIQUE INDEX "webhook_configs_userId_key" ON "webhook_configs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_transactionId_event_key" ON "webhook_deliveries"("transactionId", "event");
