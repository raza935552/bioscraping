-- Images made by Biolinx: posts can be sent with image words and a brief instead of a link,
-- and a reviewer can ask Biolinx for a new image with a note ("Redo image").
ALTER TABLE swipe_posts ADD COLUMN image_feedback TEXT NULL;
ALTER TABLE swipe_posts ADD COLUMN image_requests INT NOT NULL DEFAULT 0;
