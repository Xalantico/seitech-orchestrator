-- Message dispatcher support: retry scheduling, claim leases, per-channel attempt limits (ORF-048..050, RNF burst of 1000 messages).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE messages ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS html BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'es';

CREATE INDEX IF NOT EXISTS messages_due_idx ON messages (priority DESC, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS messages_sending_idx ON messages (locked_until) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS messages_sent_channel_idx ON messages (channel_id, sent_at) WHERE sent_at IS NOT NULL;

-- Only one published version per template at a time; publishing a new one retires the previous (done by the API in one transaction).
CREATE UNIQUE INDEX IF NOT EXISTS template_versions_one_published_idx ON template_versions (template_id) WHERE state = 'published';
