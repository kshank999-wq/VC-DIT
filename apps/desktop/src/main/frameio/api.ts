/**
 * The Frame.io V4 API, as much of it as publishing dailies needs: who is
 * signed in, their accounts, workspaces and projects, a project's folders,
 * creating a folder, creating a file for a local upload (Frame.io answers
 * with presigned URLs for its parts), the file's upload status, deleting a
 * file that never finished, and leaving a comment on a file.
 *
 * Every call carries the person's bearer token. Rate limits (429) and
 * server errors are waited out and tried again, a few times, honouring
 * Retry-After; a 401 is tried once more with a fresh token.
 */

export const API_BASE = 'https://api.frame.io';

type Fetch = typeof fetch;

export interface Named {
  id: string;
  name: string;
}

export interface ProjectInfo extends Named {
  rootFolderId: string;
  viewUrl: string | null;
}

export interface FileInfo extends Named {
  size: number;
  status: string;
  viewUrl: string | null;
}

export interface UploadPart {
  size: number;
  url: string;
}

export interface CreatedUpload {
  id: string;
  mediaType: string | null;
  viewUrl: string | null;
  parts: UploadPart[];
}

export interface UploadStatus {
  complete: boolean;
  failed: boolean;
}

export class FrameioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ApiOptions {
  token: () => Promise<string>;
  /** The token was refused: the next `token()` must be a new one. */
  expire?: () => void;
  fetch?: Fetch;
  base?: string;
  /** Waits between tries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const RETRIES = 4;
const BACKOFF = [1000, 2000, 5000, 10000];

const describe = (status: number, body: unknown): string => {
  const errors = (body as { errors?: { detail?: string; title?: string }[] } | null)?.errors;
  const detail = errors?.map((error) => error.detail ?? error.title).filter(Boolean).join('; ');
  if (status === 401) return 'Frame.io did not accept the sign-in. Connect again.';
  if (status === 403) return `Frame.io refused: this account cannot do that${detail ? ` (${detail})` : ''}.`;
  if (status === 404) return `Frame.io could not find it${detail ? ` (${detail})` : ''}: it may have been deleted or moved.`;
  return `Frame.io answered ${status}${detail ? `: ${detail}` : ''}.`;
};

export class FrameioApi {
  private readonly fetcher: Fetch;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ApiOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.base = (options.base ?? API_BASE).replace(/\/+$/, '');
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** One API call, with the retries above. `path` is under the API's base, e.g. "/v4/me". */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${await this.options.token()}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
      } catch (cause) {
        if (this.options.signal?.aborted) throw cause;
        if (attempt < RETRIES) {
          await this.sleep(BACKOFF[attempt]!);
          continue;
        }
        throw new FrameioError('Frame.io could not be reached. Check the internet connection.', 0);
      }
      if (response.status === 401 && !refreshed && this.options.expire) {
        refreshed = true;
        this.options.expire();
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        const after = Number(response.headers.get('retry-after'));
        await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(60, after) * 1000 : BACKOFF[attempt]!);
        continue;
      }
      if (response.status === 204) return undefined as T;
      const json = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) throw new FrameioError(describe(response.status, json), response.status);
      return json as T;
    }
  }

  /** Every page of a list: Frame.io pages with links.next, the same path plus an `after` cursor. */
  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}page_size=100`;
    for (let page = 0; next && page < 200; page += 1) {
      const result: { data?: T[]; links?: { next?: string | null } } = await this.call('GET', next);
      out.push(...(result.data ?? []));
      const link = result.links?.next ?? null;
      next = link ? (link.startsWith('http') ? link.replace(/^https?:\/\/[^/]+/, '') : link) : null;
    }
    return out;
  }

  async me(): Promise<{ name: string; email: string | null }> {
    const result = await this.call<{ data: { name?: string; email?: string } }>('GET', '/v4/me');
    return { name: result.data.name || result.data.email || 'Frame.io user', email: result.data.email ?? null };
  }

  async accounts(): Promise<Named[]> {
    return (await this.all<{ id: string; display_name: string }>('/v4/accounts')).map((account) => ({ id: account.id, name: account.display_name }));
  }

  async workspaces(accountId: string): Promise<Named[]> {
    return (await this.all<{ id: string; name: string }>(`/v4/accounts/${enc(accountId)}/workspaces`)).map(({ id, name }) => ({ id, name }));
  }

  async projects(accountId: string, workspaceId: string): Promise<ProjectInfo[]> {
    return (await this.all<{ id: string; name: string; root_folder_id: string; view_url?: string; status?: string }>(`/v4/accounts/${enc(accountId)}/workspaces/${enc(workspaceId)}/projects`))
      .filter((project) => project.status !== 'inactive')
      .map((project) => ({ id: project.id, name: project.name, rootFolderId: project.root_folder_id, viewUrl: project.view_url ?? null }));
  }

  async folders(accountId: string, folderId: string): Promise<Named[]> {
    return (await this.all<{ id: string; name: string }>(`/v4/accounts/${enc(accountId)}/folders/${enc(folderId)}/folders`)).map(({ id, name }) => ({ id, name }));
  }

  async createFolder(accountId: string, parentId: string, name: string): Promise<Named> {
    const result = await this.call<{ data: { id: string; name: string } }>('POST', `/v4/accounts/${enc(accountId)}/folders/${enc(parentId)}/folders`, { data: { name } });
    return { id: result.data.id, name: result.data.name };
  }

  async files(accountId: string, folderId: string): Promise<FileInfo[]> {
    return (await this.all<{ id: string; name: string; file_size?: number; status?: string; view_url?: string; type?: string }>(`/v4/accounts/${enc(accountId)}/folders/${enc(folderId)}/files`))
      .filter((file) => !file.type || file.type === 'file')
      .map((file) => ({ id: file.id, name: file.name, size: file.file_size ?? 0, status: file.status ?? '', viewUrl: file.view_url ?? null }));
  }

  async createLocalUpload(accountId: string, folderId: string, name: string, size: number): Promise<CreatedUpload> {
    const result = await this.call<{ data: { id: string; media_type?: string | null; view_url?: string; upload_urls?: UploadPart[] } }>(
      'POST',
      `/v4/accounts/${enc(accountId)}/folders/${enc(folderId)}/files/local_upload`,
      { data: { name, file_size: size } },
    );
    return { id: result.data.id, mediaType: result.data.media_type ?? null, viewUrl: result.data.view_url ?? null, parts: result.data.upload_urls ?? [] };
  }

  async uploadStatus(accountId: string, fileId: string): Promise<UploadStatus> {
    const result = await this.call<{ data: { upload_complete?: boolean; upload_failed?: boolean } }>('GET', `/v4/accounts/${enc(accountId)}/files/${enc(fileId)}/status`);
    return { complete: result.data.upload_complete === true, failed: result.data.upload_failed === true };
  }

  async deleteFile(accountId: string, fileId: string): Promise<void> {
    await this.call('DELETE', `/v4/accounts/${enc(accountId)}/files/${enc(fileId)}`);
  }

  async comment(accountId: string, fileId: string, text: string): Promise<void> {
    await this.call('POST', `/v4/accounts/${enc(accountId)}/files/${enc(fileId)}/comments`, { data: { text } });
  }
}

const enc = (id: string) => encodeURIComponent(id);
