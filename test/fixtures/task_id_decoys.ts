import { task } from "../../knitting.ts";

/**
 * Module-identity fixtures. Two of these tasks are deliberately never
 * registered in a pool: they exist to consume task ids ahead of `wanted`, so a
 * pool that spans this module and another one only lines up if task identity is
 * independent of the order the two modules were imported in.
 */
export const decoyOne = task<number, number>({ f: () => -111 });
export const decoyTwo = task<number, number>({ f: () => -222 });
export const wanted = task<number, number>({ f: (value) => value * 2 });
