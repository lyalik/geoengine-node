export interface BridgeRequest {
    method: string;
    pathname: string;
    query?: Record<string, string | undefined>;
    headers?: Record<string, string | string[] | undefined>;
    body?: any;
    rawBody?: Buffer | string;
}

export interface BridgeResponse {
    status: number;
    headers: Record<string, string>;
    body: any;
}

export interface BridgeOptions {
    apiKey?: string;
    siteUrl?: string;
    staticDir?: string;
    autoRestart?: boolean;
    postHandler?: string;
    env?: NodeJS.ProcessEnv;
}

export declare class JsonStore {
    constructor(filePath: string, allowedFields: Set<string>);
    get(id: string): Record<string, any> | null;
    all(): Record<string, Record<string, any>>;
    update(id: string, fields: Record<string, any>): Record<string, any>;
    upsert(id: string, fields: Record<string, any>): Record<string, any>;
    delete(id: string): boolean;
}

export declare function createStores(env?: NodeJS.ProcessEnv): { seo: JsonStore; products: JsonStore };
export declare function createBridge(options?: BridgeOptions): {
    handle(req: BridgeRequest): Promise<BridgeResponse | null>;
    store: JsonStore;
    productStore: JsonStore;
    allPages(): string[];
    siteUrl: string;
    staticDir: string;
    apiKey: string;
};
export declare function injectSeo(indexHtml: string, page: string, store: JsonStore, siteUrl?: string): string;
export declare function createSeoMiddleware(options?: { env?: NodeJS.ProcessEnv; siteUrl?: string }): (req: any, res: any, next: () => void) => void;
export declare function pageFromPath(pathname: string): string;
export declare const PREFIX: string;
export declare const VERSION: string;
