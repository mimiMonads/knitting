type PermissionPath = string | URL;
type NodePermissionSettings = {
    allowWorker?: boolean;
    allowChildProcess?: boolean;
    allowAddons?: boolean;
    allowWasi?: boolean;
};
type DenoPermissionSettings = {
    lock?: boolean | PermissionPath;
    frozen?: boolean;
    /**
     * Legacy compatibility: superseded by top-level `run`.
     */
    allowRun?: boolean;
};
type SysApiName = "hostname" | "osRelease" | "osUptime" | "loadavg" | "networkInterfaces" | "systemMemoryInfo" | "uid" | "gid";
type PermissionEnvironment = {
    allow?: string[] | true;
    deny?: string[];
    files?: PermissionPath | PermissionPath[];
};
type PermissionMode = "strict" | "unsafe" | "custom";
type PermissionLegacyMode = "off";
type PermissionProtocol = {
    /**
     * `strict` = hardened defaults, `unsafe` = full access,
     * `custom` = strict baseline with user overrides.
     */
    mode?: PermissionMode;
    /**
     * Console access for worker task code.
     * Defaults to `false` in strict/custom mode, `true` in unsafe mode.
     */
    console?: boolean;
    /**
     * Base directory used to resolve relative paths.
     * Defaults to the current shell working directory.
     */
    cwd?: string;
    /**
     * Read allow-list. `true` means unrestricted access.
     */
    read?: PermissionPath[] | true;
    /**
     * Write allow-list. `true` means unrestricted access.
     */
    write?: PermissionPath[] | true;
    /**
     * Explicit deny-read entries.
     */
    denyRead?: PermissionPath[];
    /**
     * Explicit deny-write entries.
     */
    denyWrite?: PermissionPath[];
    /**
     * Network allow-list. `true` means unrestricted access.
     */
    net?: string[] | true;
    /**
     * Explicit network deny-list.
     */
    denyNet?: string[];
    /**
     * Allowed import hostnames. `true` means unrestricted import hosts.
     */
    allowImport?: string[] | true;
    /**
     * Environment permission settings.
     */
    env?: PermissionEnvironment;
    /**
     * Subprocess allow-list. `true` means unrestricted access.
     */
    run?: string[] | true;
    /**
     * Explicit subprocess deny-list.
     */
    denyRun?: string[];
    /**
     * Whether worker spawning is allowed.
     */
    workers?: boolean;
    /**
     * FFI allow-list or toggle.
     */
    ffi?: PermissionPath[] | boolean;
    /**
     * Explicit FFI deny-list.
     */
    denyFfi?: PermissionPath[];
    /**
     * System API allow-list. `true` means unrestricted access.
     */
    sys?: SysApiName[] | true;
    /**
     * Explicit system API deny-list.
     */
    denySys?: SysApiName[];
    /**
     * Whether WASI is allowed.
     */
    wasi?: boolean;
    /**
     * Backward-compat runtime overrides.
     */
    node?: NodePermissionSettings;
    deno?: DenoPermissionSettings;
};
type PermissionProtocolInput = PermissionMode | PermissionLegacyMode | PermissionProtocol;
type L3RuntimeKeys = {
    deno: string[];
    node: string[];
};
type ResolvedPermissionProtocol = {
    enabled: boolean;
    mode: PermissionMode;
    unsafe: boolean;
    allowConsole: boolean;
    cwd: string;
    read: string[];
    readAll: boolean;
    write: string[];
    writeAll: boolean;
    denyRead: string[];
    denyWrite: string[];
    net: string[];
    netAll: boolean;
    denyNet: string[];
    allowImport: string[];
    allowImportAll: boolean;
    env: {
        allow: string[];
        allowAll: boolean;
        deny: string[];
        files: string[];
    };
    envFiles: string[];
    run: string[];
    runAll: boolean;
    denyRun: string[];
    workers: boolean;
    ffi: string[];
    ffiAll: boolean;
    denyFfi: string[];
    sys: SysApiName[];
    sysAll: boolean;
    denySys: SysApiName[];
    wasi: boolean;
    lockFiles: {
        deno?: string;
    };
    node: Required<NodePermissionSettings> & {
        flags: string[];
    };
    deno: Required<Omit<DenoPermissionSettings, "lock">> & {
        flags: string[];
    };
    l3: L3RuntimeKeys;
};
export declare const resolvePermissionProtocol: ({ permission, modules, }: {
    permission?: PermissionProtocolInput;
    modules?: string[];
}) => ResolvedPermissionProtocol | undefined;
export declare const toRuntimePermissionFlags: (protocol: ResolvedPermissionProtocol | undefined) => string[];
export type { PermissionPath, PermissionMode, PermissionLegacyMode, SysApiName, NodePermissionSettings, DenoPermissionSettings, PermissionEnvironment, PermissionProtocol, PermissionProtocolInput, ResolvedPermissionProtocol, };
