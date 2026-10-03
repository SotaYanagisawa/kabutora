import { AsyncLocalStorage } from "node:async_hooks";
export type ProviderExecution = {
    signal: AbortSignal;
    reserve: (host: string) => void | Promise<void>;
    outcome: (host: string, status: number) => void | Promise<void>;
};
const slots = new WeakMap<ProviderExecution, {
    active: number;
    waiting: Array<() => void>;
}>();
async function acquire(context: ProviderExecution) {
    let state = slots.get(context);
    if (!state) {
        state = { active: 0, waiting: [] };
        slots.set(context, state);
    }
    if (state.active >= 2)
        await new Promise<void>((resolve) => state!.waiting.push(resolve));
    else
        state.active++;
    return () => {
        const next = state!.waiting.shift();
        if (next)
            next();
        else
            state!.active--;
    };
}
const execution = new AsyncLocalStorage<ProviderExecution>();
export const withProviderExecution = <T>(context: ProviderExecution, work: () => Promise<T>) => execution.run(context, work);
/** Every outbound attempt, including redirects and fallbacks, consumes a reservation. */
export async function providerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const context = execution.getStore();
    if (!context)
        return fetch(input, init);
    let url = new URL(input instanceof Request ? input.url : String(input));
    const signal = AbortSignal.any([context.signal, ...(init?.signal ? [init.signal] : [])]);
    for (let redirects = 0; redirects <= 3; redirects++) {
        if (url.protocol !== "https:")
            throw new Error("provider_protocol_invalid");
        const release = await acquire(context);
        if (signal.aborted) {
            release();
            throw signal.reason;
        }
        try {
            await context.reserve(url.hostname);
        }
        catch (error) {
            release();
            throw error;
        }
        let response: Response;
        try {
            response = await fetch(url, { ...init, signal, redirect: "manual" });
            if (response.body && response.status < 300) {
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let size = 0;
                try {
                    while (true) {
                        const chunk = await reader.read();
                        if (chunk.done)
                            break;
                        size += chunk.value.byteLength;
                        if (size > 4000000)
                            throw new Error("provider_response_too_large");
                        chunks.push(chunk.value);
                    }
                }
                catch (error) {
                    await reader.cancel().catch(() => undefined);
                    throw error;
                }
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                response = new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
            }
        }
        catch (error) {
            await context.outcome(url.hostname, 503);
            throw error;
        }
        finally {
            release();
        }
        await context.outcome(url.hostname, response.status);
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
            const location = response.headers.get("Location");
            await response.body?.cancel();
            if (!location || redirects === 3)
                throw new Error("provider_redirect_invalid");
            const next = new URL(location, url);
            // Credentials/cookies must never be forwarded to a different origin.
            if (next.origin !== url.origin)
                throw new Error("provider_redirect_origin_invalid");
            url = next;
            continue;
        }
        return response;
    }
    throw new Error("provider_redirect_invalid");
}
