import { createHmac } from 'node:crypto';
import { NextResponse } from 'next/server';
import { adminClient } from './supabase';

/**
 * Per-address rate limiting, on the limiter VC Writer already keeps in the
 * shared database (`consume_rate_limit`). For noise and cost, not access: it
 * fails open, because a limiter that could take checkout down when it broke is
 * a worse risk than the burst it guards against. Keys are hashed addresses,
 * prefixed `dit-` so this site's allowances never mix with VC Writer's.
 */

export interface RateLimitRule {
  name: string;
  limit: number;
  windowSeconds: number;
}

export type Consume = (key: string, rule: RateLimitRule) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;

export const RULES = {
  checkout: { name: 'dit-checkout', limit: 10, windowSeconds: 600 },
  activate: { name: 'dit-activate', limit: 30, windowSeconds: 3600 },
  status: { name: 'dit-status', limit: 120, windowSeconds: 3600 },
  email: { name: 'dit-email', limit: 5, windowSeconds: 3600 },
  // Takes an authorization code without sign-in: tight enough that guessing one is hopeless.
  download: { name: 'dit-download', limit: 20, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;

export const clientAddress = (request: Request): string => {
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || 'unknown';
};

export const rateLimitKey = (rule: RateLimitRule, request: Request, subject?: string): string => {
  const salt = process.env['RATE_LIMIT_SALT'] ?? 'vcdit-rate-limit';
  const digest = createHmac('sha256', salt).update(subject ?? clientAddress(request)).digest('hex').slice(0, 32);
  return `${rule.name}:${digest}`;
};

const consumeInDatabase: Consume = async (key, rule) => {
  const { data, error } = await adminClient().rpc('consume_rate_limit', {
    p_key: key,
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });
  const row = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; retry_after_seconds: number } | null | undefined;
  if (error || !row) {
    console.warn(`rate limit unavailable for ${rule.name}; allowing the request`, error?.message ?? '');
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return { allowed: row.allowed === true, retryAfterSeconds: Number(row.retry_after_seconds) || 0 };
};

/** A 429 to send, or null when the request may go ahead. */
export const rateLimit = async (
  request: Request,
  rule: RateLimitRule,
  consume: Consume = consumeInDatabase,
  subject?: string,
): Promise<Response | null> => {
  try {
    const verdict = await consume(rateLimitKey(rule, request, subject), rule);
    if (verdict.allowed) return null;
    return NextResponse.json(
      { error: 'Too many requests. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(Math.max(1, verdict.retryAfterSeconds)) } },
    );
  } catch (cause) {
    console.warn(`rate limit threw for ${rule.name}; allowing the request`, cause);
    return null;
  }
};
