export type NodeProcessLike = {
    getBuiltinModule?: (id: string) => unknown;
    versions?: {
        node?: string;
    };
    platform?: string;
    allowedNodeEnvironmentFlags?: ReadonlySet<string>;
    execArgv?: string[];
    execPath?: string;
    cwd?: () => string;
    env?: Record<string, string | undefined>;
    on?: (event: string, handler: (...args: unknown[]) => void) => unknown;
};
export type NodeCallSiteLike = {
    getFileName?: () => string | null | undefined;
    getFunctionName?: () => string | null | undefined;
    getMethodName?: () => string | null | undefined;
};
export declare const getNodeProcess: () => NodeProcessLike | undefined;
export declare const getNodeBuiltinModule: <T>(specifier: string) => T | undefined;
