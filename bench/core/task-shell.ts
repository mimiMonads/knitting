import { bench, group, run as mitataRun } from "mitata";
import { format, print } from "../ulti/json-parse.ts";

type TaskLike = Uint32Array & {
  value: unknown;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
};

enum TaskIndex {
  FlagsToHost = 0,
  ID = 1,
  Type = 2,
  Start = 3,
  End = 4,
  PayloadLen = 5,
  slotBuffer = 6,
  Size = 8,
}

const def = (_?: unknown) => {};
let shellId = 0;
let classId = 0;
let sink = 0;

const headerSource = new Uint32Array(256);
for (let i = 0; i < headerSource.length; i++) {
  headerSource[i] = (i * 2654435761) >>> 0;
}

const fillTaskFrom = (task: TaskLike, array: Uint32Array, at: number) => {
  task[0] = array[at];
  task[1] = array[at + 1];
  task[2] = array[at + 2];
  task[3] = array[at + 3];
  task[4] = array[at + 4];
  task[5] = array[at + 5];
  task[6] = array[at + 6];
};

const createTaskShell = (): TaskLike => {
  const task = new Uint32Array(TaskIndex.Size) as TaskLike;
  task.value = null;
  task.resolve = def;
  task.reject = def;
  return task;
};

const makeTaskShell = (): TaskLike => {
  const task = createTaskShell();
  task[TaskIndex.ID] = shellId++;
  return task;
};

const makeTaskFromShell = (array: Uint32Array, at: number): TaskLike => {
  const task = createTaskShell();
  fillTaskFrom(task, array, at);
  return task;
};

class TaskArray extends Uint32Array {
  value: unknown;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;

  constructor() {
    super(TaskIndex.Size);
    this.value = null;
    this.resolve = def;
    this.reject = def;
  }
}

const makeTaskClass = (): TaskLike => {
  const task = new TaskArray() as unknown as TaskLike;
  task[TaskIndex.ID] = classId++;
  return task;
};

const makeTaskFromClass = (array: Uint32Array, at: number): TaskLike => {
  const task = new TaskArray() as unknown as TaskLike;
  fillTaskFrom(task, array, at);
  return task;
};

const settleTask = (task: TaskLike) => {
  if (task[TaskIndex.FlagsToHost] === 0) {
    task.resolve(task.value);
  } else {
    task.reject(task.value);
    task[TaskIndex.FlagsToHost] = 0;
  }
  sink ^= task[TaskIndex.ID] | 0;
};

group("task-shell", () => {
  bench("createTaskShell", () => {
    const t = createTaskShell();
    sink ^= t.length;
  });

  bench("new TaskArray class", () => {
    const t = new TaskArray();
    sink ^= t.length;
  });

  bench("makeTask shell + id", () => {
    const t = makeTaskShell();
    sink ^= t[TaskIndex.ID];
  });

  bench("makeTask class + id", () => {
    const t = makeTaskClass();
    sink ^= t[TaskIndex.ID];
  });

  bench("makeTaskFrom shell (copy 7)", () => {
    const t = makeTaskFromShell(headerSource, 32);
    sink ^= t[TaskIndex.Start];
  });

  bench("makeTaskFrom class (copy 7)", () => {
    const t = makeTaskFromClass(headerSource, 32);
    sink ^= t[TaskIndex.Start];
  });

  bench("makeTaskFrom+settle shell", () => {
    const t = makeTaskFromShell(headerSource, 32);
    t.value = 42;
    settleTask(t);
  });

  bench("makeTaskFrom+settle class", () => {
    const t = makeTaskFromClass(headerSource, 32);
    t.value = 42;
    settleTask(t);
  });
});

await mitataRun({
  format,
  print,
});

if (sink === 0x7fffffff) {
  console.log("sink", sink);
}
