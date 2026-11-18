-- AlterTable
ALTER TABLE "users"
ADD COLUMN     "availableForCollab" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "availableUntil" TIMESTAMP(3),
ADD COLUMN     "showProfileViews" BOOLEAN NOT NULL DEFAULT true;
