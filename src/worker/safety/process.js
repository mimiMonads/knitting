import { getNodeProcess } from "../../common/node-compat.js";
const toErrorMessage = (error) => error instanceof Error ? error.message : String(error);
const failProcessGuardInstall = (target, reason, cause) => {
    const suffix = cause === undefined ? "" : `: ${toErrorMessage(cause)}`;
    throw new Error(`KNT_ERROR_PROCESS_GUARD_INSTALL: ${target} ${reason}${suffix}`);
};
export const installTerminationGuard = () => {
    const proc = getNodeProcess();
    if (!proc)
        return;
    if (proc.__knittingTerminationGuard === true)
        return;
    const blocked = (name) => {
        throw new Error(`KNT_ERROR_PROCESS_GUARD: ${name} is disabled in worker tasks`);
    };
    const guardMethod = (name) => {
        try {
            Object.defineProperty(proc, name, {
                configurable: false,
                writable: false,
                value: (..._args) => blocked(`process.${name}`),
            });
        }
        catch (defineError) {
            try {
                proc[name] = (..._args) => blocked(`process.${name}`);
            }
            catch (assignError) {
                failProcessGuardInstall(`process.${name}`, "install failed", [
                    toErrorMessage(defineError),
                    toErrorMessage(assignError),
                ].join("; "));
            }
        }
        if (typeof proc[name] !== "function") {
            failProcessGuardInstall(`process.${name}`, "install verification failed");
        }
    };
    guardMethod("exit");
    guardMethod("kill");
    guardMethod("abort");
    guardMethod("reallyExit");
    const globalScope = globalThis;
    if (globalScope.Deno && typeof globalScope.Deno.exit === "function") {
        try {
            Object.defineProperty(globalScope.Deno, "exit", {
                configurable: false,
                writable: false,
                value: (_code) => blocked("Deno.exit"),
            });
        }
        catch (defineError) {
            try {
                globalScope.Deno.exit = (_code) => blocked("Deno.exit");
            }
            catch (assignError) {
                failProcessGuardInstall("Deno.exit", "install failed", [
                    toErrorMessage(defineError),
                    toErrorMessage(assignError),
                ].join("; "));
            }
        }
        if (typeof globalScope.Deno.exit !== "function") {
            failProcessGuardInstall("Deno.exit", "install verification failed");
        }
    }
    proc.__knittingTerminationGuard = true;
};
export const installUnhandledRejectionSilencer = () => {
    const proc = getNodeProcess();
    if (!proc || typeof proc.on !== "function") {
        return;
    }
    if (proc.__knittingUnhandledRejectionSilencer === true)
        return;
    proc.__knittingUnhandledRejectionSilencer = true;
    // Worker task code may create detached promises; keep workers alive.
    proc.on("unhandledRejection", () => { });
};
