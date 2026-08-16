-- AlterTable
ALTER TABLE "payment_accounts" ADD COLUMN     "customMaxAmount" DECIMAL(18,2),
ADD COLUMN     "customMinAmount" DECIMAL(18,2);
