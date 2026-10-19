// Two independent calls awaited one after the other: they can run concurrently.
export async function independent(a: string, b: string) {
  const first = await fetch(a);
  const second = await fetch(b);
  return [first, second];
}

// Correct: already concurrent.
export async function concurrent(a: string, b: string) {
  const [first, second] = await Promise.all([fetch(a), fetch(b)]);
  return [first, second];
}

// Not independent: the second call uses the result of the first.
export async function dependent(a: string) {
  const res = await fetch(a);
  const body = await res.json();
  return body;
}
