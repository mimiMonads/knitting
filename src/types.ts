// ---API---

import { endpointSymbol } from "./api.ts";

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

export type Args = External | Serializable;

export type FixedPoints = Record<string, Composed>;

export type Composed = {
  readonly f: (...args: any) => any;
} & SecondPart;

export type ComposedWithKey = Composed & { name: string };



export type FunctionMapType<T extends Record<string, FixPoint<Args, Args>>> = {
  [K in keyof T]: T[K]["f"];
};


export interface FixPoint<A extends Args, B extends Args> {
  readonly href?: string;
  readonly f: (
    args: A,
  ) => Promise<B>;
}

export type SecondPart = {
  readonly [endpointSymbol]: true;
  readonly id: number;
  readonly importedFrom: string;
};


export type Pool<T extends Record<string, FixPoint<Args, Args>>> = {
  terminateAll: { (): void };
  callFunction: FunctionMapType<T>;
  fastCallFunction: FunctionMapType<T>;
  send: { (): void };
};

export type ReturnFixed<A extends Args = undefined, B extends Args = undefined> =
  & FixPoint<A, B>
  & SecondPart;


export type ValidInput =
  | bigint
  | void
  | JSONValue
  | Map<Serializable, Serializable>
  | Set<Serializable>;

export type External = unknown;

export type Inliner  = {
    position?: "first" | "last"
}

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
    resolveAfterFinishinAll?: true;
    NoSideEffects?: true
  };

  
 export type CreateThreadPool = {
  threads?: number;
  inliner?: Inliner
  balancer?: Balancer;
  worker?: WorkerSettings;
  debug?: DebugOptions;
  source?: string;
};