// The per-hop cost of the async machinery the driver leans on, with no I/O:
// every driver operation is a few dozen of these hops (an `await` of an async
// call, one `for await` step of an async generator, a promise settled through
// its executor), so their unit cost is a direct factor of the per-operation
// CPU. Runs unchanged under Node 24 (`node benchmarks/async-hops.ts`) and as a
// native build (`scripts/build.mjs benchmarks/async-hops.ts`).
const iterations = 1000000;

async function value(index: number): Promise<number> {
  return index;
}

async function awaitCalls(): Promise<number> {
  let sum = 0;
  for (let index = 0; index < iterations; index += 1) sum += await value(index);
  return sum;
}

async function* numbers(): AsyncGenerator<number> {
  for (let index = 0; index < iterations; index += 1) yield index;
}

async function forAwait(): Promise<number> {
  let sum = 0;
  for await (const entry of numbers()) sum += entry;
  return sum;
}

async function executorPromises(): Promise<number> {
  let sum = 0;
  for (let index = 0; index < iterations; index += 1) sum += await new Promise<number>((resolve) => resolve(index));
  return sum;
}

async function measure(label: string, run: () => Promise<number>): Promise<void> {
  const startedAt = Date.now();
  const checksum = await run();
  console.log(`ASYNC_RESULT:${label},${Date.now() - startedAt},${checksum}`);
}

await measure("await-call", awaitCalls);
await measure("for-await-generator", forAwait);
await measure("executor-promise", executorPromises);
