import { type PromisePayloadHandler, type Task } from "./memory/lock.js";
export declare enum ErrorKnitting {
    Function = 0,
    Symbol = 1,
    Json = 2,
    Serializable = 3
}
export declare const encoderError: ({ task, type, onPromise, detail, }: {
    task: Task;
    type: ErrorKnitting;
    onPromise?: PromisePayloadHandler;
    detail?: string;
}) => false;
