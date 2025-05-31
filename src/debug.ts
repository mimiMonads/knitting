export const threadOrder = ({
  max = 1000,
}: {
  max?: number;
}) => {
  const queue: number[] = [];

  const add = (thread: number) => (...args: any) => {
    // Adds a thread to the queue
    if (queue.length >= max) {
      queue.shift();
    }
    queue.push(thread);

    return args;
  };

  return {
    add,
    get: () => [...queue],
    clear: () => {
      queue.length = 0;
    },
  } as const;
};
