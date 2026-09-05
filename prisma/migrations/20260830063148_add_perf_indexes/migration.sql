-- CreateIndex
CREATE INDEX "hotspots_province_category_checkInsCount_idx" ON "hotspots"("province", "category", "checkInsCount");

-- CreateIndex
CREATE INDEX "posts_likesCount_createdAt_idx" ON "posts"("likesCount", "createdAt");
