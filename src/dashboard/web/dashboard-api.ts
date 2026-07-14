export interface DashboardApiResult<T = any> {
  status: number;
  body: T;
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json().catch(() => ({} as T));
}

export async function jget<T = any>(url: string): Promise<DashboardApiResult<T>> {
  const response = await fetch(url);
  return { status: response.status, body: await readJson<T>(response) };
}

export async function jsend<T = any>(
  method: string,
  url: string,
  body?: unknown,
): Promise<DashboardApiResult<T>> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await readJson<T>(response) };
}

export const jpost = <T = any>(url: string, body?: unknown): Promise<DashboardApiResult<T>> =>
  jsend<T>('POST', url, body);

export const jput = <T = any>(url: string, body: unknown): Promise<DashboardApiResult<T>> =>
  jsend<T>('PUT', url, body);
