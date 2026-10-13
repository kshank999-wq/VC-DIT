/**
 * Resend for vc-dit.com: the sending domain, its DNS records added to
 * Vercel (which runs the domain's DNS), and a verification request. Safe to
 * run again; a record already in Vercel is left as it is.
 */

export interface ResendRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  ttl?: string;
}

type Fetch = typeof fetch;

const json = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body['message'] ?? body['error'] ?? `HTTP ${response.status}`));
  return body;
};

/** Resend gives names relative to the domain ("resend._domainkey", "send"); Vercel wants the same. */
export const vercelRecord = (record: ResendRecord, domain: string) => ({
  name: record.name === domain ? '' : record.name.replace(new RegExp(`\\.?${domain.replace(/\./g, '\\.')}$`), ''),
  type: record.type,
  value: record.value,
  ttl: 60,
  ...(record.type === 'MX' ? { mxPriority: record.priority ?? 10 } : {}),
});

export const setupResend = async (
  fetcher: Fetch,
  options: { resendKey: string; domain: string; vercelToken?: string; vercelTeamId?: string },
): Promise<{ records: ResendRecord[]; notes: string[] }> => {
  const notes: string[] = [];
  const resend = (path: string, init: RequestInit = {}) =>
    fetcher(`https://api.resend.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${options.resendKey}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    }).then(json);

  const list = (await resend('/domains')) as { data?: { id: string; name: string; status: string }[] };
  let domain = list.data?.find((candidate) => candidate.name === options.domain);
  if (!domain) {
    domain = (await resend('/domains', { method: 'POST', body: JSON.stringify({ name: options.domain }) })) as { id: string; name: string; status: string };
    notes.push(`Added ${options.domain} to Resend.`);
  }
  const detail = (await resend(`/domains/${domain.id}`)) as { status?: string; records?: ResendRecord[] };
  const records = detail.records ?? [];
  if (detail.status === 'verified') {
    notes.push(`${options.domain} is already verified in Resend.`);
    return { records, notes };
  }

  if (options.vercelToken) {
    const team = options.vercelTeamId ? `?teamId=${encodeURIComponent(options.vercelTeamId)}` : '';
    const vercel = (path: string, init: RequestInit = {}) =>
      fetcher(`https://api.vercel.com${path}${team}`, {
        ...init,
        headers: { authorization: `Bearer ${options.vercelToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      }).then(json);
    const existing = (await vercel(`/v4/domains/${options.domain}/records`)) as { records?: { name: string; type: string; value: string }[] };
    for (const record of records) {
      const wanted = vercelRecord(record, options.domain);
      if (existing.records?.some((have) => have.name === wanted.name && have.type === wanted.type && have.value === wanted.value)) continue;
      await vercel(`/v2/domains/${options.domain}/records`, { method: 'POST', body: JSON.stringify(wanted) });
      notes.push(`Added the ${wanted.type} record ${wanted.name || '@'} to Vercel DNS.`);
    }
  } else {
    notes.push('No VERCEL_TOKEN: add these records under Vercel → Domains → vc-dit.com → DNS Records yourself.');
  }

  await resend(`/domains/${domain.id}/verify`, { method: 'POST' });
  notes.push('Asked Resend to verify; DNS can take a few minutes. Run this again to see the status.');
  return { records, notes };
};
