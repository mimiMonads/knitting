type CanonicalPathFsApi = {
    existsSync?: (candidate: string) => boolean;
    realpathSync?: (candidate: string) => string;
};
export declare const toCanonicalPath: (candidate: string, fsApi?: CanonicalPathFsApi) => string;
export {};
