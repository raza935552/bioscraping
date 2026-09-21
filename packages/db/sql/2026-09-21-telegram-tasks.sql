-- The Telegram assistant: what people asked, and the tasks their requests became.
-- Questions are answered from live data; anything that asks for a change is logged here so nothing
-- said in a chat is lost, and Raza sees it on the Requests page.
CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(16) NOT NULL DEFAULT 'telegram',
  chat_id VARCHAR(32),
  chat_title VARCHAR(160),
  asked_by VARCHAR(120),
  asked_by_username VARCHAR(120),
  kind VARCHAR(16) NOT NULL DEFAULT 'change',      -- change | bug | idea | question
  title VARCHAR(200) NOT NULL,
  detail TEXT,
  /** What the assistant replied, including any pushback it gave. */
  reply TEXT,
  /** Set when the assistant judged the request risky or already solved, so it argued back. */
  pushed_back BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(16) NOT NULL DEFAULT 'open',      -- open | doing | done | declined
  closed_by_user_id INT,
  closed_at DATETIME,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX tasks_status (status),
  INDEX tasks_created (created_at)
);

-- Every exchange, for auditing what the bot told people and for the daily spend cap.
CREATE TABLE IF NOT EXISTS telegram_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  chat_id VARCHAR(32) NOT NULL,
  chat_title VARCHAR(160),
  asked_by VARCHAR(120),
  update_id BIGINT,
  question TEXT,
  answer TEXT,
  kind VARCHAR(16),
  task_id INT,
  used_ai BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY telegram_update (update_id),
  INDEX telegram_chat (chat_id),
  INDEX telegram_created (created_at)
);
