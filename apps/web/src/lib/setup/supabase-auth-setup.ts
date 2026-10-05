/**
 * The shared Supabase project's sign-in settings, through the Management API:
 * this site's callback added to the redirect allow list (VC Writer's entries
 * kept), and a check that the sign-in email carries the six-digit code the
 * desktop app asks for. The template is shared with VC Writer, so it is
 * reported on, never rewritten.
 */

type Fetch = typeof fetch;

export const addRedirect = (list: string | null | undefined, url: string): { list: string; changed: boolean } => {
  const entries = (list ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes(url)) return { list: entries.join(','), changed: false };
  return { list: [...entries, url].join(','), changed: true };
};

export const carriesCode = (template: string | null | undefined): boolean => /\{\{\s*\.Token\s*\}\}/.test(template ?? '');

export const setupSupabaseAuth = async (
  fetcher: Fetch,
  options: { accessToken: string; projectRef: string; callbackUrl: string },
): Promise<{ notes: string[]; codeInEmail: boolean }> => {
  const url = `https://api.supabase.com/v1/projects/${options.projectRef}/config/auth`;
  const headers = { authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' };
  const response = await fetcher(url, { headers });
  if (!response.ok) throw new Error(`Reading the auth settings failed (HTTP ${response.status}). Is SUPABASE_ACCESS_TOKEN a personal access token with access to the project?`);
  const config = (await response.json()) as { uri_allow_list?: string; mailer_templates_magic_link_content?: string };
  const notes: string[] = [];
  const next = addRedirect(config.uri_allow_list, options.callbackUrl);
  if (next.changed) {
    const patched = await fetcher(url, { method: 'PATCH', headers, body: JSON.stringify({ uri_allow_list: next.list }) });
    if (!patched.ok) throw new Error(`Updating the redirect list failed (HTTP ${patched.status}).`);
    notes.push(`Added ${options.callbackUrl} to the sign-in redirect list (VC Writer's entries kept).`);
  } else {
    notes.push(`${options.callbackUrl} is already on the sign-in redirect list.`);
  }
  const codeInEmail = carriesCode(config.mailer_templates_magic_link_content);
  notes.push(
    codeInEmail
      ? 'The sign-in email carries the six-digit code the desktop app asks for.'
      : 'The sign-in email does not show the code. In Supabase → Authentication → Email Templates → Magic Link, add a line such as "Or type this code in the app: {{ .Token }}". It is shared with VC Writer, so word it for both.',
  );
  return { notes, codeInEmail };
};
