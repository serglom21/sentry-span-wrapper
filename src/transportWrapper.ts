import { NodeTransportOptions } from "@sentry/node/build/types/transports";
import { SentryWrapper } from "./sentryWrapper";
import { Transport, TransportMakeRequestResponse, TransportRequest } from "@sentry/types";
import { createTransport, getCurrentScope, startNewTrace } from "@sentry/node";
import { correctSpansForTrace, extractTraceContext, replaceTraceID } from "./utils/trace";
import { sendEventPayload } from "./utils/request";
import { suppressTracing } from "@sentry/core";
import { NormalizedTraces } from "./types";
import { rejectedSyncPromise } from "@sentry/utils";
import * as fs from 'fs';

const SPAN_TRACKING_SERVICE_URL = "http://localhost:4000/collect-spans";

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
            if (contexts == null || !SPAN_TRACKING_SERVICE_URL) {
                return sendEventPayload(
                    options.url,
                    getRequestOptions(request.body, options.headers)
                )
            }

            const traceSpans = self.sentryWrapper.getSpansByTraceID(contexts.traceContext.trace_id);
            
            const requestOptions = getRequestOptions(
                JSON.stringify({
                    traceId: contexts.traceContext.trace_id,
                    numOfSpans: traceSpans?.length
                }),
                {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            )

            try {
                //return suppressTracing(() => {
                    return fetch(SPAN_TRACKING_SERVICE_URL, requestOptions).then(response => {
                        return response.json().then(jsonResponse => {
                            if (!jsonResponse.spanLimitReached) {
                                try {
                                    fs.writeFileSync('./output.json', request.body);
                                    console.log('content written succesfully')
                                    // file written successfully
                                  } catch (err) {
                                    console.error(err);
                                  }
                                return sendEventPayload(
                                    options.url, 
                                    getRequestOptions(request.body, options.headers)
                                ) as PromiseLike<TransportMakeRequestResponse>;
                            } else {
                                console.log("span limit reached");
                                try {
                                    let traces : NormalizedTraces = {
                                        currentTrace: '',
                                        newTrace: ''
                                    };
                                    if (jsonResponse.numOfSpansExceeded > 0) {
                                        traces = correctSpansForTrace(
                                            request.body,
                                            traceSpans,
                                            jsonResponse.numOfSpansExceeded
                                        );
                                        //console.log(traces);

                                        sendEventPayload(
                                            options.url,
                                            getRequestOptions(traces.currentTrace, options.headers)
                                        )
                                    }

                                    let trace_id = null;
                                    let parent_span_id = null;
                                    startNewTrace(() => {
                                        trace_id = getCurrentScope().getPropagationContext().traceId;
                                        parent_span_id = getCurrentScope().getPropagationContext().spanId;
                                    })
                                    console.log("new trace id: ", trace_id)

                                    if (!trace_id || !parent_span_id) {
                                        throw new Error("Trace ID or Parent Span ID is missing");
                                    }

                                    const body = replaceTraceID(
                                        traces.newTrace,
                                        trace_id,
                                        parent_span_id
                                    )

                                    console.log("sending body: ")
                                    try {
                                        fs.writeFileSync('./output.json', body);
                                        console.log('content written succesfully')
                                        // file written successfully
                                      } catch (err) {
                                        console.error(err);
                                      }
                                    return sendEventPayload(
                                        options.url,
                                        getRequestOptions(body, options.headers)
                                    ) as PromiseLike<TransportMakeRequestResponse>;                                ;
                                } catch (error) {
                                    console.error(error);
                                }
                            }
                        })
                    //})
                }) as PromiseLike<TransportMakeRequestResponse>;
            } catch (error) {
                console.error(error);
                return rejectedSyncPromise(error) as PromiseLike<TransportMakeRequestResponse>;
            }
        }

        return createTransport(options, makeRequest);
    }
} 