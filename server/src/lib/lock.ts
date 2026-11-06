// Mutex por chave (fila de promessas). Turnos da mesma chave rodam em série; chaves diferentes em paralelo.
const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  }).catch(() => {});
  return next;
}

export function isLocked(key: string): boolean {
  return chains.has(key);
}
