function chunk<T>(items: T[], size: number): T[][] {
  return [items.slice(0, size), items.slice(size)];
}

export async function allItems(items: string[]) {
  return Promise.all(items.map(async (i) => i));
}

export async function chunkedItems(items: string[]) {
  return Promise.all(chunk(items, 10).map(async (c) => c));
}

const queue: string[] = [];

export async function fromQueue() {
  return Promise.all(queue.map(async (i) => i));
}

// Fixed-size constant: not a scaling problem.
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export async function fixedDays() {
  return Promise.all(DAYS.map(async (d) => d));
}
