import { SITE_VARIABLES } from './env-file';

/**
 * The Vercel project for vc-dit.com, through Vercel's API: created if
 * it is not there (linked to the GitHub repository, root apps/web, files
 * outside the root included, since the repository installs as one workspace), the domain and
 * www attached, and every variable in the env file uploaded. Secrets go up as
 * "sensitive" (write-only in the dashboard); the rest as encrypted. Safe to run
 * again: variables are upserted and an attached domain is left alone.
 */

type Fetch = typeof fetch;

export interface VercelSetupOptions {
  token: string;
  teamId: string;
  projectName: string;
  repo: string;
  domain: string;
  env: Record<string, string>;
}

export const envPayload = (env: Record<string, string>) =>
  SITE_VARIABLES.filter((variable) => env[variable.key]?.trim()).map((variable) => ({
    key: variable.key,
    value: env[variable.key] as string,
    type: variable.secret ? 'sensitive' : 'encrypted',
    target: ['production', 'preview'],
  }));

export const setupVercel = async (fetcher: Fetch, options: VercelSetupOptions): Promise<{ projectId: string; notes: string[] }> => {
  const notes: string[] = [];
  const call = async (path: string, init: RequestInit = {}, okStatuses: number[] = []) => {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetcher(`https://api.vercel.com${path}${separator}teamId=${encodeURIComponent(options.teamId)}`, {
      ...init,
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok && !okStatuses.includes(response.status)) {
      const error = body['error'] as { message?: string } | undefined;
      throw new Error(`${init.method ?? 'GET'} ${path}: ${error?.message ?? `HTTP ${response.status}`}`);
    }
    return { status: response.status, body };
  };

  const found = await call(`/v9/projects/${options.projectName}`, {}, [404]);
  let projectId = found.status === 404 ? '' : String(found.body['id']);
  if (!projectId) {
    const created = await call('/v11/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: options.projectName,
        framework: 'nextjs',
        rootDirectory: 'apps/web',
        gitRepository: { type: 'github', repo: options.repo },
      }),
    });
    projectId = String(created.body['id']);
    notes.push(`Created the Vercel project ${options.projectName}, linked to ${options.repo}.`);
  } else {
    notes.push(`The Vercel project ${options.projectName} already exists.`);
  }
  await call(`/v9/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ rootDirectory: 'apps/web', framework: 'nextjs', sourceFilesOutsideRootDirectory: true }),
  });

  for (const domain of [{ name: options.domain }, { name: `www.${options.domain}`, redirect: options.domain, redirectStatusCode: 308 }]) {
    const added = await call(`/v10/projects/${projectId}/domains`, { method: 'POST', body: JSON.stringify(domain) }, [400, 409]);
    notes.push(added.status < 300 ? `Attached ${domain.name}.` : `${domain.name} is already attached.`);
  }

  const variables = envPayload(options.env);
  if (variables.length) {
    await call(`/v10/projects/${projectId}/env?upsert=true`, { method: 'POST', body: JSON.stringify(variables) });
    notes.push(`Uploaded ${variables.length} environment variables: ${variables.map((variable) => variable.key).join(', ')}.`);
  }
  return { projectId, notes };
};
