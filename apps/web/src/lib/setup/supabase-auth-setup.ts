/**
 * The vc-dit Supabase project's sign-in settings, through the Management API:
 * this site's callback added to the redirect allow list (existing entries
 * kept) and the Site URL set to vc-dit.com. The website signs in with an
 * emailed link; the desktop app needs no sign-in (it uses the authorization
 * code), so the email template is left as it is.
 */

type Fetch = typeof fetch;

export const addRedirect = (list: string | null | undefined, url: string): { list: string; changed: boolean } => {
  const entries = (list ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes(url)) return { list: entries.join(','), changed: false };
  return { list: [...entries, url].join(','), changed: true };
};


export const setupSupabaseAuth = async (
  fetcher: Fetch,
  options: { accessToken: string; projectRef: string; callbackUrl: string; siteUrl: string },
): Promise<{ notes: string[] }> => {
  const url = `https://api.supabase.com/v1/projects/${options.projectRef}/config/auth`;
  const headers = { authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' };
  const response = await fetcher(url, { headers });
  if (!response.ok) throw new Error(`Reading the auth settings failed (HTTP ${response.status}). Is SUPABASE_ACCESS_TOKEN a personal access token with access to the project?`);
  const config = (await response.json()) as { uri_allow_list?: string; site_url?: string };
  const notes: string[] = [];
  const next = addRedirect(config.uri_allow_list, options.callbackUrl);
  const patch: Record<string, string> = {};
  if (next.changed) patch['uri_allow_list'] = next.list;
  // The project is VC DIT's alone, so its Site URL (where sign-in links fall back to) is vc-dit.com.
  if (config.site_url !== options.siteUrl) patch['site_url'] = options.siteUrl;
  if (Object.keys(patch).length > 0) {
    const patched = await fetcher(url, { method: 'PATCH', headers, body: JSON.stringify(patch) });
    if (!patched.ok) throw new Error(`Updating the sign-in settings failed (HTTP ${patched.status}).`);
  }
  notes.push(
    next.changed ? `Added ${options.callbackUrl} to the sign-in redirect list.` : `${options.callbackUrl} is already on the sign-in redirect list.`,
    patch['site_url'] ? `Set the Site URL to ${options.siteUrl}.` : `The Site URL is already ${options.siteUrl}.`,
  );
  return { notes };
};
