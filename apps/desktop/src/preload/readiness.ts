export interface PreloadReadiness {
  markReady(): void;
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}

export function createPreloadReadiness(): PreloadReadiness {
  let release = () => {};
  let released = false;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    markReady() {
      if (!released) {
        released = true;
        release();
      }
    },
    run<T>(operation: () => T | Promise<T>): Promise<T> {
      return ready.then(operation);
    },
  };
}
