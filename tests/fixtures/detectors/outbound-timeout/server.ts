import axios from "axios";

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

// Cancellation signal only (no timer): low-confidence finding.
export async function cancellationOnly(url: string, ctrl: AbortController) {
  return fetch(url, { signal: ctrl.signal });
}

// Cancellation + real timeout: bounded.
export async function anyTimeout(url: string, ctrl: AbortController) {
  return fetch(url, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(3000)]) });
}
