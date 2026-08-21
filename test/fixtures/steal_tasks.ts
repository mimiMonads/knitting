import { task } from "../../knitting.ts";

export const double = task<number, number>({ f: (value) => value * 2 });
export const concat = task<string, string>({ f: (value) => `${value}!` });
