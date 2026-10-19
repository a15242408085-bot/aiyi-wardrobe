import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const aiJobs = sqliteTable('ai_jobs', {
  id: text('id').primaryKey(),
  ownerHash: text('owner_hash').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  payloadHash: text('payload_hash').notNull(),
  resultKey: text('result_key'),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, t => [index('ai_jobs_owner_idx').on(t.ownerHash, t.createdAt), index('ai_jobs_kind_idx').on(t.kind, t.status)]);

export const accessAttempts = sqliteTable('access_attempts', {
  id: text('id').primaryKey(),
  attempts: integer('attempts').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
