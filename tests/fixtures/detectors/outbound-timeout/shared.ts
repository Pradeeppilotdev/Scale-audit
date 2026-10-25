import axios from "axios";

// Shared axios client with a timeout: call sites inherit it.
export const api = axios.create({ timeout: 5000 });

export async function viaShared(url: string) {
  return api.get(url);
}
