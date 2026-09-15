-- Top posts found by the swipe file's own search (swipe-search job). Inspiration only:
-- a post is used once, tracked through swipe_posts.source_post_url.
CREATE TABLE IF NOT EXISTS swipe_sources (
  id INT AUTO_INCREMENT PRIMARY KEY,
  url VARCHAR(500) NOT NULL,
  platform VARCHAR(16) NOT NULL,
  niche VARCHAR(40) NULL,
  term VARCHAR(120) NOT NULL,
  author_handle VARCHAR(120) NULL,
  followers INT NULL,
  views INT NOT NULL,
  likes INT NULL,
  comments INT NULL,
  text TEXT NOT NULL,
  posted_at DATETIME NULL,
  country VARCHAR(8) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY swipe_source_url (url(191))
);
