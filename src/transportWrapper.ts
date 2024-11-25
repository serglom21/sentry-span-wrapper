import { NodeTransportOptions } from "@sentry/node/build/types/transports";
import { SentryWrapper } from "./sentryWrapper";
import { Transport, TransportMakeRequestResponse, TransportRequest } from "@sentry/types";
import { createTransport, getCurrentScope, startNewTrace } from "@sentry/node";
import { createEnvelopeFromBatch, extractTraceContext, replaceParentSpanID } from "./utils/trace";
import { sendEventPayload } from "./utils/request";
import { suppressTracing } from "@sentry/core";
import { NormalizedTraces } from "./types";
import { rejectedSyncPromise } from "@sentry/utils";
import * as fs from 'fs';

const SPAN_LIMIT = 1000;

export class TransportWrapper {
    private sentryWrapper : SentryWrapper;

    constructor(sentryWrapper: SentryWrapper) {
        this.sentryWrapper = sentryWrapper;
    }

    getTransport(){
        return this.SpanTransport.bind(this);
    }

    public SpanTransport(options: NodeTransportOptions) : Transport {
        const self = this;

        function getRequestOptions(body : any, headers: any) {
            return {
                body,
                method: 'POST',
                headers
            }
        }

        function makeRequest(request: TransportRequest): PromiseLike<TransportMakeRequestResponse>{
            const contexts = extractTraceContext(request.body);
            if (contexts == null || contexts.type !== "transaction") {
                return sendEventPayload(
                    options.url,
                    getRequestOptions(request.body, options.headers)
                )
            }
            
            const traceSpans = self.sentryWrapper.getChildSpans(contexts.traceContext.span_id);

            try {
                return suppressTracing(() => {
                    let requestPayload = {};
                    requestPayload = getRequestOptions(request.body, options.headers);
                    if (traceSpans.length <= SPAN_LIMIT) {
                        return sendEventPayload(
                            options.url,
                            requestPayload
                        ) as PromiseLike<TransportMakeRequestResponse>;
                    } else {
                        let spansBatched = 0;
                        let transactionEnvelope = '';
                        while (spansBatched < traceSpans.length) {
                            try {
                                let batch = traceSpans.slice(spansBatched, spansBatched + SPAN_LIMIT);
                                spansBatched += batch.length;
                                let parent_span_id = null;
                                transactionEnvelope = createEnvelopeFromBatch(batch, request.body);
                                startNewTrace(() => {
                                    parent_span_id = getCurrentScope().getPropagationContext().spanId;
                                })
                                transactionEnvelope = replaceParentSpanID(transactionEnvelope, parent_span_id)
                                requestPayload = getRequestOptions(transactionEnvelope, options.headers);
                                if (spansBatched < traceSpans.length) {
                                    sendEventPayload(
                                        options.url,
                                        requestPayload
                                    );
                                }
                            } catch (error) {
                                console.log(error);
                            }
                        }

                        requestPayload = getRequestOptions(transactionEnvelope, options.headers);
                        return sendEventPayload(
                            options.url,
                            requestPayload
                        ) as PromiseLike<TransportMakeRequestResponse>;
                    }
                }) as PromiseLike<TransportMakeRequestResponse>;
            } catch (error) {
                console.error(error);
                return rejectedSyncPromise(error) as PromiseLike<TransportMakeRequestResponse>;
            }
        }

        return createTransport(options, makeRequest);
    }
} 