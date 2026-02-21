import * as mod from 'p-limit';

/**
 * Type definition for p-limit v3+
 * pLimit(concurrency) returns a limit function.
 * limit(fn) returns a Promise that resolves when fn finishes.
 */
type PLimit = (concurrency: number) => <T>(fn: () => T | PromiseLike<T>) => Promise<T>;

/**
 * Robust p-limit wrapper that handles CJS and ESM interop.
 * Some environments resolve 'p-limit' as the module object with a .default property,
 * others resolve it directly as the function.
 */
export const pLimit: PLimit = (
  (mod as any).default || mod
) as unknown as PLimit;
