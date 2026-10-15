const axios = {
  get: (...args: unknown[]) => args,
  post: (...args: unknown[]) => args,
  create: (config: unknown) => ({ get: (...args: unknown[]) => [config, ...args] }),
} as any;

export async function noTimeoutFetch(url: string) {
  return fetch(url);
}

export async function withTimeoutFetch(url: string) {
  return fetch(url, { signal: AbortSignal.timeout(5000) });
}

export async function noTimeoutAxios(url: string) {
  return axios.get(url);
}

export async function withTimeoutAxios(url: string) {
  return axios.get(url, { timeout: 3000 });
}

// Config passed as a variable: low-confidence only.
export async function variableConfig(url: string, opts: RequestInit) {
  return fetch(url, opts);
}
