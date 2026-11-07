/** A promise a test resolves after exercising an operation that waits for it. */
export function createDeferred<Value>() {
  let complete: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve: (value: Value) => {
      if (!complete) throw new Error('The promise was not initialized.');
      complete(value);
    },
  };
}
