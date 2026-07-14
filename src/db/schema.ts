import { index, integer, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

// SPEC §5. All timestamps ISO-8601 TEXT (UTC); ids are nanoids. The whole §5
// model lands in one baseline migration even though watch/profile logic phases
// in later.

export const profileFact = sqliteTable('profile_fact', {
  id: text('id').primaryKey(),
  category: text('category', { enum: ['membership', 'coupon_source', 'spec'] }).notNull(),
  label: text('label').notNull(),
  value: text('value').notNull(),
  active: integer('active').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const watch = sqliteTable(
  'watch',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    targetJson: text('target_json').notNull(),
    cadenceMinutes: integer('cadence_minutes').notNull().default(1440),
    nextRunAt: text('next_run_at').notNull(),
    status: text('status', { enum: ['active', 'paused', 'removed'] }).notNull().default('active'),
    channelId: text('channel_id').notNull(),
    lastRunAt: text('last_run_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_watch_due').on(t.status, t.nextRunAt)],
);

export const hunt = sqliteTable(
  'hunt',
  {
    id: text('id').primaryKey(),
    mode: text('mode', { enum: ['oneshot', 'watch_run'] }).notNull(),
    query: text('query').notNull(),
    targetJson: text('target_json').notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    watchId: text('watch_id').references(() => watch.id),
    channelId: text('channel_id').notNull(),
    error: text('error'),
    costCents: integer('cost_cents'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_hunt_claimable').on(t.status, t.createdAt)],
);

export const listing = sqliteTable(
  'listing',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    priceCents: integer('price_cents'),
    shippingCents: integer('shipping_cents'),
    currency: text('currency').notNull().default('USD'),
    condition: text('condition'),
    sellerRating: real('seller_rating'),
    location: text('location'),
    imageUrl: text('image_url'),
    rawJson: text('raw_json').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [unique('listing_source_source_id').on(t.source, t.sourceId), index('idx_listing_source').on(t.source)],
);

export const huntResult = sqliteTable(
  'hunt_result',
  {
    huntId: text('hunt_id').notNull().references(() => hunt.id),
    listingId: text('listing_id').notNull().references(() => listing.id),
    rank: integer('rank').notNull(),
    landedCostCents: integer('landed_cost_cents'),
    verdict: text('verdict'),
  },
  (t) => [primaryKey({ columns: [t.huntId, t.listingId] })],
);

export const watchHit = sqliteTable(
  'watch_hit',
  {
    watchId: text('watch_id').notNull().references(() => watch.id),
    listingId: text('listing_id').notNull().references(() => listing.id),
    notifiedAt: text('notified_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.watchId, t.listingId] })],
);
