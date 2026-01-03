import { endpointSymbol } from "./common/task-symbol.ts";
// ──────────────────────────────────────────────────────────────────────────────
// Payloads & queue slots shared across runtime/worker
// ──────────────────────────────────────────────────────────────────────────────

export enum PayloadType {
  UNREACHABLE = 0,
  String = 1,
  BigUint = 2,
  BigInt = 3,
  True = 4,
  False = 5,
  Undefined = 6,
  NaN = 7,
  Infinity = 8,
  NegativeInfinity = 9,
  Float64 = 10,
  Uint32 = 11,
  Int32 = 12,
  Uint64 = 13,
  Int64 = 14,
  Null = 15,
  Json = 16,
  Uint8Array = 17,
  Serializable = 18,
  StringToJson = 19,
  SerializedAndReady = 20,
  NumericBuffer = 21,
  NumericBufferParsed = 22,
}

export type Accepted = (value: unknown) => void;
export type Rejected = (reason: unknown) => void;

export type PromiseEntry = {
  promise: Promise<unknown>;
  resolve: Accepted;
  reject: Rejected;
};

export type PromiseMap = Map<number, PromiseEntry>;

export type WorkerCall = {
  fnNumber: number;
};

export type WorkerInvoke = (args: Uint8Array) => Promise<unknown>;

export interface WorkerContext {
  txIdle(): boolean;
  send(): void;
  call(descriptor: WorkerCall): WorkerInvoke;
  fastCalling(descriptor: WorkerCall): WorkerInvoke;
  kills(): void;
}

export type CreateContext = WorkerContext;

export type WorkerData = {
  sab: SharedArrayBuffer;
  secondSab: SharedArrayBuffer;
  list: string[];
  ids: number[];
  thread: number;
  totalNumberOfThread: number;
  debug?: DebugOptions;
  startAt: number;
  workerOptions?: WorkerSettings;
  at: number[];
  lock?: LockBuffers;
};

export type LockBuffers = {
  headers: SharedArrayBuffer;
  lockSector: SharedArrayBuffer;
  payload: SharedArrayBuffer;
};

// ──────────────────────────────────────────────────────────────────────────────
// Public API-facing contracts
// ──────────────────────────────────────────────────────────────────────────────

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONArray
  | JSONObject;

interface JSONObject {
  [key: string]: JSONValue;
}

interface JSONArray extends Array<JSONValue> {}

type Serializable = string | object | number | boolean | bigint;

export type ValidInput =
  | bigint
  | void
  | JSONValue
  | Map<Serializable, Serializable>
  | Set<Serializable>;

export type Args = ValidInput | Serializable;

export type tasks = Record<string, Composed>;

export type Composed = {
  readonly f: (...args: any) => any;
} & SecondPart;

export type ComposedWithKey = Composed & { name: string };

export type FunctionMapType<T extends Record<string, FixPoint<Args, Args>>> = {
  [K in keyof T]: T[K]["f"];
};

export interface FixPoint<A extends Args, B extends Args> {
  readonly href?: string;
  readonly f: (args: A) => Promise<B>;
}

export type SecondPart = {
  readonly [endpointSymbol]: true;
  readonly id: number;
  /**
   * IMPORTANT: `at` helps to create a `createPool` because we dont know 
   * the name of the variable at runtime, so basically this gets the logical order
   * of the exported file, so no matter the name the worker can track which ` task `
   * to track
   */
  readonly at: number;
  readonly importedFrom: string;
};

export type Pool<T extends Record<string, FixPoint<Args, Args>>> = {
  shutdown: () => void;
  call: FunctionMapType<T>;
  fastCall: FunctionMapType<T>;
  send: () => void;
};

export type ReturnFixed<
  A extends Args = undefined,
  B extends Args = undefined,
> =
  & FixPoint<A, B>
  & SecondPart;

export type External = unknown;

export type Inliner = {
  position?: "first" | "last";
};

export type Balancer =
  | "robinRound"
  | "firstIdle"
  | "randomLane"
  | "firstIdleOrRandom";

export type DebugOptions = {
  extras?: boolean;
  logMain?: boolean;
  //logThreads?: boolean;
  logHref?: boolean;
  logImportedUrl?: boolean;
  threadOrder?: Boolean | number;
};

export type WorkerSettings = {
  resolveAfterFinishingAll?: true;
  NoSideEffects?: true;
};

export type CreatePool = {
  threads?: number;
  inliner?: Inliner;
  balancer?: Balancer;
  worker?: WorkerSettings;
  debug?: DebugOptions;
  source?: string;
  transport?: "codec" | "lock2";
};

export type { Task } from "./memory/lock.ts";
export {
  LockBound,
  PayloadBuffer,
  PayloadSingal,
  TaskIndex,
} from "./memory/lock.ts";
export type { RegisterMalloc } from "./memory/regionRegistry.ts";
