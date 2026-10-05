import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { isOurs, recordSubscription, revokeForSubscription } from '../subscriptions';
import { fakeSupabase } from './fake-supabase';

const prices = { month: 'price_m', year: 'price_y' };

const subscription = (over: Partial<Stripe.Subscription> & { price?: string } = {}): Stripe.Subscription =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    current_period_end: 1_800_000_000,
    cancel_at_period_end: false,
    metadata: { product: 'vc-dit' },
    items: { data: [{ price: { id: over.price ?? 'price_y' } }] },
    ...over,
  }) as unknown as Stripe.Subscription;

let serials = 0;
const deps = (client: ReturnType<typeof fakeSupabase>['client'], email: string | null = 'Ken@Example.com') => ({
  client,
  prices,
  customerEmail: async () => email,
  newSerial: () => `VCDIT-TEST${++serials}`,
});

describe('recording a subscription', () => {
  it('issues one license per subscription, however often Stripe redelivers', async () => {
    const db = fakeSupabase({ profiles: [{ id: 'u1', email: 'ken@example.com' }] });
    const first = await recordSubscription(subscription(), deps(db.client));
    const again = await recordSubscription(subscription(), deps(db.client));
    expect(first).toMatchObject({ userId: 'u1', plan: 'dit', interval: 'year', status: 'active', created: true });
    expect(again).toMatchObject({ serial: first?.serial, created: false });
    expect(db.tables['dit_subscriptions']).toHaveLength(1);
    expect(db.tables['dit_licenses']).toHaveLength(1);
    expect(db.tables['dit_licenses']?.[0]).toMatchObject({ user_id: 'u1', plan: 'dit', paid_through: new Date(1_800_000_000_000).toISOString() });
  });

  it("uses the VC Writer customer's own account: one account across products", async () => {
    const db = fakeSupabase({ profiles: [{ id: 'writer-customer', email: 'ken@example.com' }] });
    const record = await recordSubscription(subscription({ metadata: { product: 'vc-dit' } }), deps(db.client));
    expect(record?.userId).toBe('writer-customer');
    expect(db.authUsers).toHaveLength(0);
  });

  it('prefers the signed-in account named at checkout', async () => {
    const db = fakeSupabase();
    const record = await recordSubscription(subscription({ metadata: { product: 'vc-dit', supabase_user_id: 'u9' } }), deps(db.client));
    expect(record?.userId).toBe('u9');
  });

  it('creates an account for a buyer who has none, so nothing paid is stranded', async () => {
    const db = fakeSupabase();
    const record = await recordSubscription(subscription(), deps(db.client, 'new@example.com'));
    expect(db.authUsers.map((user) => user.email)).toEqual(['new@example.com']);
    expect(record?.userId).toBe(db.authUsers[0]?.id);
  });

  it('follows a switch to monthly, a cancellation and the end', async () => {
    const db = fakeSupabase({ profiles: [{ id: 'u1', email: 'ken@example.com' }] });
    await recordSubscription(subscription(), deps(db.client));
    expect(db.tables['dit_licenses']?.[0]).toMatchObject({ plan: 'dit', status: 'active' });

    await recordSubscription(subscription({ price: 'price_m' }), deps(db.client));
    expect(db.tables['dit_subscriptions']?.[0]).toMatchObject({ billing_interval: 'month' });

    await recordSubscription(subscription({ price: 'price_m', cancel_at_period_end: true }), deps(db.client));
    expect(db.tables['dit_subscriptions']?.[0]).toMatchObject({ cancel_at_period_end: true });
    expect(db.tables['dit_licenses']?.[0]).toMatchObject({ status: 'active' });

    await recordSubscription(subscription({ price: 'price_m', status: 'canceled' }), deps(db.client));
    expect(db.tables['dit_licenses']?.[0]).toMatchObject({ status: 'expired' });
    expect(db.tables['dit_licenses']).toHaveLength(1);
  });

  it('keeps a refunded license revoked', async () => {
    const db = fakeSupabase({ profiles: [{ id: 'u1', email: 'ken@example.com' }] });
    await recordSubscription(subscription(), deps(db.client));
    expect(await revokeForSubscription(db.client, 'sub_1')).toBe(true);
    await recordSubscription(subscription(), deps(db.client));
    expect(db.tables['dit_licenses']?.[0]).toMatchObject({ status: 'revoked' });
    expect(await revokeForSubscription(db.client, 'sub_vcwriter_room')).toBe(false);
  });

  it('reads the paid period from the item, as newer Stripe API versions send it', async () => {
    const db = fakeSupabase({ profiles: [{ id: 'u1', email: 'ken@example.com' }] });
    const newer = {
      ...subscription(),
      current_period_end: undefined,
      items: { data: [{ price: { id: 'price_y' }, current_period_end: 1_900_000_000 }] },
    } as unknown as Stripe.Subscription;
    await recordSubscription(newer, deps(db.client));
    expect(db.tables['dit_licenses']?.[0]).toMatchObject({ paid_through: new Date(1_900_000_000_000).toISOString(), status: 'active' });
  });

  it("leaves VC Writer's subscriptions on the shared account alone", async () => {
    const db = fakeSupabase();
    const room = subscription({ metadata: { room_id: 'r1' }, price: 'price_writers_room_seat' });
    expect(isOurs(room, prices)).toBe(false);
    expect(await recordSubscription(room, deps(db.client))).toBeNull();
    expect(db.writes).toEqual([]);
    // Ours by its price even without the tag (one made by hand in the dashboard).
    expect(isOurs(subscription({ metadata: {} }), prices)).toBe(true);
  });
});
