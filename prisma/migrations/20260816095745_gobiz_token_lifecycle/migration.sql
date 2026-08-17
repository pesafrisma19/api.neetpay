-- CreateEnum
CREATE TYPE "GoBizAuthType" AS ENUM ('OTP', 'PASSWORD');

-- CreateEnum
CREATE TYPE "GoBizTokenType" AS ENUM ('ACCESS', 'REFRESH');

-- AlterTable
ALTER TABLE "gobiz_accounts" ADD COLUMN     "authType" "GoBizAuthType" NOT NULL DEFAULT 'OTP',
ADD COLUMN     "encryptedPassword" TEXT;

-- CreateTable
CREATE TABLE "gobiz_token_lifecycles" (
    "id" TEXT NOT NULL,
    "goBizAccountId" TEXT NOT NULL,
    "tokenType" "GoBizTokenType" NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "replacedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gobiz_token_lifecycles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gobiz_token_lifecycles_goBizAccountId_idx" ON "gobiz_token_lifecycles"("goBizAccountId");

-- CreateIndex
CREATE INDEX "gobiz_token_lifecycles_tokenType_idx" ON "gobiz_token_lifecycles"("tokenType");

-- CreateIndex
CREATE INDEX "gobiz_token_lifecycles_tokenFingerprint_idx" ON "gobiz_token_lifecycles"("tokenFingerprint");

-- AddForeignKey
ALTER TABLE "gobiz_token_lifecycles" ADD CONSTRAINT "gobiz_token_lifecycles_goBizAccountId_fkey" FOREIGN KEY ("goBizAccountId") REFERENCES "gobiz_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
