import type { Balancer, CreateContext } from "../types.js";
export type Handler<A, R> = (args: A) => R;
type LaneHandler = (args: any) => Promise<unknown>;
type LaneInvoker = (args: any) => Promise<unknown>;
type manager = {
    contexts: readonly CreateContext[];
    balancer?: Balancer;
    handlers: LaneHandler[];
    inlinerGate?: {
        index: number;
        threshold: number;
    };
};
export declare const managerMethod: ({ contexts, balancer, handlers, inlinerGate, }: manager) => LaneInvoker;
export declare function roundRobin(_contexts: readonly CreateContext[]): (handlers: LaneHandler[]) => (max: number) => (args: any) => Promise<unknown>;
export declare function firstIdle(contexts: readonly CreateContext[]): (handlers: LaneHandler[]) => (max: number) => (args: any) => Promise<unknown>;
export declare const randomLane: (_: readonly CreateContext[]) => (handlers: LaneHandler[]) => (max: number) => (args: any) => Promise<unknown>;
export declare function firstIdleRandom(contexts: readonly CreateContext[]): (handlers: LaneHandler[]) => (max: number) => (args: any) => Promise<unknown>;
export {};
