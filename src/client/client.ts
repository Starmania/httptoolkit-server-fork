import * as stream from 'stream';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';

export type RawHeaders = Array<[key: string, value: string]>;

export interface RequestDefinition {
    method: string;
    url: string;

    /**
     * The raw headers to send. These will be sent exactly as provided - no headers
     * will be added automatically.
     *
     * Note that this means omitting the 'Host' header may cause problems, as will
     * omitting both 'Content-Length' and 'Transfer-Encoding' on requests with
     * bodies.
     */
    headers: RawHeaders;
    rawBody?: Uint8Array;
}

export interface RequestOptions {
    /**
     * An abort signal, which can be used to cancel the in-process request if
     * required.
     */
    abortSignal?: AbortSignal;
}

export type ResponseStreamEvents =
    | RequestStart
    | ResponseHead
    | ResponseBodyPart
    | ResponseEnd;
// Other notable events: errors (via 'error' event) and clean closure (via 'end').

export interface RequestStart {
    type: 'request-start';
    startTime: number; // Unix timestamp
    timestamp: number; // High precision timer (for relative calculations on later events)
}

export interface ResponseHead {
    type: 'response-head';
    statusCode: number;
    statusMessage?: string;
    headers: RawHeaders;
    timestamp: number;
}

export interface ResponseBodyPart {
    type: 'response-body-part';
    rawBody: Buffer;
    timestamp: number;
}

export interface ResponseEnd {
    type: 'response-end';
    timestamp: number;
}

export function sendRequest(
    requestDefn: RequestDefinition,
    options: RequestOptions
): stream.Readable {
    const url = new URL(requestDefn.url);

    const request = (url.protocol === 'https' ? https : http).request(requestDefn.url, {
        method: requestDefn.method,
        signal: options.abortSignal
    });

    options.abortSignal?.addEventListener('abort', () => {
        // In older Node versions, this seems to be required to _actually_ abort the request:
        request.abort();
    });

    // Node supports sending raw headers via [key, value, key, value] array, but if we do
    // so with 'headers' above then we can't removeHeader first (to disable the defaults).
    // Instead we remove headers and then manunally trigger the 'raw' write behaviour.

    request.removeHeader('connection');
    request.removeHeader('transfer-encoding');
    request.removeHeader('content-length');

    (request as any)._storeHeader(
        request.method + ' ' + request.path + ' HTTP/1.1\r\n',
        flattenPairedRawHeaders(requestDefn.headers)
    );

    if (requestDefn.rawBody?.byteLength) {
        request.end(requestDefn.rawBody);
    } else {
        request.end();
    }

    const resultsStream = new stream.Readable({
        objectMode: true,
        read() {} // Can't pull data - we manually fill this with .push() instead.
    });

    resultsStream.push({
        type: 'request-start',
        startTime: Date.now(),
        timestamp: performance.now()
    });

    new Promise<http.IncomingMessage>((resolve, reject) => {
        request.on('error', reject);
        request.on('response', resolve);
    }).then((response) => {
        resultsStream.push({
            type: 'response-head',
            statusCode: response.statusCode!,
            statusMessage: response.statusMessage,
            headers: pairFlatRawHeaders(response.rawHeaders),
            timestamp: performance.now()
        });

        response.on('data', (data) => resultsStream.push({
            type: 'response-body-part',
            rawBody: data,
            timestamp: performance.now()
        }));

        response.on('end', () => {
            resultsStream.push({ type: 'response-end', timestamp: performance.now() });
            resultsStream.push(null);
        });
        response.on('error', (error) => resultsStream.destroy(error));
    }).catch((error) => {
        resultsStream.destroy(error);
        request.destroy();
    });

    return resultsStream;
}

/**
 * Turn node's _very_ raw headers ([k, v, k, v, ...]) into our slightly more convenient
 * pairwise tuples [[k, v], [k, v], ...] RawHeaders structure.
 */
export function pairFlatRawHeaders(flatRawHeaders: string[]): RawHeaders {
    const result: RawHeaders = [];
    for (let i = 0; i < flatRawHeaders.length; i += 2 /* Move two at a time */) {
        result[i/2] = [flatRawHeaders[i], flatRawHeaders[i+1]];
    }
    return result;
}

/**
 * Turn our raw headers [[k, v], [k, v], ...] tuples into Node's very flat
 * [k, v, k, v, ...] structure.
 */
export function flattenPairedRawHeaders(rawHeaders: RawHeaders): string[] {
    return rawHeaders.flat();
}